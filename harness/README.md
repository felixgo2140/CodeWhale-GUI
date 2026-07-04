# 研究 Harness 安装包(深度研究面板的 5 引擎)

CodeWhale GUI(v2.6.0+)的「深度研究」面板支持 5 个可并排对比的研究引擎。GUI 本体只带面板和
`/api/harness/*` 通用端点;引擎的本机运行环境由这里的脚本一键安装:

| 引擎 | 架构 | 擅长 |
|---|---|---|
| 🔬 DeerFlow | ByteDance 多 agent harness(lead agent + subagents + skills + sandbox) | 挂研究方法 skill 出框架化报告 |
| 📑 GPT Researcher | 规划→并行搜索→带引用报告 | 引用最严格、速度快 |
| 🕸️ Open Deep Research | LangGraph 监督者+子研究员分解式深挖 | 宽课题拆解 |
| 🌪️ STORM(斯坦福) | 多视角提问→大纲→维基级长文 | 行业综述/背景研究 |
| 🧭 我的方法论 | 你自己的研究 skill,在当前对话模型里跑 | 私有方法论 |

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
- 报告落盘:`~/harness-output/{gptr,odr,storm}/` 与 `~/deerflow-output/`,GUI 内可下载/预览面板打开。
