// CodeWhale 原生 macOS 壳 — WKWebView 指向本地 GUI(127.0.0.1:3000),无 Chrome、无 chrome-profile。
import Cocoa
import WebKit
import Speech
import AVFoundation
import Darwin

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

func wakeManagedService(_ label: String) -> Bool {
    let target = "gui/\(getuid())/\(label)"
    guard sh("launchctl print '\(target)' >/dev/null 2>&1") == 0 else { return false }
    sh("launchctl kickstart '\(target)' >/dev/null 2>&1 || true", wait: false)
    return true
}

func ensureServices() {
    if !ping("http://127.0.0.1:7878/health") {
        if !wakeManagedService("com.codewhale.appserver") {
            sh("cd \"$HOME\" && NO_COLOR=1 TERM=dumb nohup codewhale app-server --http --host 127.0.0.1 --port 7878 --insecure-no-auth >/dev/null 2>>\"$HOME/codewhale-gui/app-server.err.log\" &", wait: false)
        }
    }
    if !ping("http://127.0.0.1:3000/") {
        if !wakeManagedService("com.codewhale.frontend") {
            sh("nohup python3 \"$HOME/codewhale-gui/server.py\" >\"$HOME/codewhale-gui/webserver.log\" 2>&1 &", wait: false)
        }
    }
    for _ in 0..<40 { if ping("http://127.0.0.1:3000/") { break }; usleep(400_000) }
}

