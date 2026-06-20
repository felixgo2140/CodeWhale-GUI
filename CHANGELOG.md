# 更新日志

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
