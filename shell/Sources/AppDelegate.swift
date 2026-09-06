import AppKit
import WebKit
import ServiceManagement

@main
final class TodoApp {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var statusLabel: NSTextField!
    var webView: WKWebView?
    var mainWindowController: MainWindow?
    var serverManager: ServerManager!

    // Where the Node project (server.js + the daemon + public/) lives. The app
    // bundle normally sits INSIDE that checkout at
    //   <project>/shell/build/Todo.app/Contents/MacOS/Todo
    // so we can find the project by walking 6 levels up. But once the bundle is
    // copied out (e.g. dragged to /Applications) that walk lands at "/", so we
    // fall back to a folder the user pointed us at once and remembered. See
    // resolveProjectRoot().
    private static let projectRootDefaultsKey = "com.tao.todo.projectRootPath"

    // The in-place location: 6 levels up from the executable. Symlinked launches
    // (Spotlight via ~/Applications/Todo.app → the real bundle) resolve to the
    // real path here too, so this stays correct for the normal dev setup.
    private func bundledProjectRoot() -> URL {
        Bundle.main.executableURL!
            .deletingLastPathComponent()  // …/MacOS
            .deletingLastPathComponent()  // …/Contents
            .deletingLastPathComponent()  // …/Todo.app
            .deletingLastPathComponent()  // …/build
            .deletingLastPathComponent()  // …/shell
            .deletingLastPathComponent()  // …/<project>
    }

    private func hasServer(_ root: URL) -> Bool {
        FileManager.default.fileExists(atPath: root.appendingPathComponent("server.js").path)
    }

    // Find the project folder, prompting the user once if the bundle was moved
    // out of the checkout. Returns nil only if the user declines to locate it.
    private func resolveProjectRoot() -> URL? {
        // 1. In-place / symlinked launch — the common case, no prompt.
        let bundled = bundledProjectRoot()
        if hasServer(bundled) { return bundled }
        // 2. A folder the user chose on a previous relocated launch.
        if let saved = UserDefaults.standard.string(forKey: Self.projectRootDefaultsKey) {
            let url = URL(fileURLWithPath: saved)
            if hasServer(url) { return url }
        }
        // 3. Ask the user to point at the checkout, then remember it.
        guard let picked = promptForProjectRoot() else { return nil }
        UserDefaults.standard.set(picked.path, forKey: Self.projectRootDefaultsKey)
        return picked
    }

    private func promptForProjectRoot() -> URL? {
        let alert = NSAlert()
        alert.messageText = "Locate the Todo App project folder"
        alert.informativeText = "Todo App runs a small local server from the project folder you built it from (the todo-app repo, which contains server.js). Because this app was moved out of that folder, point it there once and it'll be remembered."
        alert.addButton(withTitle: "Choose Folder…")
        alert.addButton(withTitle: "Quit")
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }

        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Use This Folder"
        panel.message = "Select the todo-app project folder (it contains server.js)."
        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        if hasServer(url) { return url }

