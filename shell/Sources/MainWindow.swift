import AppKit
import WebKit

private func hasSameOrigin(_ url: URL, as trustedURL: URL) -> Bool {
    func effectivePort(_ value: URL) -> Int? {
        if let port = value.port { return port }
        switch value.scheme?.lowercased() {
        case "http": return 80
        case "https": return 443
        default: return nil
        }
    }

    return url.scheme?.lowercased() == trustedURL.scheme?.lowercased()
        && url.host?.lowercased() == trustedURL.host?.lowercased()
        && effectivePort(url) == effectivePort(trustedURL)
}

// Owns the WKWebView that hosts the existing web UI.
// Replaces the window's content view (which initially shows the splash) once the server is up.
final class MainWindow: NSObject, WKNavigationDelegate, WKUIDelegate {
    let window: NSWindow
    let serverURL: URL
    let webView: WKWebView

    init(window: NSWindow, serverURL: URL) {
        self.window = window
        self.serverURL = serverURL

        let config = WKWebViewConfiguration()
        // Default preferences are fine — JS enabled, content blockers off.
        // Allow text input, file dragging, etc.
        let frame = window.contentView?.bounds ?? NSRect(x: 0, y: 0, width: 1100, height: 720)
        self.webView = WKWebView(frame: frame, configuration: config)
        webView.allowsBackForwardNavigationGestures = false
        webView.translatesAutoresizingMaskIntoConstraints = false

        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
    }

    func install() {
        let container = NSView(frame: window.contentView!.bounds)
        container.autoresizingMask = [.width, .height]
        container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        ])
        window.contentView = container
        webView.load(URLRequest(url: serverURL))
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow); return
        }
        // Trust only this app's server, not every service listening on localhost.
        if hasSameOrigin(url, as: serverURL) || url.scheme?.lowercased() == "about" {
            decisionHandler(.allow); return
        }
        // Open user-clicked external links in the default browser. Block redirects
        // and programmatic navigation away from the app origin.
        if navigationAction.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel); return
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Without this, the WebView starts un-focused at the AppKit level —
        // keystrokes go to the responder chain (which has no shortcut for
        // them) and AppKit plays the system beep until the user clicks
        // inside the page.
        window.makeFirstResponder(webView)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showLoadFailure(error)
    }

    // Connection-refused (server dead at load/reload time) is a *provisional*
    // navigation failure — without this delegate it would be a silent blank
    // window.
    func webView(_ webView: WKWebView,
                 didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        showLoadFailure(error)
    }

    // WebKit's content process crashed → the view goes permanently white
    // unless we reload it.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    private func showLoadFailure(_ error: Error) {
        let nsError = error as NSError
        // Benign: explicit cancellations and policy-cancelled navigations
        // (e.g. an external link we route to the default browser).
        if nsError.code == NSURLErrorCancelled && nsError.domain == NSURLErrorDomain { return }
        if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return }
        let alert = NSAlert()
        alert.messageText = "Couldn't load Todo App"
        alert.informativeText = error.localizedDescription
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Retry")
        alert.addButton(withTitle: "Quit")
        if alert.runModal() == .alertFirstButtonReturn {
            webView.load(URLRequest(url: serverURL))
        } else {
            NSApp.terminate(nil)
        }
    }

    // MARK: - WKUIDelegate (window.open targets)

    // Retains pop-out windows (e.g. the briefing's "open in window") until closed.
    private var popouts: [PopoutWindow] = []

    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        // Our own pages become real app windows (WebKit loads the request into
        // the returned webview, which MUST be built from the configuration it
        // hands us). Anything else keeps going to the default browser.
        if hasSameOrigin(url, as: serverURL) {
            let pop = PopoutWindow(configuration: configuration, serverURL: serverURL)
            pop.onClose = { [weak self] closed in
                self?.popouts.removeAll { $0 === closed }
            }
            popouts.append(pop)
            pop.window.makeKeyAndOrderFront(nil)
            return pop.webView
        }
        if url.scheme?.lowercased() != "about",
           navigationAction.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
        }
        return nil
    }
}

// A secondary window hosting one of our own pages (briefing pop-out). Small,
// resizable, independent of the main window; closing it just closes it.
final class PopoutWindow: NSObject, WKNavigationDelegate, WKUIDelegate {
    let window: NSWindow
    let webView: WKWebView
    let serverURL: URL
    var onClose: ((PopoutWindow) -> Void)?

    init(configuration: WKWebViewConfiguration, serverURL: URL) {
        webView = WKWebView(frame: .zero, configuration: configuration)
        self.serverURL = serverURL
        webView.allowsBackForwardNavigationGestures = false
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 540, height: 720),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "briefing"
        window.isReleasedWhenClosed = false   // we manage lifetime via onClose
        window.center()
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.frame = window.contentView!.bounds
        webView.autoresizingMask = [.width, .height]
        window.contentView!.addSubview(webView)
        NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification,
                                               object: window, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.onClose?(self)
        }
    }

    // Same link policy as the main window: our pages navigate, external links
    // open in the default browser.
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow); return
        }
        if hasSameOrigin(url, as: serverURL) || url.scheme?.lowercased() == "about" {
            decisionHandler(.allow); return
        }
        if navigationAction.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel); return
        }
        decisionHandler(.cancel)
    }

    // window.close() from the page closes the native window.
    func webViewDidClose(_ webView: WKWebView) { window.close() }

    // Nested window.open from a pop-out: external → browser, own pages ignored
    // (the pop-out page has no reason to spawn more windows).
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url,
           !hasSameOrigin(url, as: serverURL),
           url.scheme?.lowercased() != "about",
           navigationAction.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
        }
        return nil
    }
}
