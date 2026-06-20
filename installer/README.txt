CodeWhale GUI —— 安装说明
==============================

这是一个本地 AI 编程助手的桌面界面(后端用 DeepSeek V4)。

  界面是一个原生 macOS 应用(WKWebView),不依赖 Chrome 或任何浏览器。

【先决条件】(装之前确认有)
  1. Node.js          —— 没有就去 https://nodejs.org/ 下载安装(LTS 版即可)
  2. python3          —— 一般 Mac 自带;若提示缺,运行:xcode-select --install
  (不需要 Chrome;界面是自带的原生 app,Intel 和 Apple 芯片都支持)

【怎么装】
  1. 把整个文件夹放到桌面(或任意位置)。
  2. 双击  install.command
     - 若弹“无法打开,因为来自身份不明的开发者”:
       右键点 install.command → 选「打开」→ 再点「打开」。
       (或终端里运行:xattr -dr com.apple.quarantine <本文件夹路径>)
  3. 装到一半会让你「选模型服务商」(DeepSeek / GLM 智谱 / Kimi / OpenAI / 其他),
     输数字回车;然后「粘贴对应的 API key」回车(粘贴时屏幕不显示,是正常的)。
     —— 装完也能在 app 左下角「🧠 模型」随时换。
  4. 之后自动装好其余部分(会下载 codewhale + 联网组件 + 浏览器,可能几分钟,
     终端窗口别关),最后自动打开 CodeWhale。
     若首次打开弹「身份不明的开发者」→ 右键点 CodeWhale →「打开」→ 再点「打开」,只需一次。

【装完怎么用】
  • 从 启动台 / Spotlight 搜 “CodeWhale” 打开(白鲸图标);
  • 或浏览器访问  http://127.0.0.1:3000
  • 已设开机自启,以后开机自动在后台运行。

【说明】
  • DeepSeek API key 在安装时手动输入(由发你安装包的人单独提供);用量计入他的账户。
  • 全程在本机运行,数据不外传;后端只绑本机 127.0.0.1。
  • 已内置联网工具:可读网页、可自动操作浏览器(让 AI 帮你查资料、抓网页、填表)。
  • 想卸载:
      launchctl bootout gui/$(id -u)/com.codewhale.appserver
      launchctl bootout gui/$(id -u)/com.codewhale.frontend
      rm -rf ~/codewhale-gui ~/.codewhale-gui ~/Applications/CodeWhale.app
      rm ~/Library/LaunchAgents/com.codewhale.*.plist
