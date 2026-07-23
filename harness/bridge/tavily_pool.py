#!/usr/bin/env python3
"""Shared Tavily credential selection and retry helpers."""

from __future__ import annotations

import hashlib
import json
import os
import ssl
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

try:
    import certifi
except Exception:
    certifi = None


CREDENTIALS_FILE = Path(
    os.environ.get(
        "TAVILY_CREDENTIALS_FILE",
        "~/.config/tavily/credentials.json",
    )
).expanduser()
STATE_FILE = Path(
    os.environ.get(
        "TAVILY_POOL_STATE_FILE",
        "~/.local/state/tavily/pool.json",
    )
).expanduser()
RETRYABLE = {401, 402, 403, 429, 500, 502, 503, 504}
COOLDOWN_SECONDS = {
    401: 24 * 60 * 60,
    402: 24 * 60 * 60,
    403: 24 * 60 * 60,
    429: 15 * 60,
}


def _fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


def _read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return fallback


def _write_state(state: dict[str, Any]) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    temp = STATE_FILE.with_suffix(".tmp")
    temp.write_text(
        json.dumps(state, ensure_ascii=True, indent=2) + "\n",
        encoding="utf-8",
    )
    os.chmod(temp, 0o600)
    temp.replace(STATE_FILE)
    os.chmod(STATE_FILE, 0o600)


def tavily_keys(fallback: str = "") -> list[str]:
    data = _read_json(CREDENTIALS_FILE, {})
    raw = data.get("keys", []) if isinstance(data, dict) else []
    keys: list[str] = []
    for item in raw:
        key = str(item).strip()
        if key and key not in keys:
            keys.append(key)
    fallback = (fallback or "").strip()
    if fallback and fallback not in keys:
        keys.append(fallback)
    return keys


def _candidates(keys: list[str], state: dict[str, Any]) -> list[int]:
    start = int(state.get("cursor", 0)) % len(keys)
    ordered = [(start + offset) % len(keys) for offset in range(len(keys))]
    cooldowns = state.get("cooldowns", {})
    now = time.time()
    return [
        index
        for index in ordered
        if float(cooldowns.get(_fingerprint(keys[index]), 0)) <= now
    ]


def select_tavily_key(fallback: str = "") -> str:
    """Select the next healthy slot without exposing its value."""
    keys = tavily_keys(fallback)
    if not keys:
        return ""
    state = _read_json(STATE_FILE, {"cursor": 0, "cooldowns": {}})
    if not isinstance(state, dict):
        state = {"cursor": 0, "cooldowns": {}}
    candidates = _candidates(keys, state)
    if not candidates:
        return ""
    index = candidates[0]
    state["cursor"] = (index + 1) % len(keys)
    _write_state(state)
    return keys[index]


def preferred_tavily_key(fallback: str = "") -> str:
    """Return a stable healthy slot for services that cannot rotate per call."""
    keys = tavily_keys(fallback)
    if not keys:
        return ""
    state = _read_json(STATE_FILE, {"cursor": 0, "cooldowns": {}})
    if not isinstance(state, dict):
        state = {"cursor": 0, "cooldowns": {}}
    cooldowns = state.get("cooldowns", {})
    now = time.time()
    for key in keys:
        if float(cooldowns.get(_fingerprint(key), 0)) <= now:
            return key
    return ""


def tavily_search_json(
    payload: dict[str, Any],
    fallback: str = "",
    timeout: int = 45,
) -> dict[str, Any]:
    """Call Tavily search and rotate on auth, quota, or rate-limit errors."""
    keys = tavily_keys(fallback)
    if not keys:
        raise RuntimeError("Tavily credential pool is empty.")
    state = _read_json(STATE_FILE, {"cursor": 0, "cooldowns": {}})
    if not isinstance(state, dict):
        state = {"cursor": 0, "cooldowns": {}}
    state.setdefault("cooldowns", {})
    candidates = _candidates(keys, state)
    if not candidates:
        raise RuntimeError("All Tavily credential slots are cooling down.")

    last_error = "request failed"
    for index in candidates:
        key = keys[index]
        body = dict(payload)
        body["api_key"] = key
        request = urllib.request.Request(
            "https://api.tavily.com/search",
            data=json.dumps(body).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "User-Agent": "CodeWhale-Harness/1.0",
            },
        )
        try:
            kwargs: dict[str, Any] = {"timeout": timeout}
            if certifi:
                kwargs["context"] = ssl.create_default_context(
                    cafile=certifi.where()
                )
            with urllib.request.urlopen(request, **kwargs) as response:
                data = json.loads(
                    response.read().decode("utf-8", "replace")
                )
            state["cursor"] = (index + 1) % len(keys)
            state["cooldowns"].pop(_fingerprint(key), None)
            state["last_success_slot"] = index + 1
            state["last_success_at"] = int(time.time())
            _write_state(state)
            return data
        except urllib.error.HTTPError as exc:
            last_error = f"HTTP {exc.code}"
            if exc.code not in RETRYABLE:
                raise RuntimeError(last_error) from exc
            state["cooldowns"][_fingerprint(key)] = (
                time.time() + COOLDOWN_SECONDS.get(exc.code, 60)
            )
        except Exception as exc:
            last_error = type(exc).__name__
            state["cooldowns"][_fingerprint(key)] = time.time() + 30

    _write_state(state)
    raise RuntimeError(
        f"Tavily search failed across {len(candidates)} slots: {last_error}"
    )
