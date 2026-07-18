#!/usr/bin/env python3
"""Shared helpers for CodeWhale research harness bridge scripts."""
import json
import os
import re
import ssl
import time
import tomllib
import urllib.error
import urllib.request

try:
    import certifi
except Exception:
    certifi = None

HARNESS_ENV = os.path.expanduser("~/agent-harnesses/harness.env")
CODEWHALE_CFG = os.path.expanduser("~/.codewhale/config.toml")
CODEWHALE_CMP_DIR = os.path.expanduser("~/.codewhale-gui/cmp")


def read_env_file(path=HARNESS_ENV):
    vals = {}
    if not os.path.exists(path):
        return vals
    for ln in open(path, errors="replace"):
        ln = ln.strip()
        if ln and not ln.startswith("#") and "=" in ln:
            k, v = ln.split("=", 1)
            vals[k.strip()] = v.strip().strip('"').strip("'")
    return vals


def looks_placeholder(value):
    v = (value or "").strip().lower()
    return (not v) or "xxxx" in v or v in {"sk-", "your-key", "your_api_key", "changeme"}


def redact(text):
    s = str(text or "")
    s = re.sub(r"\b(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]{8,}([A-Za-z0-9_-]{4})\b", r"\1…\2", s)
    s = re.sub(r"\b(tvly-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]{8,}([A-Za-z0-9_-]{4})\b", r"\1…\2", s)
    return re.sub(r"\b([A-Za-z0-9_-]{8,})\*+([A-Za-z0-9_-]{4})\b", r"\1…\2", s)


def read_toml(path):
    try:
        with open(path, "rb") as f:
            return tomllib.load(f)
    except Exception:
        return {}


def _provider_result(prov, default_base, default_model):
    if not isinstance(prov, dict):
        return None
    key = (prov.get("api_key") or "").strip()
    if not key:
        return None
    return (
        key,
        (prov.get("base_url") or default_base).rstrip("/"),
        prov.get("model") or default_model,
    )


def codewhale_provider_config(name, default_base="", default_model=""):
    cfg = read_toml(CODEWHALE_CFG)

    providers = cfg.get("providers") or {}
    prov = providers.get(name) if isinstance(providers, dict) else {}
    result = _provider_result(prov, default_base, default_model)
    if result:
        return result

    if cfg.get("provider") == name:
        result = _provider_result(cfg, default_base, default_model)
        if result:
            return result

    cmp_cfg = read_toml(os.path.join(CODEWHALE_CMP_DIR, f"{name}.toml"))
    providers = cmp_cfg.get("providers") or {}
    prov = providers.get(name) if isinstance(providers, dict) else {}
    result = _provider_result(prov, default_base, default_model)
    if result:
        return result

    return "", default_base.rstrip("/"), default_model


def model_key(model):
    m = (model or "").lower()
    if m in ("hunyuan", "custom", "hy3-preview"):
        return "hunyuan"
    if m in ("glm", "zai", "zhipu", "glm-5.2", "glm-5.2-air"):
        return "zai"
    if m in ("kimi", "moonshot", "kimi-for-coding", "moonshot-v1-128k"):
        return "kimi"
    if m in ("longcat", "longcat-2.0"):
        return "longcat"
    if m in ("volcengine", "doubao", "doubao-seed-2-1-pro-260628"):
        return "volcengine"
    if m in ("qwen", "qwen-plus", "qwen-max", "dashscope", "tongyi", "qianwen") or "qwen" in m:
        return "qwen"
    return "deepseek"


def openai_spec(model=""):
    vals = read_env_file()
    mk = model_key(model)
    if mk == "hunyuan":
        key, base, mdl = codewhale_provider_config("custom", "https://tokenhub.tencentmaas.com/v1", "hy3-preview")
        key = key or vals.get("HUNYUAN_API_KEY", "")
        return key, base, mdl or "hy3-preview", "混元"
    if mk == "zai":
        key, base, mdl = codewhale_provider_config("zai", "https://api.z.ai/api/paas/v4", "GLM-5.2")
        key = key or vals.get("ZHIPU_API_KEY", "")
        return key, base, mdl or "GLM-5.2", "GLM"
    if mk == "kimi":
        key, base, mdl = codewhale_provider_config("moonshot", "https://api.kimi.com/coding/v1", "kimi-for-coding")
        key = key or vals.get("KIMI_API_KEY", "")
        return key, base, mdl or "kimi-for-coding", "Kimi"
    if mk == "longcat":
        key, base, mdl = codewhale_provider_config("longcat", "https://api.longcat.chat/openai", "LongCat-2.0")
        return key, base, mdl or "LongCat-2.0", "LongCat"
    if mk == "volcengine":
        key, base, mdl = codewhale_provider_config("volcengine", "https://ark.cn-beijing.volces.com/api/v3", "doubao-seed-2-1-pro-260628")
        return key, base, mdl or "doubao-seed-2-1-pro-260628", "火山"
    if mk == "qwen":
        key, base, mdl = codewhale_provider_config("qwen", "https://ws-zazex2z3400vhsxs.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", "qwen3.7-max-2026-06-08")
        key = key or vals.get("DASHSCOPE_API_KEY", "")
        return key, base, mdl or "qwen3.7-max-2026-06-08", "千问"
    key, base, mdl = codewhale_provider_config("deepseek", "https://api.deepseek.com/v1", "deepseek-v4-pro")
    key = key or vals.get("DEEPSEEK_API_KEY", "")
    return key, base or "https://api.deepseek.com/v1", mdl or "deepseek-v4-pro", "DeepSeek"


