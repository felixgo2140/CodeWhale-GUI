#!/bin/bash
# 双击我即可安装(会打开终端运行)。
cd "$(dirname "$0")"
if bash install.sh; then
  result="安装完成。按回车关闭本窗口。"
  code=0
else
  code=$?
  result="安装失败(错误码 $code)。请保留上面的错误信息,修复后重新双击本文件。按回车关闭。"
fi
echo
echo "──────────────────────────────"
echo "$result"
read -r _
exit "$code"
