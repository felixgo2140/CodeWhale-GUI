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

class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()      // 没主菜单 → Cmd+C/V/X/A 无处分发,文本框复制粘贴失灵
        ensureServices()
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()            // 持久化 localStorage(置顶/token 缓存)
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")  // 右键可"检查元素"
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 800), configuration: cfg)
        web.navigationDelegate = self
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
        NSApp.mainMenu = mainMenu
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
