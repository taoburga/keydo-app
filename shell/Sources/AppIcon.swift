import AppKit

// Programmatic yin-yang icon. Drawn into a 1024×1024 NSImage and assigned as the
// running app's dock icon. (Static Finder/Spotlight icon would need a bundled .icns —
// a follow-up if the placeholder ever bothers anyone.)
enum AppIcon {
    static func install() {
        NSApp.applicationIconImage = makeYinYangImage()
    }

    static func makeYinYangImage(size: CGFloat = 1024) -> NSImage {
        let image = NSImage(size: NSSize(width: size, height: size))
        image.lockFocus()

        let cx = size / 2
        let cy = size / 2
        let r  = size * 0.42

        // Soft off-white background tile so the icon reads against any dock theme.
        NSColor(white: 0.97, alpha: 1.0).setFill()
        NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: size, height: size),
                     xRadius: size * 0.22,
                     yRadius: size * 0.22).fill()

        // White outer disc (the white fish base).
        NSColor.white.setFill()
        NSBezierPath(ovalIn: NSRect(x: cx - r, y: cy - r, width: r*2, height: r*2)).fill()

        // Black S-region: right half of the disc, plus a bump out on top (right of midline)
        // and a scoop in on the bottom (left of midline).
        NSColor.black.setFill()
        let path = NSBezierPath()
        path.appendArc(withCenter: NSPoint(x: cx, y: cy), radius: r,
                       startAngle: 90, endAngle: -90, clockwise: true)
        path.appendArc(withCenter: NSPoint(x: cx, y: cy - r/2), radius: r/2,
                       startAngle: 270, endAngle: 90, clockwise: false)
        path.appendArc(withCenter: NSPoint(x: cx, y: cy + r/2), radius: r/2,
                       startAngle: 270, endAngle: 90, clockwise: true)
        path.close()
        path.fill()

        // Outer rim for definition at small dock sizes.
        NSColor.black.setStroke()
        let rim = NSBezierPath(ovalIn: NSRect(x: cx - r, y: cy - r, width: r*2, height: r*2))
        rim.lineWidth = 4
        rim.stroke()

        // Two eyes (the yin within yang and yang within yin).
        let dotR = r * 0.13
        // Black dot in the upper white field
        NSColor.black.setFill()
        NSBezierPath(ovalIn: NSRect(x: cx - dotR, y: cy + r/2 - dotR,
                                    width: dotR*2, height: dotR*2)).fill()
        // White dot in the lower black field
        NSColor.white.setFill()
        NSBezierPath(ovalIn: NSRect(x: cx - dotR, y: cy - r/2 - dotR,
                                    width: dotR*2, height: dotR*2)).fill()

        image.unlockFocus()
        return image
    }
}
