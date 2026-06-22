# 更新日志

## v2.1.5 — 对比栏实时状态 + 完成即时刷新

### 改进
- **每栏标题显示「阶段 + 已用秒」**(思考中 5s / 执行工具 12s / 输出中 / ✓ 9s):秒数在跳=还活着,不用猜是卡死还是在推理。
- **完成即时刷新**:除 SSE 外加每 4 秒轮询 thread summary 兜底(同单模型那套),SSE 停顿/漏收 turn.completed 时也能立刻把该栏收尾为「✓」,不用退出再进才看到。

## v2.1.4 — 对比模式工具过程可折叠

### 改进
- **对比栏的「思考 + 工具调用」收进默认折叠的「⚙️ 过程 N 步」块**,答案始终显示在下面,不再被一长串 web_search / exec_shell / load_skill 过程刷屏挤掉。点过程块头部可展开查看每一步。
- 确认:对比模式各栏完整具备单模型的能力 —— MCP(fetch/playwright/gmail)、默认 skills(felix-framework 等)、shell、联网,开「💻 Shell」即放开。

## v2.1.3 — 对比模式加 Shell / 自动批准开关

### 新增
- **对比模式顶栏加「💻 Shell」+「⚡ 自动批准」开关**:开 Shell 后各模型可跑命令 / 联网取数(curl 等),**跳出 chat-only 沙箱**;工具调用自动批准(对比无逐栏审批 UI,开 Shell 自动连带开自动批准)。工具/命令活动在该栏以「🔧 …」行显示(含输出);关 Shell 则维持纯问答的干净对比。实测 `curl https://api.ipify.org` 经代理取到公网 IP。
- 注:CodeWhale 把 shell 多跑成后台 job,数据显示在 🔧 行;模型是否再补一句文字总结视模型 / 任务而定。

## v2.1.2 — 修对比"三栏都答 DeepSeek"

### 修复
- **对比时 GPT/GLM 栏也回答成 DeepSeek**:旧版(无代理修复)启动的对比后端进程残留着,`ensure` 会复用它们 —— 那些后端连不上各自的 LLM 端点,CodeWhale 退回了 DeepSeek。现 server.py 启动时**清理残留的对比后端**,下次按需重启为带代理修复的;配合 v2.1.1 的代理注入,GPT/GLM 各栏真正用各自的模型。实测三栏:DeepSeek V4 Pro / GPT-5.5 / GLM-5.2 各自正确。

## v2.1.1 — 修对比发送无效 + 后端更新走代理

### 修复
- **对比模式点「发送」没反应**(v2.1.0 的 bug):对比 overlay 的 HTML 在脚本之后才解析,绑定按钮的代码先跑导致没绑上。改为在 DOMContentLoaded 后绑定;并让点发送**立即显示用户气泡 + 启动中**,不再干等后端启动几秒。
- **「CodeWhale 后端」更新按钮无效**:`codewhale update` 子进程由 launchd 起的 server.py 拉起、不继承 shell 的 `HTTP_PROXY`,在假 IP 代理下下载新二进制失败。现给 server.py 调起的所有 codewhale 子进程(含 update、对比各 provider 后端)注入探测到的本机代理。

## v2.1.0 — 多模型并排对比

### 新增
- **多模型并排对比**(侧栏「⚖️ 对比」):多选 provider(DeepSeek / GLM / GPT …),顶部共用输入框发一条 prompt,下方每个模型一栏**并排独立流式**,点栏头可**最大化**单栏阅读。每个模型一个独立后端进程(不切换不重启,真并行);对比为纯问答(不跑工具),与单模型模式并存。
  - 实现:server.py 每 provider 派生独立配置起 app-server(`/cmp/<provider>/v1/*` 代理),`/api/compare/ensure` 懒启动;前端多栏 SSE。
  - 注:GLM 那栏需 z.ai Coding Plan 才出结果,否则报错(订阅后自动可用)。

### 含 v2.0.8 全部修复
本版包含 v2.0.8 的代理 TLS 解密修复(见下)。

## v2.0.8 — 修代理 TLS 解密下余额/联网校验失败

### 修复
- **本机代理做 TLS 解密(MITM 自签根)时余额/更新检查失败**:python.org 版 Python 默认 CA 包为空,代理重签的证书校验不过。现 server.py 合并 macOS 钥匙串(系统根 + 含代理自签根的 System/login 钥匙串)与 certifi 成一个 CA 包(`~/.codewhale-gui/ca-bundle.pem`)载入 SSL 上下文;安装脚本也在装机时生成该包并给前端注入 `SSL_CERT_FILE`。仍开启证书校验,只是纳入本机已信任的根。

## v2.0.7 — 代理环境下余额/更新检查修复

### 修复
- **挂假 IP 代理时余额⚠ + 更新检查失败**:server.py 由 launchd 启动,不继承 shell 的 `HTTP_PROXY`,直连被劫持的假 IP(198.18.x.x)会断,导致余额(→DeepSeek)、更新检查(→GitHub)失败(LLM 聊天走 app-server 不受影响)。现 server.py 外连**直连优先、失败自动按「环境变量 → macOS 系统代理 → 探测本机代理端口(1082/7890…)」走代理**。
- 注:若你那台机器卡在旧版导致"更新检查"本身就坏,app 内更新拉不到本版,请**重装**安装包(浏览器走代理正常)。

