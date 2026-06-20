# 更新日志

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
