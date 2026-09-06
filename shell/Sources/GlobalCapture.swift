import AppKit
import Carbon.HIToolbox

// System-wide quick capture. Registers a global hotkey (⌥⇧T — same binding as
// the in-app overlay) via Carbon RegisterEventHotKey, which needs no special
// permissions. When Todo App is frontmost the keystroke is forwarded into the
// WebView so the richer in-app overlay opens; from any other app a small
// floating panel appears, accepts the full quick-add syntax
// ("Buy milk !high ?friday 3pm #grocery ls:todos"), and POSTs it to the
// server's /api/quickadd endpoint (which parses with the same shared
// public/parse.js module as the web UI).
final class GlobalCapture: NSObject, NSWindowDelegate, NSTextFieldDelegate {
    static let shared = GlobalCapture()

    private var serverURL = URL(string: "http://127.0.0.1:4321")!
    private var hotKeyRef: EventHotKeyRef?
    private var panel: NSPanel?
    private var field: NSTextField!
    private var feedback: NSTextField!
    private var closeTimer: Timer?
    private var submitting = false
    private var panelSession = UUID()
    private var draftRevision = 0
    private var retryKeys: [String: String] = [:]

    func install(serverURL: URL) {
        self.serverURL = serverURL
        // Restarting the Node child should update the endpoint without
        // registering a second Carbon handler/hotkey.
        if hotKeyRef != nil { return }
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                      eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ -> OSStatus in
            DispatchQueue.main.async { GlobalCapture.shared.hotkeyPressed() }
            return noErr
        }, 1, &eventType, nil, nil)
        let hotKeyID = EventHotKeyID(signature: OSType(0x54_44_4F_54) /* 'TDOT' */, id: 1)
        RegisterEventHotKey(UInt32(kVK_ANSI_T),
                            UInt32(optionKey | shiftKey),
                            hotKeyID, GetApplicationEventTarget(), 0, &hotKeyRef)
    }

    private func hotkeyPressed() {
        // Panel already up → second press dismisses (toggle).
        if let p = panel, p.isVisible { close(); return }
        // App frontmost with the main window key → open the richer in-app
        // overlay instead (the Carbon hotkey swallows the keystroke before
        // the WebView sees it, so re-dispatch it as a synthetic event).
        if NSApp.isActive,
           let delegate = NSApp.delegate as? AppDelegate,
           let webView = delegate.webView,
           webView.window?.isKeyWindow == true {
            openInAppOverlay()
            return
        }
        showPanel()
    }

    @objc func openInAppOverlay() {
        guard let delegate = NSApp.delegate as? AppDelegate,
              let webView = delegate.webView else { return }
        let js = "document.dispatchEvent(new KeyboardEvent('keydown', " +
                 "{code: 'KeyT', key: 't', altKey: true, shiftKey: true, bubbles: true, cancelable: true}));"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: - Panel

    private func showPanel() {
        if panel == nil { buildPanel() }
        guard let panel = panel else { return }
        panelSession = UUID()
        feedback.stringValue = "↩ add · esc cancel — syntax: !high ?friday 3pm #tag ls:list"
        feedback.textColor = .tertiaryLabelColor
        positionPanel(panel)
        // .nonactivatingPanel: takes key for typing without activating the
        // app, so dismissing returns focus to whatever the user was doing.
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(field)
    }

    private func close() {
        closeTimer?.invalidate()
        closeTimer = nil
        panel?.orderOut(nil)
    }

    private func positionPanel(_ panel: NSPanel) {
        let screen = NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) })
            ?? NSScreen.main
        guard let frame = screen?.visibleFrame else { return }
        let size = panel.frame.size
        let x = frame.midX - size.width / 2
        let y = frame.maxY - frame.height * 0.22 - size.height
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    private func buildPanel() {
        let width: CGFloat = 620, height: CGFloat = 96
        let p = KeyablePanel(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                             styleMask: [.borderless, .nonactivatingPanel],
                             backing: .buffered, defer: false)
        p.level = .floating
        p.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.delegate = self
        p.isReleasedWhenClosed = false

        let card = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        card.wantsLayer = true
        card.layer?.backgroundColor = NSColor(calibratedRed: 0.16, green: 0.165, blue: 0.176, alpha: 1).cgColor
        card.layer?.cornerRadius = 12
        card.layer?.borderWidth = 1
        card.layer?.borderColor = NSColor(calibratedWhite: 1, alpha: 0.12).cgColor

        let f = NSTextField(frame: NSRect(x: 18, y: height - 48, width: width - 36, height: 30))
        f.isBezeled = false
        f.drawsBackground = false
        f.focusRingType = .none
        f.font = .systemFont(ofSize: 17)
        f.textColor = NSColor(calibratedRed: 0.91, green: 0.918, blue: 0.929, alpha: 1)
        f.placeholderAttributedString = NSAttributedString(
            string: "Add a task…",
            attributes: [.foregroundColor: NSColor(calibratedWhite: 0.55, alpha: 1),
                         .font: NSFont.systemFont(ofSize: 17)])
        f.delegate = self
        f.target = self
        f.action = #selector(submit)
        card.addSubview(f)

        let fb = NSTextField(labelWithString: "")
        fb.frame = NSRect(x: 18, y: 14, width: width - 36, height: 18)
        fb.font = .systemFont(ofSize: 12)
        fb.textColor = .tertiaryLabelColor
        fb.lineBreakMode = .byTruncatingTail
        card.addSubview(fb)

        p.contentView = card
        field = f
        feedback = fb
        panel = p
    }

    // MARK: - Submit

    @objc private func submit() {
        guard !submitting else { return }
        let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        submitting = true
        let session = panelSession
        let revision = draftRevision
        let operationId = retryKeys[text] ?? UUID().uuidString
        retryKeys[text] = operationId
        feedback.stringValue = "adding…"
        feedback.textColor = .tertiaryLabelColor

        var req = URLRequest(url: serverURL.appendingPathComponent("api/quickadd"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 65
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["text": text, "operationId": operationId])

        URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.submitting = false
                if err == nil, (resp as? HTTPURLResponse)?.statusCode == 200,
                   let data = data,
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let created = json["created"] as? [String: Any], created["id"] is String,
                   json["parsed"] is [String: Any] {
                    self.retryKeys.removeValue(forKey: text)
                }
                guard session == self.panelSession else { return }
                self.handleResponse(data: data, resp: resp, err: err,
                                    clearDraft: revision == self.draftRevision)
            }
        }.resume()
    }

    private func handleResponse(data: Data?, resp: URLResponse?, err: Error?, clearDraft: Bool) {
        if let err = err {
            showError("couldn’t reach the local server (\(err.localizedDescription))")
            return
        }
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200, let data = data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let parsed = json["parsed"] as? [String: Any] else {
            var detail = "server error (\(status))"
            if let data = data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let msg = json["error"] as? String { detail = msg }
            showError(detail)
            return
        }

        var parts: [String] = []
        if let list = parsed["listName"] as? String, !list.isEmpty { parts.append("→ \(list)") }
        if let dueISO = parsed["dueDate"] as? String, let due = Self.parseISO(dueISO) {
            let fmt = DateFormatter()
            fmt.dateFormat = "EEE MMM d, h:mm a"
            parts.append("due \(fmt.string(from: due))")
        }
        if let pri = parsed["priority"] as? String { parts.append("P\(pri == "high" ? "1" : pri == "medium" ? "2" : "3")") }
        if let recur = parsed["recurrence"] as? String { parts.append("↻ \(recur)") }
        if let bad = parsed["unparsedDate"] as? String {
            parts.append("⚠ “?\(bad)” wasn’t a date — added without one")
        }
        let name = (parsed["name"] as? String) ?? ""
        feedback.stringValue = "✓ \(name)  \(parts.joined(separator: " · "))"
        feedback.textColor = NSColor(calibratedRed: 0.51, green: 0.79, blue: 0.58, alpha: 1)
        if clearDraft { field.stringValue = "" }

        // Linger briefly so the confirmation is readable, then dismiss —
        // unless the user has started typing the next task.
        closeTimer?.invalidate()
        closeTimer = Timer.scheduledTimer(withTimeInterval: 1.2, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            if self.field.stringValue.isEmpty { self.close() }
        }
    }

    private func showError(_ msg: String) {
        feedback.stringValue = "✗ \(msg)"
        feedback.textColor = NSColor(calibratedRed: 0.95, green: 0.55, blue: 0.51, alpha: 1)
    }

    private static func parseISO(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    // MARK: - NSTextFieldDelegate / NSWindowDelegate

    func controlTextDidChange(_ notification: Notification) { draftRevision += 1 }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.cancelOperation(_:)) { close(); return true }
        return false
    }

    func windowDidResignKey(_ notification: Notification) {
        // Clicking elsewhere dismisses the panel (Spotlight-style).
        close()
    }
}

private final class KeyablePanel: NSPanel {
    override var canBecomeKey: Bool { true }
}