def _choice_content(choice):
    message = getattr(choice, "message", None)
    if isinstance(message, dict):
        return message.get("content") or ""
    if message is not None:
        return getattr(message, "content", "") or ""
    if isinstance(choice, dict):
        msg = choice.get("message")
        if isinstance(msg, dict):
            return msg.get("content") or ""
        return choice.get("text") or ""
    return getattr(choice, "text", "") or ""


def _choice_finish_reason(choice):
    if isinstance(choice, dict):
        return choice.get("finish_reason") or ""
    return getattr(choice, "finish_reason", "") or ""


def _usage_tokens(resp):
    usage = getattr(resp, "usage", None)
    if isinstance(usage, dict):
        return int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0)
    return int(getattr(usage, "prompt_tokens", 0) or 0), int(getattr(usage, "completion_tokens", 0) or 0)


def _empty_or_tiny(content):
    return len((content or "").strip()) < 16


def chat(messages, model="", temperature=0.2, max_tokens=8000):
    from openai import OpenAI

    key, base, mdl, label = openai_spec(model)
    if looks_placeholder(key):
        raise RuntimeError(f"{label} API key 未配置或还是占位符")
    client = OpenAI(api_key=key, base_url=(base or "").rstrip("/"))
    kwargs = {
        "model": mdl,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    retried = False
    last_reason = ""
    last_content = ""
    total_in = total_out = 0

    for attempt in range(2):
        resp = client.chat.completions.create(**kwargs)
        choices = getattr(resp, "choices", None) or []
        choice = choices[0] if choices else {}
        content = _choice_content(choice)
        reason = _choice_finish_reason(choice)
        in_tok, out_tok = _usage_tokens(resp)
        total_in += in_tok
        total_out += out_tok
        last_content, last_reason = content, reason
        if attempt == 0 and reason == "length" and _empty_or_tiny(content):
            kwargs = {**kwargs, "max_tokens": int(kwargs["max_tokens"]) * 2}
            retried = True
            print(f"[common_llm] empty response with finish_reason=length; retrying once with max_tokens={kwargs['max_tokens']}", flush=True)
            continue
        break

    if not (last_content or "").strip() or (last_reason == "length" and _empty_or_tiny(last_content)):
        retry_note = "重试后仍" if retried else ""
        raise RuntimeError(f"{label} {retry_note}返回空响应或过短响应(finish_reason={last_reason or 'unknown'}, max_tokens={kwargs.get('max_tokens')})")

    return last_content, {
        "label": label,
        "model": mdl,
        "in_tokens": total_in,
        "out_tokens": total_out,
        "retried": retried,
        "finish_reason": last_reason,
        "max_tokens": kwargs.get("max_tokens"),
    }


def tavily_search(query, max_results=5):
    key = os.environ.get("TAVILY_API_KEY") or read_env_file().get("TAVILY_API_KEY", "")
    if looks_placeholder(key):
        return [{"title": "Tavily 未配置", "url": "", "content": "缺 TAVILY_API_KEY,本轮只能做纯 LLM 研究。"}]
    payload = json.dumps({
        "api_key": key,
        "query": query,
        "search_depth": "advanced",
        "max_results": max_results,
        "include_answer": False,
        "include_raw_content": False,
    }).encode()
    req = urllib.request.Request(
        "https://api.tavily.com/search",
        data=payload,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        kwargs = {"timeout": 45}
        if certifi:
            kwargs["context"] = ssl.create_default_context(cafile=certifi.where())
        with urllib.request.urlopen(req, **kwargs) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:300]
        return [{"title": "Tavily 搜索失败", "url": "", "content": f"HTTP {e.code}: {body}"}]
    except Exception as e:
        return [{"title": "Tavily 搜索失败", "url": "", "content": redact(str(e))[:300]}]
    out = []
    for item in (data.get("results") or [])[:max_results]:
        out.append({
            "title": item.get("title") or item.get("url") or "source",
            "url": item.get("url") or "",
            "content": item.get("content") or item.get("raw_content") or "",
        })
    return out


def extract_json_obj(text):
    s = text or ""
    for pat in (r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", r"(\{[\s\S]*\})"):
        m = re.search(pat, s)
        if not m:
            continue
        try:
            return json.loads(m.group(1))
        except Exception:
            pass
    return {}


def write_json(path, data):
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


def now_stamp():
    return time.strftime("%Y%m%d-%H%M%S")
