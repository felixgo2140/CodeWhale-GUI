# 研究 Harness 安装包(深度研究面板的 10 引擎)

CodeWhale GUI(v2.6.0+)的「深度研究」面板支持 10 个可并排对比的研究引擎。GUI 本体只带面板和
`/api/harness/*` 通用端点;引擎的本机运行环境由这里的脚本一键安装:

| 引擎 | 架构 | 擅长 |
|---|---|---|
| 🔬 DeerFlow | ByteDance 多 agent harness(lead agent + subagents + skills + sandbox) | 挂研究方法 skill 出框架化报告 |
| 📑 GPT Researcher | 规划→并行搜索→带引用报告 | 引用最严格、速度快 |
| 🕸️ Open Deep Research | LangGraph 监督者+子研究员分解式深挖 | 宽课题拆解 |
| 🌪️ STORM(斯坦福) | 多视角提问→大纲→维基级长文 | 行业综述/背景研究 |
| 🔁 Agent Loop | LangGraph-lite:计划→搜索→初稿→批判→补搜→定稿 | 测试不同 LLM 的长任务稳定性与自我纠错 |
| 🧩 Pydantic AI | 搜索取材→类型化 schema→校验后的结构化报告 | 测模型的结构化输出和字段稳定性 |
| 🌐 browser-use | 浏览器自动操作:打开网页→点击/滚动→抽取动态内容 | API 抓不到的网页/评论/排名/趋势 |
| 👥 CrewAI | 多角色 crew:事实→正方→反方→总编 | 投资委员会/品牌竞品辩论 |
| 🗂️ Obsidian/LlamaIndex | Obsidian vault + CodeWhale/Codex 本机记录→本地 embedding→引用回答 | 私人知识库问答与工作复盘 |
| 🧭 我的方法论 | 你自己的研究 skill,在当前对话模型里跑 | 私有方法论 |

## 使用速查

在聊天输入框直接用斜杠命令即可:

| 命令 | 适合问题 | 推荐问法 | 不适合 |
|---|---|---|---|
| `/df` | 股票、公司、行业、供应链等重型深研 | `/df 深度研究 AMD,重点看 MI300/MI350 竞争、未来 6-12 个月催化剂、主要风险,输出多空表+结论` | 只想要很快的摘要 |
| `/gptr` | 快速 briefing、带引用的事实整理、竞品/公司概览 | `/gptr 研究 Perplexity 和 ChatGPT Search 的产品定位差异,列来源和结论` | 需要很多轮自我审稿 |
| `/odr` | 宽课题拆解、政策/产业链/复杂主题 | `/odr 分析 AI 数据中心电力瓶颈,拆成供给、需求、政策、设备链、投资风险` | 很窄的单点问题 |
| `/storm` | 行业综述、技术背景、教育型长文 | `/storm 写一篇 HBM 产业链综述,解释技术路线、主要公司、历史演进和未来争议` | 实时行情、短线交易 |
| `/agentloop` | 需要初稿后自我批判、补搜、反方观点的研究 | `/agentloop 研究 CRWD 的多空逻辑,要求先列假设,再找反证,最后给观察信号` | 只要一页快答 |
| `/pydai` | 品牌、公司、竞品、技术调研的结构化报告 | `/pydai 分析 Figma 的品牌与竞品位置,输出关键发现、风险、观察清单、结论` | 依赖实时硬数据或复杂行情接口 |
| `/browser` | 需要打开真实网页、读取动态页面、评论区、排行榜 | `/browser 打开 Google Trends,比较 AMD 和 NVDA 最近 30 天搜索热度并摘录证据` | 需要登录/支付/提交表单的任务 |
| `/crew` | 需要多角色辩论、投资委员会、品牌/竞品评审 | `/crew 用事实研究员、多头、空头、总编四个视角评估 Micron 的未来 6 个月多空逻辑` | 只想快速查事实 |
| `/obsidian` 或 `/vault` | 查询自己的 Obsidian 私人知识库、CodeWhale/Codex 旧对话和工作记录 | `/obsidian 查我之前怎么改 stocksight 和 browser-use,按时间线归类并引用记录路径` | 想联网搜索新资料 |
| `/method` 或 `/skill` | 用当前选中的私有 research skill 跑 | `/method 按价值投资大师框架分析 腾讯 0700.HK` | 想让外部 harness 独立长跑 |

