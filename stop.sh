#!/usr/bin/env bash
# 停掉 CodeWhale GUI 的后端与前端。
# 按端口定位进程(与 start.sh 保持一致),不依赖进程名/命令行模式匹配 —— 旧版 pkill
# 模式 "codewhale-tui app-server" / "http.server 3000" 都匹配不到真实进程,等于没停。
# 注意:若这两个服务由 launchd 托管(com.codewhale.{appserver,frontend}),KeepAlive 会
# 立即重启;要彻底停用请改跑:launchctl bootout gui/$(id -u)/com.codewhale.appserver
kill_port() {
  local port="$1" label="$2" pids
  pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null)
  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill 2>/dev/null
    echo "已停 $label (端口 $port)"
  else
    echo "$label 未在运行 (端口 $port)"
  fi
}

kill_port 7878 "app-server"
kill_port 3000 "前端"
# 多模型对比 / claude-code 的 per-provider 后端(按需起在 7900+)
for p in $(seq 7900 7910); do
  pids=$(lsof -tiTCP:"$p" -sTCP:LISTEN 2>/dev/null)
  [ -n "$pids" ] && echo "$pids" | xargs kill 2>/dev/null && echo "已停 per-provider 后端 (端口 $p)"
done
