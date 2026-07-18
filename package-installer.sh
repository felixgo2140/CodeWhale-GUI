#!/usr/bin/env bash
# 构建可分享的安装包 codewhale-installer.tar.gz:
#   编译原生 app → 组装 installer payload(脚本 + GUI 文件 + 原生 app)→ 打包。
# 用法: ./package-installer.sh [输出路径]
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
STAGE="$TMP/codewhale-installer"
mkdir -p "$STAGE"
echo "→ [1/3] 编译原生 app…"
bash "$HERE/native/build.sh" "$STAGE/CodeWhale.app" >/dev/null
echo "→ [2/3] 组装 payload…"
cp "$HERE/installer/install.sh"     "$STAGE/install.sh"
cp "$HERE/installer/install.command" "$STAGE/install.command" 2>/dev/null || true
cp "$HERE/installer/README.txt"     "$STAGE/README.txt"
cp "$HERE/installer/update.json"    "$STAGE/update.json"
cp "$HERE/VERSION"                  "$STAGE/VERSION"   # 用顶层 VERSION(= 本次发布版本),不用 stale 的 installer/VERSION
cp -R "$HERE/web"                   "$STAGE/web"
cp -R "$HERE/harness"               "$STAGE/harness"
cp "$HERE/server.py"                "$STAGE/server.py"
cp "$HERE/playwright-mcp-launch.sh" "$STAGE/playwright-mcp-launch.sh" 2>/dev/null || true
find "$STAGE" -type d -name '__pycache__' -prune -exec rm -rf {} +
find "$STAGE" -type f -name '*.pyc' -delete
# claude-code 补丁二进制(Claude 订阅 / Opus 引擎)——官方 codewhale 不识别 claude-code provider,必须带上这俩。
# 来源:本机已签名副本 ~/.codewhale-gui/bin/(回退到 build 目录)。arm64(M 系);Intel 需另出 universal。
CCBIN_CLAUDE="$(ls "$HOME/.codewhale-gui/bin/codewhale-claude" "$HOME/codewhale-src/target/release/codewhale" 2>/dev/null | head -1)"
CCBIN_TUI="$(ls "$HOME/.codewhale-gui/bin/codewhale-tui" "$HOME/codewhale-src/target/release/codewhale-tui" 2>/dev/null | head -1)"
if [ -n "$CCBIN_CLAUDE" ] && [ -n "$CCBIN_TUI" ]; then
  mkdir -p "$STAGE/bin"
  cp "$CCBIN_CLAUDE" "$STAGE/bin/codewhale-claude"
  cp "$CCBIN_TUI"    "$STAGE/bin/codewhale-tui"
  echo "   + Claude 订阅引擎(补丁二进制 $(lipo -archs "$CCBIN_CLAUDE" 2>/dev/null))"
else
  echo "   ⚠ 没找到 claude-code 补丁二进制 → 装包将不带 Claude 订阅引擎(其它电脑点 Claude 会 fail-soft)"
fi
chmod +x "$STAGE/install.sh" 2>/dev/null || true
chmod +x "$STAGE/install.command" 2>/dev/null || true
chmod +x "$STAGE/harness/install_harnesses.sh" 2>/dev/null || true
echo "→ [3/3] 打包…"
OUT="${1:-$HERE/codewhale-installer.tar.gz}"
( cd "$TMP" && COPYFILE_DISABLE=1 tar --exclude='.DS_Store' -czf "$OUT" codewhale-installer )
rm -rf "$TMP"
echo "✓ 安装包: $OUT  ($(du -h "$OUT" | cut -f1))"
echo "  上传到 GitHub Release 供人下载。"