### 选择口诀

- 要最稳的重型深研:用 `/df`。
- 要最快的带引用报告:用 `/gptr`。
- 题目很宽、需要拆成多个子问题:用 `/odr`。
- 想要百科/课程式长文:用 `/storm`。
- 想让模型先写再审再补搜:用 `/agentloop`。
- 想要字段稳定、格式固定的结构化结论:用 `/pydai`。
- 想让 agent 真的打开网页看动态内容:用 `/browser`。
- 想让多个角色交叉辩论:用 `/crew`。
- 想复用自己的 Obsidian 笔记或本机 CodeWhale/Codex 旧记录:用 `/obsidian`。
- 想沿用自己的投资/行业方法论并继续追问:用 `/method`。

### 万能 prompt 模板

```text
/<engine> 研究对象: ...
核心问题:
1. ...
2. ...
时间范围: 最近 ... / 未来 ...
必须覆盖: 数据、来源、反方观点、风险、催化剂/观察信号
输出格式: 执行摘要 + 关键发现表 + 多空/正反 + 风险清单 + 结论
```

报告落盘:

- DeerFlow: `~/deerflow-output/`
- 其他 harness: `~/harness-output/{gptr,odr,storm,agentloop,pydai,browseruse,crewai,obsidian}/`

### Obsidian 安全边界

`/obsidian` 默认只读 `~/ObsidianVaults/mm`,并额外读取本机 CodeWhale/Codex 对话记录,转成脱敏 markdown 缓存在 `~/harness-output/obsidian/records_cache/` 后再索引。可在 `~/agent-harnesses/harness.env` 用 `OBSIDIAN_VAULT=/abs/path` 改成其他 vault。

默认安全策略:

- Obsidian vault 只索引 `.md` 和 `.txt`。
- CodeWhale 默认读取 `~/.codewhale/tasks/runtime` 的 thread/turn/item,整理为每个 thread 一份 markdown。
- Codex 默认读取 `~/.codex/sessions` 和 `~/.codex/archived_sessions` 的 JSONL session,只抽取用户/助手消息、标题、时间和工作目录。
- 排除 `.obsidian/`、`.git/`、隐藏目录、`secrets/`、`private/`、`credentials/`,并排除文件名含 `token`、`secret`、`credential`、`private_key`、`api_key`、`.env` 的 vault 文件。
- 派生记录会脱敏常见 API key/token、Bearer、password/secret 字段和 base64 图片;系统提示、环境上下文、工具大段原始数据不会作为主要知识内容保留。
- 建索引默认用轻量 mock embedding + 关键词召回,避免首次下载模型卡住;可用 `OBSIDIAN_EMBED_MODEL=<huggingface-model>` 切换成本地语义 embedding。回答时只把命中的少量片段发给 LLM。
- 报告会列出命中的来源路径和来源类型(`obsidian`/`codewhale`/`codex`),方便复查。

可选环境变量:

```bash
OBSIDIAN_INCLUDE_CODEWHALE=1
OBSIDIAN_INCLUDE_CODEX=1
OBSIDIAN_CODEWHALE_MAX_THREADS=300
OBSIDIAN_CODEX_MAX_SESSIONS=500
OBSIDIAN_EMBED_MODEL=mock
```

## 安装

```bash
brew install python@3.12 uv                     # 前置(python 必须 3.12,见坑 #1)
cp harness.env.example ~/agent-harnesses/harness.env   # 填入你的 API key
bash install_harnesses.sh                        # 幂等,失败可重复跑
```

密钥只存在于 `~/agent-harnesses/harness.env` 一个文件;桥接脚本与所有配置模板不含任何 key。

## 架构:如何再接一个新引擎

1. 写一个桥接脚本 `~/scripts/<name>_client.py`,提供三个子命令(输出单行 JSON):
   - `submit "<prompt>"` → `{"ok":true,"thread_id":"..."}`
   - `progress <tid>` → `{"status":"running|success|error","tail":"最新进展","msg_count":N}`
   - `result <tid>` → `{"ok":true,"output":"报告全文","file":"xx.md","path":"/abs/path"}`
