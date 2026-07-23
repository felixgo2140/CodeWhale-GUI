#!/usr/bin/env bash
# Verify a complete installer as a first-time user in an isolated HOME.
# Usage: ./verify-release.sh path/to/codewhale-installer.tar.gz
set -euo pipefail

ARCHIVE="${1:?Usage: ./verify-release.sh path/to/codewhale-installer.tar.gz}"
[ -f "$ARCHIVE" ] || { echo "Error: installer archive not found: $ARCHIVE" >&2; exit 1; }

TMP="$(mktemp -d)"
cleanup() {
  if [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

tar -xzf "$ARCHIVE" -C "$TMP"
STAGE="$TMP/codewhale-installer"
TEST_HOME="$TMP/home"
for path in install.sh install.command README.txt update.json VERSION server.py web harness CodeWhale.app; do
  [ -e "$STAGE/$path" ] || { echo "Error: installer payload is missing $path" >&2; exit 1; }
done

CLI="$(command -v codewhale || true)"
[ -x "$CLI" ] || { echo "Error: release verification needs a local CodeWhale CLI" >&2; exit 1; }
[ "$("$CLI" --version 2>/dev/null | sed -nE 's/^codewhale ([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -1)" = "0.9.0" ] || {
  echo "Error: release verification requires CodeWhale CLI 0.9.0" >&2
  exit 1
}

mkdir -p "$TEST_HOME/.codewhale"
cat > "$TEST_HOME/.codewhale/config.toml" <<'CFG'
sentinel = "preserve-existing-config"
CFG
cat > "$TEST_HOME/.codewhale/mcp.json" <<'JSON'
{
  "servers": {
    "custom-existing-server": {
      "command": "/usr/bin/true",
      "args": [],
      "enabled": true
    }
  }
}
JSON
chmod 600 "$TEST_HOME/.codewhale/config.toml" "$TEST_HOME/.codewhale/mcp.json"

echo "-> Running isolated first-install verification"
env \
  HOME="$TEST_HOME" \
  USER="codewhale-release-test" \
  CODEWHALE_INSTALL_TEST=1 \
  CODEWHALE_SKIP_NETWORK=1 \
  CODEWHALE_CLI="$CLI" \
  bash "$STAGE/install.sh" >"$TMP/install.log" 2>&1 || {
    cat "$TMP/install.log" >&2
    exit 1
  }

grep -q 'preserve-existing-config' "$TEST_HOME/.codewhale/config.toml"
python3 - "$TEST_HOME/.codewhale/mcp.json" <<'PY'
import json
import os
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    data = json.load(handle)
servers = data.get("servers", {})
missing = {"custom-existing-server", "fetch", "playwright"} - set(servers)
if missing:
    raise SystemExit(f"MCP merge lost entries: {sorted(missing)}")
if (os.stat(path).st_mode & 0o777) != 0o600:
    raise SystemExit("MCP config permissions are not 0600")
PY

test -s "$TEST_HOME/.codewhale-gui/token"
[ "$(stat -f '%Lp' "$TEST_HOME/.codewhale-gui/token")" = "600" ]
test -f "$TEST_HOME/codewhale-gui/server.py"
test -f "$TEST_HOME/codewhale-gui/web/index.html"
test -f "$TEST_HOME/codewhale-gui/harness/bridge/common_llm.py"
test -x "$TEST_HOME/Applications/CodeWhale.app/Contents/MacOS/CodeWhale"
plutil -lint \
  "$TEST_HOME/Library/LaunchAgents/com.codewhale.appserver.plist" \
  "$TEST_HOME/Library/LaunchAgents/com.codewhale.frontend.plist" \
  "$TEST_HOME/Applications/CodeWhale.app/Contents/Info.plist" >/dev/null
codesign --verify --deep --strict "$TEST_HOME/Applications/CodeWhale.app"
ARCHS="$(lipo -archs "$TEST_HOME/Applications/CodeWhale.app/Contents/MacOS/CodeWhale")"
[[ " $ARCHS " == *" arm64 "* && " $ARCHS " == *" x86_64 "* ]] || {
  echo "Error: native app is not universal: $ARCHS" >&2
  exit 1
}

if rg -q '/Users/(macpro|test)|tvly-[A-Za-z0-9_-]{12,}|BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY' "$STAGE"; then
  echo "Error: installer contains a developer path or secret-like value" >&2
  exit 1
fi

PORT="$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
HOME="$TEST_HOME" CODEWHALE_RELEASE_VERIFY=1 CW_BIND=127.0.0.1 CW_PORT="$PORT" \
  python3 "$TEST_HOME/codewhale-gui/server.py" >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
ready=0
for _ in $(seq 1 50); do
  if curl -fsS -m1 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.1
done
[ "$ready" = "1" ] || {
  cat "$TMP/server.log" >&2
  echo "Error: isolated GUI server did not become ready" >&2
  exit 1
}

echo "✓ Installer payload, isolated install, config preservation, universal app, signing, and GUI startup verified"
