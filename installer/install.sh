#!/usr/bin/env bash
# CodeWhale GUI 一键安装。装:codewhale CLI + GUI 前端 + DeepSeek key + 开机自启 + Dock 图标。
# 用法:解压后,双击 install.command,或终端里 bash install.sh
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
UID_N="$(id -u)"
echo "════════ CodeWhale GUI 安装 ════════"
echo "用户: $USER    家目录: $HOME"
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
command -v python3 >/dev/null 2>&1 || { echo "✗ 还没装 python3 → 终端运行  xcode-select --install  (弹窗点「安装」,几分钟)。"; miss=1; }
[ "$miss" = 1 ] && { echo; echo "把上面缺的装好,再双击 install.command 重跑一次就行。"; exit 1; }
# CodeWhale 现在是原生 app(WKWebView),不需要 Chrome。联网工具的 playwright 会自带 Chromium。

# ── 2. codewhale CLI ──
if command -v codewhale >/dev/null 2>&1; then
  echo "→ codewhale 已安装"
else
  echo "→ 安装 codewhale CLI(npm,可能要一分钟)…"
  npm install -g codewhale || { echo "✗ codewhale 没装上 —— 多半是权限问题。请在终端运行(会让你输开机密码):"; echo "      sudo npm install -g codewhale"; echo "  装好后,再双击 install.command 重跑一次。"; exit 1; }
fi
CW="$(command -v codewhale)"; PY="$(command -v python3)"; NODEDIR="$(dirname "$(command -v node)")"
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
echo "  ✓ 已配置 $PNAME(key 仅存本机 ~/.codewhale/config.toml,不外传)"

# ── 4. GUI 文件 ──
echo "→ 部署 GUI 到 ~/codewhale-gui…"
mkdir -p "$HOME/codewhale-gui"
cp -R "$HERE/web" "$HOME/codewhale-gui/"
cp "$HERE/server.py" "$HOME/codewhale-gui/server.py"
cp "$HERE/VERSION" "$HOME/codewhale-gui/VERSION" 2>/dev/null || echo "0.0.0" > "$HOME/codewhale-gui/VERSION"   # 当前 GUI 版本(在线更新比对用)
sed -i '' "s#/Users/test#$HOME#g" "$HOME/codewhale-gui/web/index.html"   # 把示例家目录换成本机

# ── 5. GUI token(本机生成,LAN 防护)──
mkdir -p "$HOME/.codewhale-gui"
"$PY" -c "import secrets;open('$HOME/.codewhale-gui/token','w').write(secrets.token_urlsafe(24))"
chmod 600 "$HOME/.codewhale-gui/token"
# 在线更新配置(默认关;发布者改 repo 为自己 GitHub 仓 + enabled:true 即开)。公钥已内嵌 server.py 验签。
[ -f "$HOME/.codewhale-gui/update.json" ] || cp "$HERE/update.json" "$HOME/.codewhale-gui/update.json" 2>/dev/null || true
# 更新验签需要 cryptography(失败也不阻断安装,只是自动更新会暂时禁用)
"$PY" -m pip install --user cryptography >/dev/null 2>&1 || "$PY" -m pip install --break-system-packages cryptography >/dev/null 2>&1 || echo "  (cryptography 没装上:在线更新会暂时禁用,不影响其他功能)"

# ── 5.6 CA 证书包(修代理 TLS 解密 / python.org 版 Python 空 CA 包导致的余额、联网校验失败)──
# 合并:钥匙串里的系统根 + System/login 钥匙串(含用户本机代理 TLS 解密用的自签根)+ certifi(若有)。
# 让前端 server.py 的 HTTPS 校验既认公网证书、也认本机代理重签的证书;每台机器按各自钥匙串生成。
echo "→ 生成 CA 证书包(兼容 TLS 解密代理)…"
CABUNDLE="$HOME/.codewhale-gui/ca-bundle.pem"
: > "$CABUNDLE"
security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain >> "$CABUNDLE" 2>/dev/null || true
security find-certificate -a -p /Library/Keychains/System.keychain          >> "$CABUNDLE" 2>/dev/null || true
security find-certificate -a -p "$HOME/Library/Keychains/login.keychain-db"  >> "$CABUNDLE" 2>/dev/null || true
CERTIFI="$("$PY" -c 'import certifi;print(certifi.where())' 2>/dev/null || true)"
[ -n "$CERTIFI" ] && [ -f "$CERTIFI" ] && cat "$CERTIFI" >> "$CABUNDLE" 2>/dev/null || true
if [ -s "$CABUNDLE" ]; then
  chmod 600 "$CABUNDLE"; echo "  ✓ CA 包就绪($(grep -c 'BEGIN CERTIFICATE' "$CABUNDLE") 张证书)"
