#!/usr/bin/env bash
# CodeWhale GUI 一键安装。装:codewhale CLI + GUI 前端 + 开机自启 + Dock 图标。
# 用法:解压后,双击 install.command,或终端里 bash install.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
UID_N="$(id -u)"
INSTALL_TEST="${CODEWHALE_INSTALL_TEST:-0}"
SKIP_NETWORK="${CODEWHALE_SKIP_NETWORK:-0}"
REQUIRED_CLI_VERSION="${CODEWHALE_CLI_VERSION:-0.9.0}"
echo "════════ CodeWhale GUI 安装 ════════"
echo "用户: ${USER:-$(id -un)}    家目录: $HOME"
echo

# ── 1. 前置检查 ──
miss=0
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 还没装 Node.js（CodeWhale 需要它来跑）。装法二选一:"
  if command -v brew >/dev/null 2>&1; then
    echo "    · 你已有 Homebrew → 终端运行:  brew install node"
  fi
  echo "    · 或去 https://nodejs.org/ 下载 LTS 版,双击装好(一路点继续)。"
  miss=1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "✗ 还没装 Python 3（新版 macOS 可能没有预装）。装法二选一:"
  if command -v brew >/dev/null 2>&1; then
    echo "    · 你已有 Homebrew → 终端运行:  brew install python"
  fi
  echo "    · 或去 https://www.python.org/downloads/macos/ 下载 Universal2 安装包。"
  miss=1
fi
[ "$miss" = 1 ] && { echo; echo "把上面缺的装好,再双击 install.command 重跑一次就行。"; exit 1; }
# CodeWhale 现在是原生 app(WKWebView),不需要 Chrome。联网工具的 playwright 会自带 Chromium。

# ── 2. codewhale CLI(固定兼容版本,装在用户目录,不需要 sudo)──
PY="$(command -v python3)"
NODE="$(command -v node)"
NODEDIR="$(dirname "$NODE")"
CLI_PREFIX="$HOME/.codewhale-gui/npm"
CLI_LOCAL="$CLI_PREFIX/node_modules/.bin/codewhale"
CW="${CODEWHALE_CLI:-}"

cli_version() {
  "$1" --version 2>/dev/null | sed -nE 's/^codewhale ([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -1
}

if [ -n "$CW" ]; then
  [ -x "$CW" ] || { echo "✗ CODEWHALE_CLI 不可执行:$CW"; exit 1; }
elif command -v codewhale >/dev/null 2>&1 && [ "$(cli_version "$(command -v codewhale)")" = "$REQUIRED_CLI_VERSION" ]; then
  CW="$(command -v codewhale)"
  echo "→ 检测到兼容的 CodeWhale CLI v$REQUIRED_CLI_VERSION"
elif [ -x "$CLI_LOCAL" ] && [ "$(cli_version "$CLI_LOCAL")" = "$REQUIRED_CLI_VERSION" ]; then
  CW="$CLI_LOCAL"
  echo "→ 检测到用户目录里的 CodeWhale CLI v$REQUIRED_CLI_VERSION"
else
  [ "$SKIP_NETWORK" != "1" ] || {
    echo "✗ 测试/离线安装未提供兼容的 CODEWHALE_CLI"
    exit 1
  }
  echo "→ 安装 CodeWhale CLI v$REQUIRED_CLI_VERSION 到用户目录(不需要管理员密码)…"
  mkdir -p "$CLI_PREFIX"
  npm install --prefix "$CLI_PREFIX" "codewhale@$REQUIRED_CLI_VERSION" || {
    echo "✗ CodeWhale CLI 下载失败。请确认网络可访问 registry.npmjs.org,然后重新双击 install.command。"
    exit 1
  }
  CW="$CLI_LOCAL"
fi
[ "$(cli_version "$CW")" = "$REQUIRED_CLI_VERSION" ] || {
  echo "✗ CodeWhale CLI 版本不兼容:需要 $REQUIRED_CLI_VERSION,当前 $("$CW" --version 2>/dev/null || echo 未知)"
  exit 1
}
echo "  codewhale=$CW"

# ── 3. 默认配置(免 key 一键安装;模型与 API key 在 app 里「🧠 模型」配置)──
mkdir -p "$HOME/.codewhale"
if [ ! -f "$HOME/.codewhale/config.toml" ]; then
  cat > "$HOME/.codewhale/config.toml" <<'CFG'
