// CodeWhale 原生 macOS 壳 — WKWebView 指向本地 GUI(127.0.0.1:3000),无 Chrome、无 chrome-profile。
import Cocoa
import WebKit

let home = FileManager.default.homeDirectoryForCurrentUser.path
func readToken() -> String {
    (try? String(contentsOfFile: "\(home)/.codewhale-gui/token", encoding: .utf8))?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

@discardableResult
func sh(_ cmd: String, wait: Bool = true) -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/bash")
    p.arguments = ["-lc", cmd]   // -l 载入 profile,保证 PATH 含 node/homebrew/codewhale
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return -1 }
    if wait { p.waitUntilExit(); return p.terminationStatus }
    return 0
}
func ping(_ url: String) -> Bool { sh("curl -fsS -m2 '\(url)' >/dev/null 2>&1") == 0 }

func ensureServices() {
    if !ping("http://127.0.0.1:7878/health") {
        sh("cd \"$HOME\" && nohup codewhale app-server --http --host 127.0.0.1 --port 7878 --insecure-no-auth >\"$HOME/codewhale-gui/app-server.log\" 2>&1 &", wait: false)
    }
    if !ping("http://127.0.0.1:3000/") {
        sh("nohup python3 \"$HOME/codewhale-gui/server.py\" >\"$HOME/codewhale-gui/webserver.log\" 2>&1 &", wait: false)
    }
    for _ in 0..<40 { if ping("http://127.0.0.1:3000/") { break }; usleep(400_000) }
}

