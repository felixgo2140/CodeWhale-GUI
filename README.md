**简体中文** | [English](README.en.md)

# CodeWhale GUI 🐳

给 [CodeWhale](https://github.com/Hmbown/CodeWhale)(DeepSeek-TUI,DeepSeek V4 终端编程 agent)做的**原生 macOS 桌面界面** —— 多会话、流式输出、工具审批、文件上传、多模型一键切换,带**签名验证的安全在线更新**。

不依赖 Chrome,Intel 与 Apple 芯片通用,二进制仅约 82K。

---

## ✨ 功能

- **原生 macOS 应用**(Swift + WKWebView):真原生窗口、标准红黄绿、记忆窗口大小、Dock 点击复用窗口、零浏览器依赖
- **多会话**侧栏 + 流式输出 + 工具调用审批卡 + 终端块渲染 + 时间线 + 归档管理 + Cron Jobs/置顶分组
- **多模型按需切换**:DeepSeek / GLM / Kimi K3 / 火山 / LongCat / 千问 / 混元 / ChatGPT(OAuth) / Claude 等,会话恢复时以真实 thread provider/model 为准
- **⚖️ 多模型对比**:同一问题真并行发给多个独立后端,标签页阅读,关闭/重开某模型仍保留该 comparison session 的历史
- **余额显示**:按当前 provider 绑定(DeepSeek 显示实时余额,其它显示来源说明)
- **文件上传**:拖拽 / 📎 按钮 / 直接粘贴 → 存入 workspace,agent 自动读取
- **插件 / Skills**:本地目录或 GitHub 安装,启停、修复、更新检查;从 `+` 菜单直接挂载插件及子 skill
- **Connectors(MCP)面板**:列出 MCP server + 实时状态,开关 / 增删 / 加新 server
- **消息操作**:复制 / 编辑重发;工具调用与文件改动块默认折叠;流式输出时上翻看历史不被打断,「↓ 回到底部」一键跟随
- **手机访问**(PWA):token 鉴权,后端只绑 `127.0.0.1`,数据不外露
- **🔐 签名验证的安全在线更新**:Ed25519 签名 + SHA-256 完整性 + 版本只升不降 + 路径封死 + 原子替换 + 失败回滚
- **🔬 深度研究**:DeerFlow / GPT Researcher / Open Deep Research / STORM / Agent Loop / Pydantic AI / CrewAI / Browser Use / 自有方法论,过程可见,报告以 Markdown/PDF 附件卡交付和预览
- **macOS 原生通知**:每个 turn 完成、失败或中断后弹出,持久化去重,不补弹历史任务

---

## 📦 安装(macOS 12+)

**先决条件**:Node.js、python3(Mac 一般自带 python)。**不需要 Chrome 或任何浏览器。**

1. 从 [Releases](../../releases) 下载 `codewhale-installer.tar.gz`,解压;
2. 双击 `install.command`(首次若提示「身份不明的开发者」→ 右键点它 → 「打开」→ 再「打开」,仅此一次);
3. **一键装好并自动打开** —— 全程不需要在终端输入任何 API key;
4. 首次打开在「设置 → 大模型」配置需要的 provider;ChatGPT 可使用 Codex OAuth,其他 provider 按需填写 API key。

以后从启动台 / Spotlight 搜 "CodeWhale" 打开;想换模型 / 换 key,app 左下角「🧠 模型」随时切。

---

## 🔐 安全模型

- 后端(codewhale app-server / 前端 server.py)**只绑 `127.0.0.1`**;局域网 / 手机访问走 **token 鉴权**,无 token 时失效回退到本机绑定,绝不裸奔暴露 agent。
- API key 仅存本机 `~/.codewhale/config.toml`(权限 600),不外传。
- **在线更新全程加密验证**:更新包必须用维护者的私钥签名;客户端用**内嵌公钥**验签 → 校验 SHA-256 → 版本只升不降 → 解包时逐文件路径封死(只允许 `web/`、`server.py`、`VERSION`,禁符号链接 / 路径穿越)→ 备份后原子替换,失败自动回滚。**更新服务器即使被攻破,没有维护者私钥也无法推送被篡改或恶意的更新。**

---

## 🚀 发布更新(维护者)

```bash
CODEWHALE_SIGNING_KEY=/path/to/signing-key.pem ./publish-release.sh 2.7.0
# 一次生成 GUI、harness、原生 App、完整安装包、签名清单与 SHA256SUMS,并发布 GitHub Release
```

用户启动 / 每小时会自动检查到新版,在侧栏点「↑ 界面 vX.Y」即下载验签更新。详见 `RELEASE-GUIDE.txt`。

> ⚠️ 签名私钥是更新信任的根:务必离线妥善备份(U 盘 / 密码管理器),绝不进 git / 云同步 / 安装包。

---

## 🏗 架构

| 部件 | 说明 |
|---|---|
| 前端 | `web/index.html` + `web/js/` ES modules + `web/css/`(无构建步骤) |
| 服务 | `server.py`:静态服务 + token 反向代理 `/v1/*` 到 codewhale,外加余额 / MCP / Skills / 模型切换 / 更新 等端点 |
| 原生壳 | `native/main.swift`:WKWebView 指向 `127.0.0.1:3000` |
| 后端 | `codewhale app-server`(:7878);前端 `:3000`,均由 launchd 托管开机自启 |

---

## 协议

MIT。

基于 [CodeWhale](https://github.com/Hmbown/CodeWhale) / DeepSeek-TUI 构建。
