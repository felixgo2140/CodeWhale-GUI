#!/usr/bin/env bash
# 清掉上次会话残留、死攥 profile 锁的 mcp-chrome + 过期 SingletonLock,再 exec 真正的 @playwright/mcp。
# pkill 只匹配 playwright 自己的 profile 目录,绝不碰用户主 Chrome。
pkill -f "ms-playwright-mcp/mcp-chrome" 2>/dev/null || true
sleep 0.5
rm -f "$HOME/Library/Caches/ms-playwright-mcp/"*/Singleton* 2>/dev/null || true
NPX="${CW_NPX:-npx}"
command -v "$NPX" >/dev/null 2>&1 || NPX="$(command -v npx || echo npx)"
exec "$NPX" -y @playwright/mcp@latest "$@"
