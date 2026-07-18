#!/usr/bin/env bash
# Build and sign the CodeWhale GUI online-update assets.
# Usage: ./make-release.sh <version> [release notes]
set -euo pipefail

VERSION="${1:?Usage: ./make-release.sh <version> [release notes]}"
NOTES="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${CODEWHALE_SOURCE_DIR:-$HERE}"
OUT="${CODEWHALE_RELEASE_OUT:-$HERE/dist/$VERSION}"
KEY="${CODEWHALE_SIGNING_KEY:-$HOME/.codewhale-release/signing-key.pem}"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Error: invalid version: $VERSION" >&2
  exit 1
fi
if [ ! -f "$KEY" ] && [ -f "$HOME/Desktop/work/signing-key.pem" ]; then
  KEY="$HOME/Desktop/work/signing-key.pem"
elif [ ! -f "$KEY" ] && [ -f "$HOME/codewhale-release/signing-key.pem" ]; then
  KEY="$HOME/codewhale-release/signing-key.pem"
fi
[ -f "$KEY" ] || { echo "Error: signing key not found. Set CODEWHALE_SIGNING_KEY." >&2; exit 1; }
for path in "$SRC/web" "$SRC/server.py" "$SRC/VERSION" "$SRC/harness"; do
  [ -e "$path" ] || { echo "Error: missing release input: $path" >&2; exit 1; }
done

mkdir -p "$OUT"
rm -f "$OUT"/gui-*.tar.gz "$OUT"/harness-*.tar.gz \
  "$OUT/manifest.json" "$OUT/manifest.json.sig" \
  "$OUT/codewhale-claude" "$OUT/codewhale-tui" "$OUT/CodeWhale.app.tar.gz"
printf '%s\n' "$VERSION" > "$SRC/VERSION"
printf '%s\n' "$VERSION" > "$SRC/harness/VERSION"

GUI_BUNDLE="gui-$VERSION.tar.gz"
HARNESS_BUNDLE="harness-$VERSION.tar.gz"

echo "-> Building $GUI_BUNDLE"
(
  cd "$SRC"
  COPYFILE_DISABLE=1 tar --exclude='.DS_Store' --exclude='*.bak*' \
    --exclude='__pycache__' --exclude='*.pyc' \
    -czf "$OUT/$GUI_BUNDLE" web server.py VERSION
)

echo "-> Building $HARNESS_BUNDLE"
(
  cd "$SRC"
  COPYFILE_DISABLE=1 tar --exclude='.DS_Store' --exclude='__pycache__' \
    --exclude='*.pyc' --exclude='harness.env' --exclude='skills-custom' \
    -czf "$OUT/$HARNESS_BUNDLE" harness
)

# Optional patched Claude subscription runtime. The signed manifest records
# every copied binary, so clients reject a tampered release asset.
BIN_DIR="${CODEWHALE_PATCHED_BIN_DIR:-$HOME/.codewhale-gui/bin}"
for name in codewhale-claude codewhale-tui; do
  if [ -f "$BIN_DIR/$name" ]; then
    cp "$BIN_DIR/$name" "$OUT/$name"
  else
    echo "Warning: missing optional patched binary: $BIN_DIR/$name" >&2
  fi
done

# Native shell is an independently verified release asset. Build it when the
# source is available; online updates remain valid when it is omitted.
if [ -x "$SRC/native/build.sh" ]; then
  APP_DIR="$OUT/CodeWhale.app"
  rm -rf "$APP_DIR"
  if "$SRC/native/build.sh" "$APP_DIR" >/dev/null; then
    (
      cd "$OUT"
      COPYFILE_DISABLE=1 tar --exclude='.DS_Store' -czf CodeWhale.app.tar.gz CodeWhale.app
    )
    rm -rf "$APP_DIR"
  else
    echo "Warning: native app build failed; continuing without native asset" >&2
  fi
fi

python3 - "$VERSION" "$NOTES" "$OUT/$GUI_BUNDLE" "$GUI_BUNDLE" \
  "$OUT/$HARNESS_BUNDLE" "$HARNESS_BUNDLE" "$KEY" "$OUT" <<'PY'
import base64
import hashlib
import json
import os
import subprocess
import sys

from cryptography.hazmat.primitives import serialization

version, notes, gui_path, gui_name, harness_path, harness_name, key_path, out = sys.argv[1:]

def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()

def asset(path, name, **extra):
    value = {"name": name, "sha256": sha256(path), "size": os.path.getsize(path)}
    value.update(extra)
    return value

manifest = {
    "version": version,
    "notes": notes,
    "bundle": gui_name,
    "sha256": sha256(gui_path),
    "size": os.path.getsize(gui_path),
    "harness": asset(harness_path, harness_name, version=version),
}

binaries = []
for name in ("codewhale-claude", "codewhale-tui"):
    path = os.path.join(out, name)
    if not os.path.exists(path):
        continue
    try:
        arch = subprocess.run(
            ["lipo", "-archs", path], capture_output=True, text=True, check=False
        ).stdout.strip() or "arm64"
    except Exception:
        arch = "arm64"
    binaries.append(asset(path, name, arch=arch))
if binaries:
    manifest["binaries"] = binaries

native_path = os.path.join(out, "CodeWhale.app.tar.gz")
if os.path.exists(native_path):
    manifest["native_app"] = asset(native_path, "CodeWhale.app.tar.gz")

manifest_bytes = json.dumps(
    manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")
).encode("utf-8")
private_key = serialization.load_pem_private_key(open(key_path, "rb").read(), password=None)
signature = private_key.sign(manifest_bytes)
private_key.public_key().verify(signature, manifest_bytes)

open(os.path.join(out, "manifest.json"), "wb").write(manifest_bytes)
open(os.path.join(out, "manifest.json.sig"), "w", encoding="ascii").write(
    base64.b64encode(signature).decode("ascii")
)

print(f"   GUI SHA-256: {manifest['sha256']}")
print(f"   Harness SHA-256: {manifest['harness']['sha256']}")
print("   Ed25519 signature: verified")
PY

echo "Release assets written to $OUT"
find "$OUT" -maxdepth 1 -type f -print | sort