else
  echo "  ⚠ CA 包为空(余额/联网在 TLS 解密代理下可能仍失败)"; CABUNDLE=""
fi

# ── 5.5 联网工具(MCP: fetch 读网页 + playwright 浏览器)──
echo "→ 配置联网工具(MCP)… 这步会下载组件(含浏览器 ~150MB),可能几分钟,请耐心"
if ! command -v uvx >/dev/null 2>&1; then
  echo "  安装 uv(给 fetch 用)…"
  curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1 || echo "  ⚠ uv 装失败,fetch 可能不可用(playwright 不受影响)"
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
cat > "$HOME/.codewhale/mcp.json" <<MCP
{
  "timeouts": { "connect_timeout": 60, "execute_timeout": 120, "read_timeout": 180 },
  "servers": {
    "fetch": { "command": "$UVX", "args": ["mcp-server-fetch"], "env": {}, "url": null, "connect_timeout": null, "execute_timeout": null, "read_timeout": null, "disabled": false, "enabled": true, "required": false, "enabled_tools": [], "disabled_tools": [] },
    "playwright": { "command": "$PWLAUNCH", "args": [], "env": { "CW_NPX": "$NPX2" }, "url": null, "connect_timeout": null, "execute_timeout": null, "read_timeout": null, "disabled": false, "enabled": true, "required": false, "enabled_tools": [], "disabled_tools": [] }
  }
}
MCP
chmod 600 "$HOME/.codewhale/mcp.json"
echo "  下载 fetch 组件…";  ( "$UVX" mcp-server-fetch </dev/null >/dev/null 2>&1 & ); sleep 10; pkill -f mcp-server-fetch 2>/dev/null || true
echo "  下载 playwright…";   ( "$NPX2" -y @playwright/mcp@latest </dev/null >/dev/null 2>&1 & ); sleep 30; pkill -f "@playwright/mcp" 2>/dev/null || true
echo "  下载 Chromium 浏览器(最久)…"; "$NPX2" -y playwright install chromium >/dev/null 2>&1 || echo "  ⚠ Chromium 没下完,首次用浏览器时会自动补"
echo "  ✓ 联网工具就绪"

# ── 6. 开机自启(launchd,路径参数化)──
echo "→ 配置开机自启…"
LA="$HOME/Library/LaunchAgents"; mkdir -p "$LA"
PLPATH="$NODEDIR:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# 让前端 server.py 用上面生成的 CA 包(空则不注入,行为同旧版)
CERTENV=""
[ -n "$CABUNDLE" ] && CERTENV="<key>SSL_CERT_FILE</key><string>$CABUNDLE</string>"
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
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PLPATH</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/codewhale-gui/app-server.log</string>
  <key>StandardErrorPath</key><string>$HOME/codewhale-gui/app-server.log</string>
</dict></plist>
PLIST
cat > "$LA/com.codewhale.frontend.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.codewhale.frontend</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>$HOME/codewhale-gui/server.py</string></array>
  <key>WorkingDirectory</key><string>$HOME/codewhale-gui</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PLPATH</string>$CERTENV</dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/codewhale-gui/webserver.log</string>
  <key>StandardErrorPath</key><string>$HOME/codewhale-gui/webserver.log</string>
</dict></plist>
PLIST
launchctl bootout "gui/$UID_N/com.codewhale.appserver" 2>/dev/null || true
launchctl bootout "gui/$UID_N/com.codewhale.frontend"  2>/dev/null || true
launchctl load -w "$LA/com.codewhale.appserver.plist"
launchctl load -w "$LA/com.codewhale.frontend.plist"

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
for i in $(seq 1 40); do curl -fsS -m2 http://127.0.0.1:7878/health >/dev/null 2>&1 && break; sleep 0.5; done
echo
echo "✅ 安装完成!正在打开 CodeWhale…"
echo "   • 以后从 启动台/Spotlight 搜 “CodeWhale” 打开(白鲸图标),已设开机自启"
echo "   • 若首次打开弹「身份不明的开发者」→ 右键点 CodeWhale → 「打开」→ 再点「打开」,只需这一次"
echo "   • 想换模型:app 左下角「🧠 模型」随时切"
open "$APP" 2>/dev/null || true
