#!/usr/bin/env python3
"""Create a signed CodeWhale release manifest from already-built assets."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def digest(path: Path) -> tuple[str, int]:
    return hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_size


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release-dir", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--notes", default="")
    parser.add_argument(
        "--key",
        type=Path,
        default=Path.home() / ".codewhale-release" / "manifest-ed25519.pem",
        help="Private release key. Keep it outside the repository.",
    )
    args = parser.parse_args()
    if not args.key.is_file():
        raise SystemExit(f"Missing signing key: {args.key}")

    release = args.release_dir
    gui = release / f"gui-{args.version}.tar.gz"
    harness = release / f"harness-{args.version}.tar.gz"
    app = release / "CodeWhale.app.tar.gz"
    for path in (gui, harness, app):
        if not path.is_file():
            raise SystemExit(f"Missing release asset: {path.name}")

    gui_sha, gui_size = digest(gui)
    harness_sha, harness_size = digest(harness)
    app_sha, app_size = digest(app)
    data = {
        "version": args.version,
        "bundle": gui.name,
        "sha256": gui_sha,
        "size": gui_size,
        "harness": {"name": harness.name, "sha256": harness_sha, "size": harness_size, "version": args.version},
        "native_app": {"name": app.name, "sha256": app_sha, "size": app_size},
        "binaries": [],
        "notes": args.notes,
    }
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
    private = serialization.load_pem_private_key(args.key.read_bytes(), password=None)
    if not isinstance(private, Ed25519PrivateKey):
        raise SystemExit("Signing key is not Ed25519")
    (release / "manifest.json").write_bytes(payload)
    (release / "manifest.json.sig").write_text(base64.b64encode(private.sign(payload)).decode() + "\n")
    os.chmod(release / "manifest.json", 0o644)
    os.chmod(release / "manifest.json.sig", 0o644)


if __name__ == "__main__":
    main()