        let wrong = NSAlert()
        wrong.messageText = "That folder doesn't contain server.js"
        wrong.informativeText = "Please choose the todo-app project folder itself (the one with server.js in it)."
        wrong.addButton(withTitle: "Try Again")
        wrong.addButton(withTitle: "Quit")
        guard wrong.runModal() == .alertFirstButtonReturn else { return nil }
        return promptForProjectRoot()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        AppIcon.install()
        MenuBuilder.installMenu()
        createWindow()
        showStartingState()
        startServer()
        registerLoginItemOnce()
    }

    // Register as a login item so ⌥⇧T capture is available right after a
    // reboot without manually launching the app. One-shot (guarded by a
    // defaults flag): if the user later removes it in System Settings →
    // General → Login Items, we must not silently re-add it on next launch.
    private func registerLoginItemOnce() {
        let key = "com.tao.todo.didRegisterLoginItem"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        if #available(macOS 13.0, *) {
            do {
                try SMAppService.mainApp.register()
                UserDefaults.standard.set(true, forKey: key)
                NSLog("Todo App: registered as login item")
            } catch {
                NSLog("Todo App: login-item registration failed: \(error.localizedDescription)")
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // Closing the window must NOT quit: the app keeps running in the
        // background (Dock icon stays) so the system-wide ⌥⇧T capture and the
        // local server stay available. ⌘Q quits fully; clicking the Dock icon
        // brings the window back.
        return false
    }

    func applicationWillTerminate(_ notification: Notification) {
        serverManager?.stop()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            window.makeKeyAndOrderFront(nil)
        }
        return true
    }

    // MARK: - Window setup

    private func createWindow() {
        let frame = NSRect(x: 0, y: 0, width: 1100, height: 720)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Todo App"
        // Merge the title bar into the app: transparent, no title text, no
        // separator hairline — the traffic lights float over a strip that
        // matches the web UI's background, so the window reads as one surface.
        // (Not .fullSizeContentView: keeping the strip its own region preserves
        // native window dragging, which the WKWebView would otherwise eat.)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        if #available(macOS 11.0, *) { window.titlebarSeparatorStyle = .none }
        // Dynamic ink/paper matching style.css --bg (dark #181614, light #f4efe5).
        window.backgroundColor = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(srgbRed: 0.094, green: 0.086, blue: 0.078, alpha: 1)
                : NSColor(srgbRed: 0.957, green: 0.937, blue: 0.898, alpha: 1)
        }
        window.minSize = NSSize(width: 720, height: 480)
        // The window outlives its closes (app keeps running in background) —
        // without this, AppKit releases it on close and reopening crashes.
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("com.tao.todo.shell.MainWindow")
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func showStartingState() {
        let container = NSView(frame: window.contentView!.bounds)
        container.autoresizingMask = [.width, .height]

        statusLabel = NSTextField(labelWithString: "Starting Todo App…")
        statusLabel.font = .systemFont(ofSize: 14, weight: .regular)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(statusLabel)

        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.startAnimation(nil)
        spinner.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(spinner)

        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: container.centerYAnchor, constant: -12),
            statusLabel.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            statusLabel.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 12),
        ])
        window.contentView = container
    }

    // MARK: - Server lifecycle

    private func startServer() {
        guard let root = resolveProjectRoot() else {
            Task { @MainActor in
                self.showError(NSError(domain: "TodoApp", code: 1, userInfo: [NSLocalizedDescriptionKey:
                    "Couldn't find the Todo App project folder (the one containing server.js). Rebuild the app in place, or relaunch and point it at your todo-app checkout."]))
            }
            return
        }
        serverManager = ServerManager(projectRoot: root)
        Task.detached { [weak self] in
            guard let self = self else { return }
            do {
                try await self.serverManager.start()
                await MainActor.run {
                    // Only watch for unexpected death after a successful
                    // start — startup failures already surface via showError.
                    self.serverManager.onUnexpectedExit = { [weak self] in
                        Task { @MainActor in self?.handleServerDied() }
                    }
                    // The preferred port may have been occupied. Point both
                    // the WebView and the system-wide capture panel at the
                    // exact server this launch owns.
                    GlobalCapture.shared.install(serverURL: self.serverManager.serverURL)
                    self.swapToWebView()
                }
            } catch {
                await MainActor.run { self.showError(error) }
            }
        }
    }

    @MainActor
    private func handleServerDied() {
        let alert = NSAlert()
        alert.messageText = "Todo App's background server stopped"
        alert.informativeText = "The local server quit unexpectedly. Restart it? (Log: \(ServerManager.logURL.path))"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Restart")
        alert.addButton(withTitle: "Quit")
        if alert.runModal() == .alertFirstButtonReturn {
            showStartingState()
            startServer()
        } else {
            NSApp.terminate(nil)
        }
    }

    @MainActor
    private func swapToWebView() {
        let mw = MainWindow(window: window, serverURL: serverManager.serverURL)
        mw.install()
        self.webView = mw.webView
        self.mainWindowController = mw
    }

    @MainActor
    private func showError(_ error: Error) {
        let alert = NSAlert()
        alert.messageText = "Todo App couldn't start"
        alert.informativeText = error.localizedDescription
        alert.alertStyle = .critical
        alert.addButton(withTitle: "Quit")
        alert.addButton(withTitle: "Show log")
        let response = alert.runModal()
        if response == .alertSecondButtonReturn {
            NSWorkspace.shared.open(ServerManager.logURL)
        }
        NSApp.terminate(nil)
    }
}
