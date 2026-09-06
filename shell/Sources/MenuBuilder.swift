import AppKit
import WebKit

// Builds the native macOS menu bar. Most items either route through the responder chain
// (Cut/Copy/Paste/Undo — handled by WKWebView automatically) or forward synthesized keyboard
// events into the WebView so the existing JS handlers fire.
enum MenuBuilder {
    static func installMenu() {
        let mainMenu = NSMenu()

        mainMenu.addItem(applicationMenuItem())
        mainMenu.addItem(fileMenuItem())
        mainMenu.addItem(editMenuItem())
        mainMenu.addItem(viewMenuItem())
        mainMenu.addItem(windowMenuItem())
        mainMenu.addItem(helpMenuItem())

        NSApp.mainMenu = mainMenu
    }

    // MARK: - Per-menu builders

    private static func applicationMenuItem() -> NSMenuItem {
        let item = NSMenuItem()
        let menu = NSMenu(title: "Todo App")
        menu.addItem(NSMenuItem(title: "About Todo App",
                                action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
                                keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Hide Todo App",
                                action: #selector(NSApplication.hide(_:)),
                                keyEquivalent: "h"))
        let hideOthers = NSMenuItem(title: "Hide Others",
                                    action: #selector(NSApplication.hideOtherApplications(_:)),
                                    keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.option, .command]
        menu.addItem(hideOthers)
        menu.addItem(NSMenuItem(title: "Show All",
                                action: #selector(NSApplication.unhideAllApplications(_:)),
                                keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Todo App",
                                action: #selector(NSApplication.terminate(_:)),
                                keyEquivalent: "q"))
        item.submenu = menu
        return item
    }

    private static func fileMenuItem() -> NSMenuItem {
        let item = NSMenuItem()
        let menu = NSMenu(title: "File")

        menu.addItem(forwardingItem(title: "New Task", keyEquivalent: "n", key: "n"))
        let quickCapture = NSMenuItem(title: "Quick Capture",
                                      action: #selector(GlobalCapture.openInAppOverlay),
                                      keyEquivalent: "t")
        quickCapture.keyEquivalentModifierMask = [.option, .shift]
        quickCapture.target = GlobalCapture.shared
        menu.addItem(quickCapture)
        let newList = forwardingItem(title: "New List…", keyEquivalent: "L", key: "L", modifiers: [.shift])
        newList.keyEquivalentModifierMask = [.command, .shift]
        menu.addItem(newList)
        menu.addItem(.separator())
        menu.addItem(forwardingItem(title: "Refresh", keyEquivalent: "r", key: "r"))

        item.submenu = menu
        return item
    }

    private static func editMenuItem() -> NSMenuItem {
        let item = NSMenuItem()
        let menu = NSMenu(title: "Edit")

        // Standard editing menus — selectors flow through the responder chain to whatever
        // text control has focus (WKWebView handles them for the embedded page).
        menu.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
        menu.addItem(NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "Z"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        menu.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        menu.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        menu.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        menu.addItem(.separator())
        menu.addItem(forwardingItem(title: "Find", keyEquivalent: "f", key: "f", modifiers: [.command]))

        item.submenu = menu
        return item
    }

    private static func viewMenuItem() -> NSMenuItem {
        let item = NSMenuItem()
        let menu = NSMenu(title: "View")

        menu.addItem(forwardingItem(title: "Command Palette", keyEquivalent: "k", key: "k", modifiers: [.command]))
        menu.addItem(.separator())
        menu.addItem(forwardingItem(title: "Toggle Show Completed", keyEquivalent: "", key: "c"))
        menu.addItem(forwardingItem(title: "Cycle Sort Mode", keyEquivalent: "", key: "s"))

        item.submenu = menu
        return item
    }

    private static func windowMenuItem() -> NSMenuItem {
        let item = NSMenuItem()
        let menu = NSMenu(title: "Window")
        menu.addItem(NSMenuItem(title: "Minimize",
                                action: #selector(NSWindow.performMiniaturize(_:)),
                                keyEquivalent: "m"))
        menu.addItem(NSMenuItem(title: "Zoom",
                                action: #selector(NSWindow.performZoom(_:)),
                                keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Close",
                                action: #selector(NSWindow.performClose(_:)),
                                keyEquivalent: "w"))
        item.submenu = menu
        NSApp.windowsMenu = menu
        return item
    }

    private static func helpMenuItem() -> NSMenuItem {
        let item = NSMenuItem()
        let menu = NSMenu(title: "Help")
        menu.addItem(forwardingItem(title: "Keyboard Shortcuts", keyEquivalent: "/", key: "?", modifiers: [.command]))
        item.submenu = menu
        NSApp.helpMenu = menu
        return item
    }

    // MARK: - Forwarding helper

    private static func forwardingItem(title: String,
                                       keyEquivalent: String,
                                       key: String,
                                       modifiers: NSEvent.ModifierFlags = []) -> NSMenuItem {
        let item = NSMenuItem(title: title,
                              action: #selector(MenuActions.forwardKey(_:)),
                              keyEquivalent: keyEquivalent)
        if !modifiers.isEmpty { item.keyEquivalentModifierMask = modifiers }
        item.target = MenuActions.shared
        item.representedObject = ForwardingPayload(key: key, modifiers: modifiers)
        return item
    }
}

// Carries the JS key + modifiers the menu item should dispatch into the WebView.
struct ForwardingPayload {
    let key: String
    let modifiers: NSEvent.ModifierFlags
}

final class MenuActions: NSObject {
    static let shared = MenuActions()

    @objc func forwardKey(_ sender: NSMenuItem) {
        guard let payload = sender.representedObject as? ForwardingPayload else { return }
        forward(key: payload.key, modifiers: payload.modifiers)
    }

    private func forward(key: String, modifiers: NSEvent.ModifierFlags) {
        guard let delegate = NSApp.delegate as? AppDelegate,
              let webView = delegate.webView else { return }

        var mods: [String] = []
        if modifiers.contains(.command) { mods.append("metaKey: true") }
        if modifiers.contains(.shift)   { mods.append("shiftKey: true") }
        if modifiers.contains(.option)  { mods.append("altKey: true") }
        if modifiers.contains(.control) { mods.append("ctrlKey: true") }
        let modPart = mods.isEmpty ? "" : ", " + mods.joined(separator: ", ")

        let escaped = key
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")

        let js = "document.dispatchEvent(new KeyboardEvent('keydown', " +
                 "{key: '\(escaped)', bubbles: true, cancelable: true\(modPart)}));"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }
}