## v2.0.6 — 重发 v2.0.5 的修复(干净版)

v2.0.5 的发布产物在打包后被污染成了带 bug 的 v2.0.4 代码(git 源始终正确)。本版从干净源重新打包发布,内容等同 v2.0.5 的预期修复:前端建会话不传 workspace、由 app-server 用 $HOME,无注入、无写死路径。**若你装的是 v2.0.5,请更新到本版或重装。**

## v2.0.5 — 修 v2.0.4 跨机器回归(workspace 改服务端默认)

### 修复
- **v2.0.4 在 home≠/Users/test 的机器上把页面弄坏**(LLM 连不上 + 更新按钮失效):v2.0.4 用"server.py 发首页时把 `__CW_HOME__` 替换成真实 home"的方式注入 workspace,该注入在 WKWebView 上存在"写一半失败→回退重发→响应损坏→整页 JS 不执行"的隐患(dev 机 home 恰为 /Users/test,curl 也测不出,故未发现)。
- **改为根治法**:前端建会话不再传 workspace,**由 app-server 用自身工作目录($HOME)**——任何机器都正确,彻底删除注入逻辑,不写死任何路径。

> ⚠️ 若你在 v2.0.4 上点更新/LLM 都失效,自更新按钮可能也点不动,请**重装一次**(一键安装包会覆盖修好,且保留你已配的模型 key)。

## v2.0.4 — 修跨机器"沙箱"(workspace 路径)

### 修复
- **跨机器 workspace 失效**:旧版前端把新会话 workspace 写死成开发机的 `/Users/test`,在别人机器上该路径不存在 → agent 所有文件操作被「Path escapes workspace」拦截,表现为"在沙箱里跑、读不到记忆/写不进文件"。现改为 **server.py 发首页时注入本机真实 home**,任意机器 workspace 都正确。

## v2.0.3 — GLM 用量显示 + 键盘缩放

### 新增
- **键盘缩放 ⌘+ / ⌘= / ⌘- / ⌘0**:web 层实现,原生 app + 浏览器 + 手机三端通用;缩放比例本地持久化,刷新/更新后保持。
- **GLM(z.ai)用量显示**:当 provider=zai 时,侧栏读 z.ai Coding Plan 的每 5 小时用量额度(`monitor/usage/quota/limit`)显示「GLM 5h XX%」;未订阅 Coding Plan 时显示「GLM 无套餐」并说明原因。

## v2.0.2 — 免 key 一键安装 + GUI 配模型

### 改进
- **一键安装,终端零输入**:安装脚本不再在终端追问服务商 / API key,直接写一份免 key 默认配置(已有配置则保留不动);模型与 key 全部移到 GUI 里配。
- **首次打开自动引导**:检测到当前 provider 还没配 key(且非 OAuth)时,自动弹出「🧠 模型」面板,选服务商 + 填 key → 切换即用。
- **更新检查失败提示说人话**:私有仓库 / 未发布 Release 拉不到更新源时,明确提示「更新源拉不到(仓库私有或未发布 Release)」,不再只显示「检查失败」。

## v2.0.0 — 首发

CodeWhale GUI 首个公开版本:原生 macOS 界面 + 多模型 + 安全在线更新。

### 新增
- **原生 macOS 应用**(Swift + WKWebView)替代 Chrome `--app` 方案:真原生窗口、Dock 点击复用窗口、零浏览器依赖、Intel + Apple 芯片通用二进制
- **多模型一键切换**:DeepSeek / GLM(智谱)/ Kimi / OpenAI / ChatGPT(OAuth)/ Claude / OpenRouter / DeepInfra,侧栏「🧠 模型」
- **余额显示**按 provider 绑定;模型名与余额同框显示
- **文件上传**:拖拽 / 📎 / 粘贴 → agent 读取
- **Skills 面板** + **Connectors(MCP)面板**(列出 / 状态 / 开关 / 增删 / 加 server)
- **消息复制 / 编辑重发**;工具调用与文件改动块**默认折叠**
- **🔐 签名验证的在线更新**:Ed25519 + SHA-256 + 防降级 + 路径封死 + 原子替换回滚
- 安装时**选模型服务商**;报错人话化;首次右键打开提示

### 修复 / 优化
- 切换会话从「重放上万条事件」改为「快照 + 增量监听」,大会话秒开
- 流式输出时上翻看历史不再被强制拽回底部;「↓ 回到底部」浮钮
- 切换模型不再整页白屏重载,改软刷新;对话不与模型绑定
- 余额读取改为直读配置文件,跨机器稳健;失败自报原因
- 原生 app 加标准菜单栏,修复 ⌘C/⌘V/⌘X/⌘A 复制粘贴快捷键

### 已知限制
- 原生壳不自动更新(大改重装即可);codewhale CLI 由其自身机制更新
- fake-ip 模式代理下内置 `fetch_url` 会被拦(改用 web_search / playwright,或把代理切 redir-host 模式)
