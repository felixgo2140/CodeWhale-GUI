**简体中文** | [English](README.en.md)

# CodeWhale GUI 🐳

给 [CodeWhale](https://github.com/Hmbown/CodeWhale)(DeepSeek-TUI,DeepSeek V4 终端编程 agent)做的**原生 macOS 桌面界面** —— 多会话、流式输出、工具审批、文件上传、多模型一键切换,带**签名验证的安全在线更新**。

不依赖 Chrome,Intel 与 Apple 芯片通用,二进制仅约 82K。

---

## ✨ 功能

- **原生 macOS 应用**(Swift + WKWebView):真原生窗口、标准红黄绿、记忆窗口大小、Dock 点击复用窗口、零浏览器依赖
- **多会话**侧栏 + 流式输出 + 工具调用审批卡 + 终端块渲染
- **多模型一键切换**:DeepSeek / GLM(智谱·Z.ai)/ Kimi(月之暗面)/ OpenAI / ChatGPT(OAuth 登录)/ Claude / OpenRouter / DeepInfra …(侧栏「🧠 模型」)
- **余额显示**:按当前 provider 绑定(DeepSeek 显示实时余额,其它显示来源说明)
- **文件上传**:拖拽 / 📎 按钮 / 直接粘贴 → 存入 workspace,agent 自动读取
- **Skills 面板**:浏览 / 搜索 / 查看 SKILL.md / 新建 skill
- **Connectors(MCP)面板**:列出 MCP server + 实时状态,开关 / 增删 / 加新 server
- **消息操作**:复制 / 编辑重发;工具调用与文件改动块默认折叠;流式输出时上翻看历史不被打断,「↓ 回到底部」一键跟随
- **手机访问**(PWA):token 鉴权,后端只绑 `127.0.0.1`,数据不外露
- **🔐 签名验证的安全在线更新**:Ed25519 签名 + SHA-256 完整性 + 版本只升不降 + 路径封死 + 原子替换 + 失败回滚

---

## 📦 安装(macOS 12+)

**先决条件**:Node.js、python3(Mac 一般自带 python)。**不需要 Chrome 或任何浏览器。**

1. 从 [Releases](../../releases) 下载 `codewhale-installer.tar.gz`,解压;
2. 双击 `install.command`(首次若提示「身份不明的开发者」→ 右键点它 → 「打开」→ 再「打开」,仅此一次);
3. 按提示**选模型服务商**(DeepSeek / GLM / Kimi / OpenAI / 其他)→ **粘贴对应 API key**;
4. 自动装好并打开;以后从启动台 / Spotlight 搜 "CodeWhale" 打开。

装完想换模型:app 左下角「🧠 模型」随时切。

---

## 🔐 安全模型

- 后端(codewhale app-server / 前端 server.py)**只绑 `127.0.0.1`**;局域网 / 手机访问走 **token 鉴权**,无 token 时失效回退到本机绑定,绝不裸奔暴露 agent。
- API key 仅存本机 `~/.codewhale/config.toml`(权限 600),不外传。
- **在线更新全程加密验证**:更新包必须用维护者的私钥签名;客户端用**内嵌公钥**验签 → 校验 SHA-256 → 版本只升不降 → 解包时逐文件路径封死(只允许 `web/`、`server.py`、`VERSION`,禁符号链接 / 路径穿越)→ 备份后原子替换,失败自动回滚。**更新服务器即使被攻破,没有维护者私钥也无法推送被篡改或恶意的更新。**

---

## 🚀 发布更新(维护者)

```bash
~/codewhale-release/make-release.sh <版本号 如 2.0.1> "这版改了啥"
# 产出 3 个文件:gui-<版本>.tar.gz / manifest.json / manifest.json.sig
# → 上传到本仓库一个新的 GitHub Release(同一个 release)即可
```

用户启动 / 每小时会自动检查到新版,在侧栏点「↑ 界面 vX.Y」即下载验签更新。详见 `RELEASE-GUIDE.txt`。

> ⚠️ 签名私钥是更新信任的根:务必离线妥善备份(U 盘 / 密码管理器),绝不进 git / 云同步 / 安装包。

---

## 🏗 架构

| 部件 | 说明 |
|---|---|
| 前端 | `web/index.html` 单文件 SPA(无构建步骤) |
| 服务 | `server.py`:静态服务 + token 反向代理 `/v1/*` 到 codewhale,外加余额 / MCP / Skills / 模型切换 / 更新 等端点 |
| 原生壳 | `native/main.swift`:WKWebView 指向 `127.0.0.1:3000` |
| 后端 | `codewhale app-server`(:7878);前端 `:3000`,均由 launchd 托管开机自启 |

---

## 协议

待定(上游 CodeWhale 为 MIT;建议沿用 MIT)。

基于 [CodeWhale](https://github.com/Hmbown/CodeWhale) / DeepSeek-TUI 构建。