default_text_model = "deepseek-v4-pro"
provider = "deepseek"
auth_mode = "api_key"

[providers.deepseek]

[memory]
enabled = true
CFG
  chmod 600 "$HOME/.codewhale/config.toml"
  echo "→ 已写默认配置(免 key)。装好打开后,在左下「🧠 模型」选服务商 + 填 API key 即可开始用。"
else
  echo "→ 检测到已有配置,保留不动。"
fi
echo "  ✓ key 仅存本机 ~/.codewhale/config.toml,不外传"

# ── 4. GUI 文件 ──
echo "→ 部署 GUI 到 ~/codewhale-gui…"
mkdir -p "$HOME/codewhale-gui"
rm -rf "$HOME/codewhale-gui/web"
cp -R "$HERE/web" "$HOME/codewhale-gui/"
cp "$HERE/server.py" "$HOME/codewhale-gui/server.py"
cp "$HERE/VERSION" "$HOME/codewhale-gui/VERSION" 2>/dev/null || echo "0.0.0" > "$HOME/codewhale-gui/VERSION"   # 当前 GUI 版本(在线更新比对用)
if [ -d "$HERE/harness" ]; then
  rm -rf "$HOME/codewhale-gui/harness"
  cp -R "$HERE/harness" "$HOME/codewhale-gui/harness"
  chmod +x "$HOME/codewhale-gui/harness/install_harnesses.sh" 2>/dev/null || true
  echo "  + 已部署研究 harness 脚本(密钥仍只从 ~/agent-harnesses/harness.env 读取)"
fi
# 完整安装包可携带 Claude 订阅桥接运行时。只安装与本机架构匹配的二进制,
# 避免把 arm64 构建放到 Intel Mac 后造成 provider 反复启动失败。
RUNTIME_BIN="$HOME/.codewhale-gui/bin"
MACHINE="$(uname -m)"
[ "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" = "1" ] && MACHINE="arm64"
installed_runtime=0
for name in codewhale-claude codewhale-tui; do
  src="$HERE/bin/$name"
  [ -f "$src" ] || continue
  archs="$(lipo -archs "$src" 2>/dev/null || true)"
  if [ -n "$archs" ] && [[ " $archs " != *" $MACHINE "* ]]; then
    echo "  ⚠ 跳过 $name:安装包架构为 $archs,本机为 $MACHINE"
    continue
  fi
  mkdir -p "$RUNTIME_BIN"
  cp "$src" "$RUNTIME_BIN/$name"
  chmod 755 "$RUNTIME_BIN/$name"
  installed_runtime=1
done
[ "$installed_runtime" = "0" ] || echo "  + 已安装 Claude 订阅桥接运行时($MACHINE)"

# ── 5. GUI token(本机生成,LAN 防护)──
mkdir -p "$HOME/.codewhale-gui"
[ -s "$HOME/.codewhale-gui/token" ] || "$PY" -c "import secrets;open('$HOME/.codewhale-gui/token','w').write(secrets.token_urlsafe(24))"
chmod 600 "$HOME/.codewhale-gui/token"
# 在线更新配置(默认关;发布者改 repo 为自己 GitHub 仓 + enabled:true 即开)。公钥已内嵌 server.py 验签。
[ -f "$HOME/.codewhale-gui/update.json" ] || cp "$HERE/update.json" "$HOME/.codewhale-gui/update.json" 2>/dev/null || true
# 更新验签需要 cryptography(失败也不阻断安装,只是自动更新会暂时禁用)
if [ "$SKIP_NETWORK" != "1" ]; then
  "$PY" -m pip install --user cryptography >/dev/null 2>&1 || "$PY" -m pip install --break-system-packages cryptography >/dev/null 2>&1 || echo "  (cryptography 没装上:在线更新会暂时禁用,不影响其他功能)"
fi