class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    var extraWindows: [NSWindow] = []   // window.open() 开的独立窗口(多模型对比单独开窗),保留引用避免被释放
    var fnMonitor: Any?
    var fnPressed = false
    var voiceStartWork: DispatchWorkItem?
    var voiceFinishWork: DispatchWorkItem?
    var voiceTargetWeb: WKWebView?
    let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
    let audioEngine = AVAudioEngine()
    var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    var recognitionTask: SFSpeechRecognitionTask?
    var voiceTranscript = ""
    var voiceRecording = false
    var voiceStopping = false
    var voiceDelivered = false
    var voiceButtonActive = false

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()      // 没主菜单 → Cmd+C/V/X/A 无处分发,文本框复制粘贴失灵
        ensureServices()
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()            // 持久化 localStorage(置顶/token 缓存)
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")  // 右键可"检查元素"
        cfg.userContentController.add(self, name: "voiceControl")
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
        installVoiceShortcut()
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
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self, weak webView] in
            guard let self = self, let webView = webView else { return }
            if webView.url != nil { webView.reload() }
            else if webView === self.web { self.load() }
        }
    }
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

    // ── 按住 Fn 语音输入 ──
    // WKWebView 通常拿不到 Fn/Globe 修饰键,所以由原生壳监听 flagsChanged。
    // 仅 App 在前台时生效;按住 180ms 后开始,松开后结束,避免轻触误触。
    func installVoiceShortcut() {
        guard fnMonitor == nil else { return }
        fnMonitor = NSEvent.addLocalMonitorForEvents(matching: [.flagsChanged]) { [weak self] event in
            self?.handleModifierFlags(event)
            return event
        }
    }

    func activeWebView() -> WKWebView? {
        if let w = NSApp.keyWindow?.contentView as? WKWebView { return w }
        return web
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "voiceControl",
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }
        voiceTargetWeb = message.webView ?? activeWebView()
        if action == "start" {
            voiceButtonActive = true
            authorizeAndStartVoice()
        } else if action == "stop" {
            voiceButtonActive = false
            if voiceRecording { stopVoiceCapture() }
            else if !voiceStopping { emitVoice(["state": "ready", "message": "语音输入已停止"]) }
        }
    }

    func voiceIntentActive() -> Bool { fnPressed || voiceButtonActive }

    func handleModifierFlags(_ event: NSEvent) {
        let down = event.modifierFlags.intersection(.deviceIndependentFlagsMask).contains(.function)
        if down == fnPressed { return }
        fnPressed = down
        if down {
            guard NSApp.isActive else { return }
            voiceTargetWeb = activeWebView()
            voiceStartWork?.cancel()
            let work = DispatchWorkItem { [weak self] in
                guard let self = self, self.fnPressed, NSApp.isActive else { return }
                self.authorizeAndStartVoice()
            }
            voiceStartWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.18, execute: work)
        } else {
            voiceStartWork?.cancel()
            voiceStartWork = nil
            if voiceRecording { stopVoiceCapture() }
        }
    }

    func authorizeAndStartVoice() {
        requestSpeechAuthorization { [weak self] speechStatus in
            guard let self = self else { return }
            guard speechStatus == .authorized else {
                self.voiceButtonActive = false
                if speechStatus == .restricted {
                    self.emitVoice(["state": "error", "message": "这台 Mac 的语音识别权限受系统策略限制"])
                } else {
                    self.emitVoice(["state": "error", "message": "语音识别权限未开启,正在打开系统设置"])
                    self.openPrivacySettings("Privacy_SpeechRecognition")
                }
                return
            }
            self.requestMicrophoneAuthorization { [weak self] micStatus in
                guard let self = self else { return }
                guard micStatus == .authorized else {
                    self.voiceButtonActive = false
                    if micStatus == .restricted {
                        self.emitVoice(["state": "error", "message": "这台 Mac 的麦克风权限受系统策略限制"])
                    } else {
                        self.emitVoice(["state": "error", "message": "麦克风权限未开启,正在打开系统设置"])
                        self.openPrivacySettings("Privacy_Microphone")
                    }
                    return
                }
                guard self.voiceIntentActive(), NSApp.isActive else {
                    self.emitVoice(["state": "ready", "message": "权限已就绪,请再次按住 Fn 或点击麦克风"])
                    return
                }
                self.startVoiceCapture()
            }
        }
    }

    func openPrivacySettings(_ pane: String) {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { NSWorkspace.shared.open(url) }
    }

    func requestSpeechAuthorization(_ done: @escaping (SFSpeechRecognizerAuthorizationStatus) -> Void) {
        let current = SFSpeechRecognizer.authorizationStatus()
        switch current {
        case .notDetermined:
            SFSpeechRecognizer.requestAuthorization { status in
                DispatchQueue.main.async { done(status) }
            }
        default: done(current)
        }
    }

    func requestMicrophoneAuthorization(_ done: @escaping (AVAuthorizationStatus) -> Void) {
        let current = AVCaptureDevice.authorizationStatus(for: .audio)
        switch current {
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { _ in
                DispatchQueue.main.async { done(AVCaptureDevice.authorizationStatus(for: .audio)) }
            }
        default: done(current)
        }
    }

    func startVoiceCapture() {
        guard !voiceRecording else { return }
        guard let recognizer = speechRecognizer, recognizer.isAvailable else {
            voiceButtonActive = false
            emitVoice(["state": "error", "message": "当前语音识别服务不可用"])
            return
        }
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        voiceFinishWork?.cancel()
        voiceTranscript = ""
        voiceStopping = false
        voiceDelivered = false

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        recognitionRequest = request
        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            voiceButtonActive = false
            emitVoice(["state": "error", "message": "没有检测到可用的麦克风输入"])
            return
        }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak request] buffer, _ in
            request?.append(buffer)
        }
        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            input.removeTap(onBus: 0)
            voiceButtonActive = false
            emitVoice(["state": "error", "message": "麦克风启动失败"])
            return
        }
        voiceRecording = true
        emitVoice(["state": "recording"])
        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self = self, !self.voiceDelivered else { return }
                if let result = result {
                    let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !text.isEmpty {
                        self.voiceTranscript = text
                        self.emitVoice(["state": self.voiceStopping ? "processing" : "partial", "text": text])
                    }
                    if result.isFinal { self.finishVoiceTranscript() }
                }
                if error != nil {
                    if self.voiceStopping, !self.voiceTranscript.isEmpty { self.finishVoiceTranscript() }
                    else if self.voiceRecording { self.cancelVoiceCapture(message: "语音识别中断,请重试") }
                }
            }
        }
    }

    func stopVoiceCapture() {
        guard voiceRecording else { return }
        voiceRecording = false
        voiceStopping = true
        if audioEngine.isRunning { audioEngine.stop() }
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        emitVoice(["state": "processing", "text": voiceTranscript])
        voiceFinishWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.finishVoiceTranscript() }
        voiceFinishWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2, execute: work)
    }

    func finishVoiceTranscript() {
        guard !voiceDelivered else { return }
        voiceDelivered = true
        voiceFinishWork?.cancel()
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        voiceRecording = false
        voiceStopping = false
        voiceButtonActive = false
        let text = voiceTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { emitVoice(["state": "error", "message": "没有听清,请重试"]); return }
        emitVoice(["state": "final", "text": text])
    }

    func cancelVoiceCapture(message: String? = nil) {
        voiceFinishWork?.cancel()
        if audioEngine.isRunning { audioEngine.stop() }
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        voiceRecording = false
        voiceStopping = false
        voiceButtonActive = false
        voiceDelivered = true
        if let message = message { emitVoice(["state": "error", "message": message]) }
    }

    func emitVoice(_ detail: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(detail),
              let data = try? JSONSerialization.data(withJSONObject: detail),
              let json = String(data: data, encoding: .utf8) else { return }
        let js = "window.dispatchEvent(new CustomEvent('codewhale:voice',{detail:\(json)}));"
        (voiceTargetWeb ?? activeWebView())?.evaluateJavaScript(js, completionHandler: nil)
    }

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
        // Keep this synchronous. With beginSheetModal, a window that is switching/closing or
        // already owns another sheet can return from this delegate without retaining WebKit's
        // completion handler. WebKit then aborts the whole app in CompletionHandlerCallChecker.
        // runModal drives its own event loop and guarantees exactly one completion before return.
        done(p.runModal() == .OK ? p.urls : nil)
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
        let isCompare = action.request.url.flatMap {
            URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems
        }?.contains(where: { $0.name == "compare" && $0.value == "1" }) == true
        win.title = isCompare ? "CodeWhale 对比" : "CodeWhale"
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
    func applicationDidResignActive(_ notification: Notification) {
        voiceStartWork?.cancel()
        fnPressed = false
        if voiceRecording { cancelVoiceCapture(message: nil) }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ a: NSApplication) -> Bool { return false }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)   // 正常 Dock 应用身份
app.run()
