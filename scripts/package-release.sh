#!/usr/bin/env bash
# Build a complete, self-contained macOS release. It never reads user keys,
# chats, OAuth credentials, or local configuration into the distributable.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(tr -d '\r\n' < "$ROOT/VERSION")"
OUT="${1:-$ROOT/dist/release-$VERSION}"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/codewhale-release.XXXXXX")"

require() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }; }
for cmd in tar shasum python3 swiftc lipo codesign; do require "$cmd"; done

for required in server.py VERSION web/index.html web/js/combo.js web/js/voice.js harness/install_harnesses.sh installer/install.sh native/build.sh; do
  [ -e "$ROOT/$required" ] || { echo "Missing release file: $required" >&2; exit 1; }
done

mkdir -p "$OUT"
APP_STAGE="$STAGE/CodeWhale.app"
"$ROOT/native/build.sh" "$APP_STAGE"

GUI_STAGE="$STAGE/gui"
mkdir -p "$GUI_STAGE"
cp "$ROOT/server.py" "$ROOT/VERSION" "$GUI_STAGE/"
cp -R "$ROOT/web" "$GUI_STAGE/web"
(cd "$GUI_STAGE" && tar -czf "$OUT/gui-$VERSION.tar.gz" server.py VERSION web)

HARNESS_STAGE="$STAGE/harness-payload"
mkdir -p "$HARNESS_STAGE"
cp -R "$ROOT/harness" "$HARNESS_STAGE/harness"
(cd "$HARNESS_STAGE" && tar -czf "$OUT/harness-$VERSION.tar.gz" harness)

(cd "$STAGE" && tar -czf "$OUT/CodeWhale.app.tar.gz" CodeWhale.app)

INSTALL_STAGE="$STAGE/codewhale-installer"
mkdir -p "$INSTALL_STAGE"
cp "$ROOT/server.py" "$ROOT/VERSION" "$ROOT/installer/install.sh" "$ROOT/installer/install.command" "$ROOT/installer/README.txt" "$ROOT/installer/update.json" "$INSTALL_STAGE/"
cp -R "$ROOT/web" "$ROOT/harness" "$APP_STAGE" "$INSTALL_STAGE/"
(cd "$STAGE" && tar -czf "$OUT/codewhale-installer-$VERSION.tar.gz" codewhale-installer)
cp "$OUT/codewhale-installer-$VERSION.tar.gz" "$OUT/codewhale-installer.tar.gz"

python3 "$ROOT/scripts/sign-manifest.py" --release-dir "$OUT" --version "$VERSION" --notes "CodeWhale GUI v$VERSION 完整发布：组合调度、语音输入、附件、Harness 与新机器安装链路。"
(cd "$OUT" && shasum -a 256 CodeWhale.app.tar.gz "gui-$VERSION.tar.gz" "harness-$VERSION.tar.gz" "codewhale-installer-$VERSION.tar.gz" codewhale-installer.tar.gz manifest.json manifest.json.sig > SHA256SUMS)

echo "Release package ready: $OUT"
find "$OUT" -maxdepth 1 -type f -exec basename {} \; | sort