# ── 5.5 联网工具(MCP: fetch 读网页 + playwright 浏览器)──
echo "→ 配置联网工具(MCP)… 这步会下载组件(含浏览器 ~150MB),可能几分钟,请耐心"
if ! command -v uvx >/dev/null 2>&1 && [ "$SKIP_NETWORK" != "1" ]; then
  echo "  安装 uv(给 fetch 用)…"
  # 优先用有完整性保障的包管理器;curl|sh 只作最后兜底(供应链/中间人风险最高)
  if command -v brew >/dev/null 2>&1; then
    brew install uv >/dev/null 2>&1 || true
  elif command -v pip3 >/dev/null 2>&1; then
    pip3 install --user uv >/dev/null 2>&1 || true
  fi
  if ! command -v uv >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/uv" ]; then
    echo "  (brew/pip 都没装上 uv,回退官方安装脚本)"
    curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1 || echo "  ⚠ uv 装失败,fetch 可能不可用(playwright 不受影响)"
  fi
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
fi
UVX="$(command -v uvx || echo "$HOME/.local/bin/uvx")"
NPX2="$(command -v npx)"
# Playwright 自愈启动器:每次启动先杀残留 mcp-chrome + 清过期锁,避免 "Browser is already in use" 卡死
PWLAUNCH="$HOME/codewhale-gui/playwright-mcp-launch.sh"
cat > "$PWLAUNCH" <<'PWL'
#!/usr/bin/env bash
# 清掉上次会话残留、死攥 profile 锁的 mcp-chrome + 过期 SingletonLock,再 exec 真正的 @playwright/mcp。
# pkill 只匹配 playwright 自己的 profile 目录,绝不碰用户主 Chrome。
pkill -f "ms-playwright-mcp/mcp-chrome" 2>/dev/null || true
sleep 0.5
rm -f "$HOME/Library/Caches/ms-playwright-mcp/"*/Singleton* 2>/dev/null || true
NPX="${CW_NPX:-npx}"
command -v "$NPX" >/dev/null 2>&1 || NPX="$(command -v npx || echo npx)"
exec "$NPX" -y @playwright/mcp@latest "$@"
PWL
chmod +x "$PWLAUNCH"
# 只补齐 CodeWhale 自带 MCP,绝不覆盖用户已经配置的 Twitter/Tavily/插件。
"$PY" - "$HOME/.codewhale/mcp.json" "$UVX" "$PWLAUNCH" "$NPX2" <<'PY'
import json
import os
import shutil
import sys
import time

path, uvx, launcher, npx = sys.argv[1:]
data = {}
if os.path.exists(path):
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        backup = f"{path}.invalid.{int(time.time())}"
        shutil.copy2(path, backup)
        print(f"  ⚠ 原 MCP 配置不是有效 JSON,已备份到 {backup}")
if not isinstance(data, dict):
    data = {}
timeouts = data.setdefault("timeouts", {})
for name, value in (("connect_timeout", 60), ("execute_timeout", 120), ("read_timeout", 180)):
    timeouts.setdefault(name, value)