class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var extraWindows: [NSWindow] = []   // window.open() 开的独立窗口(多模型对比单独开窗),保留引用避免被释放

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()      // 没主菜单 → Cmd+C/V/X/A 无处分发,文本框复制粘贴失灵
        ensureServices()
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()            // 持久化 localStorage(置顶/token 缓存)
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")  // 右键可"检查元素"
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 800), configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self        // ★ 关键:不设 uiDelegate 时 WKWebView 不弹 JS 对话框,confirm() 直接返回 false、alert()/prompt() 静默无效 → 删除/更新/重命名/对比「重启后端」等点了没反应
        web.allowsBackForwardNavigationGestures = false

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "CodeWhale"
        window.center()
        window.setFrameAutosaveName("CodeWhaleMain")  // 记住窗口大小/位置
        window.contentView = web
        window.minSize = NSSize(width: 720, height: 480)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        load()
    }
    func load() {
        let url = "http://127.0.0.1:3000/?token=\(readToken())"
        if let u = URL(string: url) { web.load(URLRequest(url: u)) }
    }

    // 本壳只承载本地 GUI(127.0.0.1/localhost:3000)。判断某 URL 是否属于 App 自己的源。
    func isAppOrigin(_ url: URL?) -> Bool {
        guard let u = url else { return false }
        if u.scheme == "about" { return true }                 // about:blank 等 WKWebView 内部导航
        guard u.scheme == "http" else { return false }
        let host = u.host ?? ""
        return (host == "127.0.0.1" || host == "localhost") && (u.port ?? 3000) == 3000
    }
    // 导航策略:主框架只许停留在 App 自己的源;点到的外链改用系统浏览器打开(不把任意站点拉进原生壳)。
    // 子框架(预览 iframe)放行 —— 预览功能本就要加载本地 dev / 用户确认的外部地址,且已被 sandbox 隔离。
    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler done: @escaping (WKNavigationActionPolicy) -> Void) {
        let isMain = action.targetFrame?.isMainFrame ?? true    // targetFrame 为 nil = 要开新窗口,按主框架处理
        let u = action.request.url
        if !isMain || isAppOrigin(u) { done(.allow); return }
        // 主框架要跳到外部地址:交给系统浏览器,壳内取消。
        if let u = u, (u.scheme == "http" || u.scheme == "https") { NSWorkspace.shared.open(u) }
        done(.cancel)
    }
    // 加载失败(后端还没起)→ 稍等重试
    func webView(_ w: WKWebView, didFail nav: WKNavigation!, withError e: Error) { retry() }
    func webView(_ w: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError e: Error) { retry() }
    func retry() { DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in self?.load() } }

    // 标准主菜单:App 菜单(隐藏/退出)+ 编辑菜单(撤销/重做/剪切/拷贝/粘贴/全选)。
    // 关键:这些标准动作(用字符串 selector,target=nil)会沿响应链分发到第一响应者=WKWebView 的编辑上下文,
    // Cmd+C/V/X/A 才会生效;否则原生壳里复制粘贴快捷键无效。
    func buildMenu() {
        let mainMenu = NSMenu()
        // App 菜单
        let appItem = NSMenuItem(); mainMenu.addItem(appItem)
        let appMenu = NSMenu(); appItem.submenu = appMenu
        appMenu.addItem(withTitle: "隐藏 CodeWhale", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "退出 CodeWhale", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        // 编辑菜单
        let editItem = NSMenuItem(); mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "编辑"); editItem.submenu = editMenu
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "剪切", action: Selector(("cut:")), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷贝", action: Selector(("copy:")), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: Selector(("paste:")), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: Selector(("selectAll:")), keyEquivalent: "a")
        // 显示菜单:重新载入(⌘R)——拿到界面更新而不必退出重开
        let viewItem = NSMenuItem(); mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: "显示"); viewItem.submenu = viewMenu
        let reloadItem = NSMenuItem(title: "重新载入", action: #selector(reloadPage(_:)), keyEquivalent: "r")
        reloadItem.target = self                       // 指向本 AppDelegate(它持有 webView)
        viewMenu.addItem(reloadItem)
        NSApp.mainMenu = mainMenu
    }
    @objc func reloadPage(_ sender: Any?) { load() }   // 重新加载页面(load() 会带 token 重新拉 :3000)

    // ── JS 对话框(WKUIDelegate)── 用原生 NSAlert 实现 alert()/confirm()/prompt(),挂成 window sheet。
    // 不实现时 WKWebView 默认全部静默失效(confirm 返回 false),导致所有 confirm/alert/prompt 功能点了没反应。
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage msg: String, initiatedByFrame f: WKFrameInfo, completionHandler done: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = "CodeWhale"; a.informativeText = msg; a.addButton(withTitle: "好")
        if let win = (w.window ?? window) { a.beginSheetModal(for: win) { _ in done() } } else { a.runModal(); done() }
    }
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage msg: String, initiatedByFrame f: WKFrameInfo, completionHandler done: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = "CodeWhale"; a.informativeText = msg
        a.addButton(withTitle: "确定"); a.addButton(withTitle: "取消")
        if let win = (w.window ?? window) { a.beginSheetModal(for: win) { r in done(r == .alertFirstButtonReturn) } }
        else { done(a.runModal() == .alertFirstButtonReturn) }
    }
    func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame f: WKFrameInfo, completionHandler done: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = "CodeWhale"; a.informativeText = prompt
        a.addButton(withTitle: "确定"); a.addButton(withTitle: "取消")
        let tf = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24)); tf.stringValue = defaultText ?? ""
        a.accessoryView = tf
        let handle: (NSApplication.ModalResponse) -> Void = { r in done(r == .alertFirstButtonReturn ? tf.stringValue : nil) }
        if let win = (w.window ?? window) { a.beginSheetModal(for: win, completionHandler: handle) } else { handle(a.runModal()) }
    }
    // ── 文件选择面板(WKUIDelegate)── 不实现时 `<input type=file>` 在 WKWebView 里点了静默无效 → 附件 📎 按钮没反应。
    func webView(_ w: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo, completionHandler done: @escaping ([URL]?) -> Void) {
        let p = NSOpenPanel()
        p.canChooseFiles = true
        p.canChooseDirectories = parameters.allowsDirectories
        p.allowsMultipleSelection = parameters.allowsMultipleSelection
        if let win = (w.window ?? window) { p.beginSheetModal(for: win) { r in done(r == .OK ? p.urls : nil) } }
        else { done(p.runModal() == .OK ? p.urls : nil) }
    }

    // ── window.open() → 独立原生窗口(自带最大化/缩放/最小化)。多模型对比可单独开窗、和主页面来回切,不必关掉对比。
    func webView(_ w: WKWebView, createWebViewWith config: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // window.open() 只为本源(?compare=1 独立对比窗)开原生窗口;指向外部地址的一律走系统浏览器,
        // 不把任意站点拉进原生 WKWebView(否则等于给钓鱼/外链一个"看起来像 App"的原生窗)。
        if let u = action.request.url, !isAppOrigin(u) {
            if u.scheme == "http" || u.scheme == "https" { NSWorkspace.shared.open(u) }
            return nil
        }
        config.websiteDataStore = .default()        // 共享 localStorage/cookies(置顶、token、字号等)
        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 780),
                           styleMask: [.titled, .closable, .miniaturizable, .resizable],
                           backing: .buffered, defer: false)
        win.title = "CodeWhale 对比"
        win.center()
        win.isReleasedWhenClosed = false
        let nweb = WKWebView(frame: NSRect(x: 0, y: 0, width: 1180, height: 780), configuration: config)
        nweb.navigationDelegate = self
        nweb.uiDelegate = self
        nweb.allowsBackForwardNavigationGestures = false
        win.contentView = nweb
        win.minSize = NSSize(width: 720, height: 480)
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        extraWindows.append(win)
        if action.request.url != nil { nweb.load(action.request) }   // window.open(url):有的 WebKit 版本不自动 load,手动兜底
        return nweb
    }
    // ── window.close() → 关掉对应的独立窗口。对比窗口的「✕ 退出」按钮调 window.close();不实现此法 WKWebView 不会真的关窗(点了没反应)。
    func webViewDidClose(_ webView: WKWebView) {
        if let win = extraWindows.first(where: { ($0.contentView as? WKWebView) === webView }) {
            extraWindows.removeAll { $0 === win }
            win.close()
        }
    }

    // 点 Dock 图标:已有窗口就前置,没有就重建 —— 原生"复用窗口",不再开重复窗
    func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
        return true
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ a: NSApplication) -> Bool { return true }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)   // 正常 Dock 应用身份
app.run()