2. GUI 的 `server.py` `_HARNESS` 注册表加一条 `{"client":脚本路径,"outdir":报告目录}`。
3. `web/index.html` 的 `DF_ENGINES` 加一个引擎条目(api:"/api/harness/<name>")。
面板的提交/进度/报告/预览 UI 全部自动复用。

## 踩坑实录(装的时候脚本都自动处理了,但你该知道为什么)

1. **gpt-researcher 必须 python3.12**。3.14 下 numpy 报 `symbol not found '_ccopy$NEWLAPACK_'`(LAPACK 符号缺失),venv 直接废。
2. **deepseek 没有 embeddings 接口**。gpt-researcher 的上下文压缩需要 embeddings → 用 Kimi coding 端点的 bge_m3
   (`moonshot-v1-embedding`)。且 embedding 与 LLM 的 base_url 不同,必须经 `EMBEDDING_KWARGS` 覆盖
   `openai_api_base` 才能分离——直接换 `OPENAI_BASE_URL` 会把 LLM 一起带跑。
3. **宿主 shell 的 OPENAI_API_KEY 会污染**。桥接子进程继承环境,若 shell 里有别家 key,deepseek 调用 401
   `api key invalid`。env 文件加载必须**强制覆盖** `os.environ[k]=v`,不能 `setdefault`。
4. **deepseek 不支持 `json_schema` 结构化输出**。langchain openai provider 的 `with_structured_output`
   默认走 json_schema → 400 `This response_format type is unavailable`。解法:`uv add langchain-deepseek`,
   模型名用 `deepseek:` 前缀(改走 function calling)。
5. **deepseek thinking 模式不接受强制 tool_choice** → 400 `Thinking mode does not support this tool_choice`。
   解法:请求体加 `{"thinking":{"type":"disabled"}}`。Open Deep Research 需打补丁把 `extra_body` 加进
   `init_chat_model` 的 `configurable_fields`(注意:configurable_fields 和默认 kwargs **不能混用**,
   混用报 `_init_chat_model_helper() missing 'model'`)。
6. **Open Deep Research 自带 Supabase 鉴权**(langgraph.json 的 auth 段),本地跑一律 401,必须删除。
7. **knowledge-storm(STORM)不声明 tavily-python 依赖**,用 TavilySearchRM 会 `Tavily requires pip install tavily-python`,要显式装。
8. **DeerFlow 的最终报告写在 sandbox**(`backend/.deer-flow/users/*/threads/<tid>/user-data/outputs/**.md`),
   消息流里的 ai 消息大多是 lead agent 的记忆检查点(`## SESSION INTENT` 内务)——把消息流拼成"报告"会得到
   一坨会话管理废话。桥接的 `result` 必须优先取 sandbox 文件。
9. **DeerFlow 深研会被 `loop_detection.tool_freq_hard_limit`(默认 50)掐浅**:同一工具调 50 次强制停,
   而认真的个股深挖要 60-80 次搜索。配置模板已抬到 150,并给 web_search/web_fetch 单独放宽(250/200)。
10. **Jina 抓取(web_fetch)默认 10s 超时太短**,长文页面连续 ReadTimeout 浪费轮次,模板已放宽到 30s。
11. **langgraph dev 首次启动 ~1 分钟**(uv 解析环境),odr_client 的 submit 会自动拉起并等待,GUI 侧超时要给足。
12. **DeerFlow gateway 的本地管理账号**由 `deerflow_client.py` 首次调用时自动创建(仅 127.0.0.1 回环使用)。

## 引擎无关的输出约定

- 所有引擎强制中文输出(面板组装的 prompt 尾部固定 + gptr `LANGUAGE=chinese` + odr 桥接前缀)。
- 报告落盘:`~/harness-output/{gptr,odr,storm,agentloop,pydai,browseruse,crewai,obsidian}/` 与 `~/deerflow-output/`,GUI 内可下载/预览面板打开。