servers = data.setdefault("servers", {})
servers.setdefault("fetch", {
    "command": uvx, "args": ["mcp-server-fetch"], "env": {}, "url": None,
    "connect_timeout": None, "execute_timeout": None, "read_timeout": None,
    "disabled": False, "enabled": True, "required": False,
    "enabled_tools": [], "disabled_tools": [],
})
servers.setdefault("playwright", {
    "command": launcher, "args": [], "env": {"CW_NPX": npx}, "url": None,
    "connect_timeout": None, "execute_timeout": None, "read_timeout": None,
    "disabled": False, "enabled": True, "required": False,
    "enabled_tools": [], "disabled_tools": [],
})
os.makedirs(os.path.dirname(path), exist_ok=True)
temp = f"{path}.tmp"
with open(temp, "w", encoding="utf-8") as handle:
    json.dump(data, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
os.chmod(temp, 0o600)
os.replace(temp, path)
PY
chmod 600 "$HOME/.codewhale/mcp.json"
if [ "$SKIP_NETWORK" != "1" ]; then
  echo "  下载 fetch 组件…"; "$UVX" mcp-server-fetch --help >/dev/null 2>&1 || echo "  ⚠ fetch 预热失败,首次使用时会重试"
  echo "  下载 playwright…"; "$NPX2" -y @playwright/mcp@latest --help >/dev/null 2>&1 || echo "  ⚠ playwright 预热失败,首次使用时会重试"
  echo "  下载 Chromium 浏览器(最久)…"; "$NPX2" -y playwright install chromium >/dev/null 2>&1 || echo "  ⚠ Chromium 没下完,首次用浏览器时会自动补"
fi
echo "  ✓ 联网工具就绪"

# ── 6. 开机自启(launchd,路径参数化)──
echo "→ 配置开机自启…"
LA="$HOME/Library/LaunchAgents"; mkdir -p "$LA"
PLPATH="$NODEDIR:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cat > "$LA/com.codewhale.appserver.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.codewhale.appserver</string>
  <key>ProgramArguments</key><array>
    <string>$CW</string><string>app-server</string><string>--http</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>7878</string><string>--insecure-no-auth</string>
  </array>
  <key>WorkingDirectory</key><string>$HOME</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PLPATH</string><key>NO_COLOR</key><string>1</string><key>TERM</key><string>dumb</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>$HOME/codewhale-gui/app-server.err.log</string>
</dict></plist>
PLIST
cat > "$LA/com.codewhale.frontend.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.codewhale.frontend</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>$HOME/codewhale-gui/server.py</string></array>
  <key>WorkingDirectory</key><string>$HOME/codewhale-gui</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PLPATH</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>AbandonProcessGroup</key><true/><key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/codewhale-gui/webserver.log</string>
  <key>StandardErrorPath</key><string>$HOME/codewhale-gui/webserver.log</string>
</dict></plist>
PLIST
if [ "$INSTALL_TEST" != "1" ]; then
  launchctl bootout "gui/$UID_N/com.codewhale.appserver" 2>/dev/null || true
  launchctl bootout "gui/$UID_N/com.codewhale.frontend"  2>/dev/null || true
  rm -f "$HOME/codewhale-gui/app-server.log"
  : > "$HOME/codewhale-gui/app-server.err.log"
  launchctl bootstrap "gui/$UID_N" "$LA/com.codewhale.appserver.plist" 2>/dev/null || launchctl load -w "$LA/com.codewhale.appserver.plist"
  launchctl bootstrap "gui/$UID_N" "$LA/com.codewhale.frontend.plist" 2>/dev/null || launchctl load -w "$LA/com.codewhale.frontend.plist"
else
  plutil -lint "$LA/com.codewhale.appserver.plist" "$LA/com.codewhale.frontend.plist" >/dev/null
  echo "  ✓ 隔离安装测试:launchd 配置有效(未注册服务)"
fi

# ── 7. CodeWhale.app(原生 Swift / WKWebView,预编译通用二进制 arm64+Intel,零 Chrome 依赖)──
echo "→ 安装原生 CodeWhale.app(无需 Chrome)…"
APP="$HOME/Applications/CodeWhale.app"
mkdir -p "$HOME/Applications"
rm -rf "$APP"
cp -R "$HERE/CodeWhale.app" "$APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true            # 去隔离,免 Gatekeeper "身份不明开发者" 拦
codesign -s - --force --deep "$APP" >/dev/null 2>&1 || true           # 复制后重新 ad-hoc 签名,确保可运行(arm64 必须有签名)
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null || true
echo "  ✓ 原生 app 已装(WKWebView 窗口,arm64+Intel 通用,不依赖 Chrome)"

# ── 8. 等后端就绪 + 打开 ──
echo "→ 启动后端…"
if [ "$INSTALL_TEST" != "1" ]; then
  ready=0
  for _ in $(seq 1 40); do
    if curl -fsS -m2 http://127.0.0.1:7878/health >/dev/null 2>&1; then ready=1; break; fi
    sleep 0.5
  done
  [ "$ready" = "1" ] || {
    echo "✗ CodeWhale 后端未能启动。日志:$HOME/codewhale-gui/app-server.err.log"
    exit 1
  }
fi
echo
echo "✅ 安装完成!正在打开 CodeWhale…"
echo "   • 以后从 启动台/Spotlight 搜 “CodeWhale” 打开(白鲸图标),已设开机自启"
echo "   • 若首次打开弹「身份不明的开发者」→ 右键点 CodeWhale → 「打开」→ 再点「打开」,只需这一次"
echo "   • 想换模型:app 左下角「🧠 模型」随时切"
if [ "$INSTALL_TEST" != "1" ]; then
  open "$APP" 2>/dev/null || true
else
  echo "   • 隔离安装测试完成,未启动或注册任何后台服务"
fi
