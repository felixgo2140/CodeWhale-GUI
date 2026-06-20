#!/bin/bash
# 双击我即可安装(会打开终端运行)。
cd "$(dirname "$0")"
bash install.sh
echo
echo "──────────────────────────────"
echo "完成。按回车关闭本窗口。"
read -r _
