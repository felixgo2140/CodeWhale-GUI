#!/bin/bash
# CodeWhale GUI 研究 harness 一键安装(幂等,可重复跑)
# 装齐深度研究面板 5 引擎的本机侧依赖:桥接脚本 + GPT Researcher + STORM + Open Deep Research + DeerFlow(gateway)
#
# 用法:
#   1) cp harness.env.example ~/agent-harnesses/harness.env 并填入你的 API key
#   2) bash install_harnesses.sh
# 前置: macOS + brew 装好 git / python@3.12 / uv
#   (python 必须 3.12 —— 3.14 的 numpy 有 LAPACK 符号崩溃,gpt-researcher 装不起来)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ENVF="$HOME/agent-harnesses/harness.env"
say(){ printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

say "0/6 前置检查"
PY312="$(command -v python3.12 || true)"
[ -z "$PY312" ] && [ -x /opt/homebrew/bin/python3.12 ] && PY312=/opt/homebrew/bin/python3.12
[ -z "$PY312" ] && { echo "✗ 缺 python3.12 → brew install python@3.12"; exit 1; }
command -v git >/dev/null || { echo "✗ 缺 git → xcode-select --install"; exit 1; }
command -v uv  >/dev/null || { echo "✗ 缺 uv → brew install uv"; exit 1; }
mkdir -p ~/agent-harnesses ~/harness-output/gptr ~/harness-output/odr ~/harness-output/storm ~/scripts ~/deerflow-output
if [ ! -f "$ENVF" ]; then
  if [ -f "$HERE/harness.env" ]; then cp "$HERE/harness.env" "$ENVF";   # 私密移植包场景:env 随包携带
  else echo "✗ 缺 $ENVF → cp $HERE/harness.env.example $ENVF 然后填入你的 key"; exit 1; fi
fi
set -a; . "$ENVF"; set +a
[ -n "$DEEPSEEK_API_KEY" ] || { echo "✗ harness.env 缺 DEEPSEEK_API_KEY"; exit 1; }
[ -n "$TAVILY_API_KEY" ]  || { echo "✗ harness.env 缺 TAVILY_API_KEY(免费注册 tavily.com)"; exit 1; }
[ -n "$KIMI_API_KEY" ]    || echo "  ⚠ 无 KIMI_API_KEY:GPT Researcher 的 embedding 需要它(deepseek 无 embeddings 接口)"
echo "  python3.12 / git / uv / harness.env ✓"

say "1/6 桥接脚本 → ~/scripts"
cp "$HERE"/bridge/deerflow_client.py "$HERE"/bridge/gptr_client.py "$HERE"/bridge/odr_client.py "$HERE"/bridge/storm_client.py ~/scripts/
chmod +x ~/scripts/deerflow_client.py ~/scripts/gptr_client.py ~/scripts/odr_client.py ~/scripts/storm_client.py
echo "  4 个桥接脚本 ✓(密钥统一读 ~/agent-harnesses/harness.env,脚本本身无 key)"

say "2/6 GPT Researcher"
if [ ! -x ~/agent-harnesses/gptr-venv/bin/python ]; then
  "$PY312" -m venv ~/agent-harnesses/gptr-venv
  ~/agent-harnesses/gptr-venv/bin/pip install -q --upgrade pip
fi
~/agent-harnesses/gptr-venv/bin/pip install -q gpt-researcher
# 生成 gptr.env(由 harness.env 注入;坑:embedding 与 LLM 不同 base,必须经 EMBEDDING_KWARGS 分离)
cat > ~/agent-harnesses/gptr.env <<EOF
OPENAI_API_KEY=$DEEPSEEK_API_KEY
OPENAI_BASE_URL=https://api.deepseek.com/v1
FAST_LLM=openai:deepseek-v4-flash
SMART_LLM=openai:deepseek-v4-pro
STRATEGIC_LLM=openai:deepseek-v4-pro
EMBEDDING=openai:moonshot-v1-embedding
EMBEDDING_KWARGS={"openai_api_base":"https://api.kimi.com/coding/v1","openai_api_key":"$KIMI_API_KEY"}
TAVILY_API_KEY=$TAVILY_API_KEY
RETRIEVER=tavily
LANGUAGE=chinese
EOF
~/agent-harnesses/gptr-venv/bin/python -c "from gpt_researcher import GPTResearcher" && echo "  gpt-researcher ✓"

say "3/6 STORM"
if [ ! -x ~/agent-harnesses/storm-venv/bin/python ]; then
  "$PY312" -m venv ~/agent-harnesses/storm-venv
  ~/agent-harnesses/storm-venv/bin/pip install -q --upgrade pip
fi
~/agent-harnesses/storm-venv/bin/pip install -q knowledge-storm tavily-python   # 坑:tavily-python 不在 knowledge-storm 依赖里,必须显式装
~/agent-harnesses/storm-venv/bin/python -c "import knowledge_storm" && echo "  knowledge-storm ✓"

say "4/6 Open Deep Research (LangGraph)"
if [ ! -d ~/agent-harnesses/open_deep_research ]; then
  git clone -q --depth 1 https://github.com/langchain-ai/open_deep_research.git ~/agent-harnesses/open_deep_research
fi
cd ~/agent-harnesses/open_deep_research
uv sync -q
uv add -q langchain-deepseek   # 坑:deepseek 不支持 json_schema 结构化输出,必须走 deepseek: 前缀(function calling)
cat > .env <<EOF
OPENAI_API_KEY=$DEEPSEEK_API_KEY
OPENAI_BASE_URL=https://api.deepseek.com/v1
DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY
TAVILY_API_KEY=$TAVILY_API_KEY
GET_API_KEYS_FROM_CONFIG=false
LANGSMITH_TRACING=false
EOF
python3 - <<'PY'
# 两个必须的本地补丁(幂等):
# ① langgraph.json 删 Supabase auth —— 上游带的鉴权挂 Supabase,本地跑一律 401,必须删
# ② deep_researcher.py 把 extra_body 加进 configurable —— deepseek thinking 模式不接受强制 tool_choice,
#    运行时经 config 传 {"thinking":{"type":"disabled"}} 关掉(注意 init_chat_model 不能 configurable+默认kwargs 混用)
import json, os
d = os.path.expanduser("~/agent-harnesses/open_deep_research")
lj = os.path.join(d, "langgraph.json")
j = json.load(open(lj))
if j.pop("auth", None) is not None:
    json.dump(j, open(lj, "w"), indent=2)
    print("  langgraph.json: Supabase auth 已移除")
dr = os.path.join(d, "src/open_deep_research/deep_researcher.py")
s = open(dr).read()
if '"extra_body"' not in s:
    old = 'configurable_fields=("model", "max_tokens", "api_key"),'
    if old not in s:
        raise SystemExit("  ✗ deep_researcher.py 结构变了,extra_body 补丁没打上(上游更新?见 harness/README.md)")
    s = s.replace(old, 'configurable_fields=("model", "max_tokens", "api_key", "extra_body"),')
    open(dr, "w").write(s)
    print("  deep_researcher.py: extra_body 补丁已打")
else:
    print("  deep_researcher.py: 补丁已在")
PY
echo "  open_deep_research ✓(首次调用由 odr_client 自动拉起 langgraph dev :2024)"

say "5/6 DeerFlow (gateway :8002)"
if [ ! -d ~/deer-flow-tmp ]; then
  git clone -q https://github.com/bytedance/deer-flow.git ~/deer-flow-tmp
  PIN="$(cat "$HERE"/deerflow/PINNED_COMMIT 2>/dev/null || true)"
  if [ -n "$PIN" ]; then
    git -C ~/deer-flow-tmp checkout -q "$PIN" 2>/dev/null && echo "  已固定到验证过的版本 ${PIN:0:8}" || echo "  ⚠ 固定 $PIN 失败,停留在最新 HEAD(可能有行为差异)"
  fi
fi
# 配置由模板 + harness.env 生成(含调优:tool_freq 抬高防深研被掐/web_fetch 30s/tavily 10 条)
python3 - "$HERE"/deerflow/config.template.yaml <<'PY'
import os, sys, re
tpl = open(sys.argv[1]).read()
out = re.sub(r'\$\{([A-Z_]+)\}', lambda m: os.environ.get(m.group(1), ""), tpl)
open(os.path.expanduser("~/deer-flow-tmp/config.yaml"), "w").write(out)
print("  config.yaml 已生成(密钥注入)")
PY
if git -C ~/deer-flow-tmp apply --check "$HERE"/deerflow/services_recursion.patch 2>/dev/null; then
  git -C ~/deer-flow-tmp apply "$HERE"/deerflow/services_recursion.patch && echo "  services.py 补丁已打(recursion limit 读 config)"
else
  echo "  services.py 补丁已在或不适用,跳过"
fi
mkdir -p ~/deer-flow-tmp/skills/custom ~/deer-flow-tmp/logs
if [ -d "$HERE"/skills-custom ]; then
  cp -R "$HERE"/skills-custom/. ~/deer-flow-tmp/skills/custom/
  echo "  自定义研究 skill × $(ls "$HERE"/skills-custom | wc -l | tr -d ' ') → skills/custom ✓"
else
  echo "  (无自带研究 skill;可后续把自己的 SKILL.md 目录放进 ~/deer-flow-tmp/skills/custom/)"
fi
( cd ~/deer-flow-tmp/backend && uv sync -q )
if ! curl -s -o /dev/null http://127.0.0.1:8002/health; then
  ( cd ~/deer-flow-tmp/backend && nohup uv run uvicorn app.gateway.app:app --host 127.0.0.1 --port 8002 >> ~/deer-flow-tmp/logs/gateway.log 2>&1 & )
  for i in $(seq 1 45); do curl -s -o /dev/null http://127.0.0.1:8002/health && break; sleep 2; done
fi
curl -s -o /dev/null http://127.0.0.1:8002/health && echo "  DeerFlow gateway :8002 ✓" || echo "  ⚠ gateway 没起来,查 ~/deer-flow-tmp/logs/gateway.log"

say "6/6 冒烟自检"
python3 ~/scripts/gptr_client.py progress __nonexist__ >/dev/null && echo "  gptr 桥接 ✓"
python3 ~/scripts/storm_client.py progress __nonexist__ >/dev/null && echo "  storm 桥接 ✓"
echo ""
echo "✅ 完成。CodeWhale GUI(v2.6.0+)深度研究面板 5 引擎可用。踩坑详录见 harness/README.md"
