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
cp "$HERE/server.py"                "$STAGE/server.py"
chmod +x "$STAGE/install.sh" 2>/dev/null || true
chmod +x "$STAGE/install.command" 2>/dev/null || true
echo "→ [3/3] 打包…"
OUT="${1:-$HERE/codewhale-installer.tar.gz}"
( cd "$TMP" && COPYFILE_DISABLE=1 tar --exclude='.DS_Store' -czf "$OUT" codewhale-installer )
rm -rf "$TMP"
echo "✓ 安装包: $OUT  ($(du -h "$OUT" | cut -f1))"
echo "  上传到 GitHub Release 供人下载。"
