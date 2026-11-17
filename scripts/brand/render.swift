// Renders Honk's brand assets with CoreGraphics (macOS, no extra tools):
//   brand/                       logo SVGs and PNGs
//   ios/App/Assets.xcassets      the iOS app icon
//   public/appstore/             App Store images, 1320x2868 (6.9" iPhone)
// Usage: swift scripts/brand/render.swift <screens dir>
// The screens come from scripts/brand/capture-screens.sh.
import AppKit
import CoreText

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
let screens = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : root.appendingPathComponent("build/screens").path)

// MARK: colours

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: a)
}

let ink = rgb(0x1c1c1e)
let badge = rgb(0xff5a36)
let white = rgb(0xffffff)

// MARK: the mark (logo C: an H with an unread badge), on a 100-unit grid

/// The mark's shapes, shared by the PNG renderer and the SVG writer.
struct Mark {
    static let bars: [(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)] = [ // x, y, w, h, r
        (27, 27, 12, 48, 6), (57, 27, 12, 48, 6), (27, 45, 42, 11, 5.5),
    ]
    static let badgeCenter = CGPoint(x: 74, y: 27)
    static let badgeRadius: CGFloat = 11
    static let badgeRing: CGFloat = 4 // the cut-out around the badge, in the background colour

    static func draw(_ cx: CGContext, in rect: CGRect, background: CGColor, cornerRadius: CGFloat?) {
        let s = rect.width / 100
        cx.saveGState()
        cx.translateBy(x: rect.minX, y: rect.minY)
        cx.scaleBy(x: s, y: s)
        let bg = CGRect(x: 0, y: 0, width: 100, height: 100)
        cx.setFillColor(background)
        if let r = cornerRadius {
            cx.addPath(CGPath(roundedRect: bg, cornerWidth: r, cornerHeight: r, transform: nil))
            cx.fillPath()
        } else {
            cx.fill(bg)
        }
        cx.setFillColor(white)
        for (x, y, w, h, r) in bars {
            cx.addPath(CGPath(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerWidth: r, cornerHeight: r, transform: nil))
        }
        cx.fillPath()
        let ring = badgeRadius + badgeRing / 2
        cx.setFillColor(background)
        cx.fillEllipse(in: CGRect(x: badgeCenter.x - ring, y: badgeCenter.y - ring, width: ring * 2, height: ring * 2))
        cx.setFillColor(badge)
        cx.fillEllipse(in: CGRect(x: badgeCenter.x - badgeRadius, y: badgeCenter.y - badgeRadius, width: badgeRadius * 2, height: badgeRadius * 2))
        cx.restoreGState()
    }

    static func svg(rounded: Bool) -> String {
        let bg = rounded ? ##"<rect width="100" height="100" rx="22" fill="#1c1c1e"/>"## : ##"<rect width="100" height="100" fill="#1c1c1e"/>"##
        let barsSVG = bars.map { ##"<rect x="\##(n($0.0))" y="\##(n($0.1))" width="\##(n($0.2))" height="\##(n($0.3))" rx="\##(n($0.4))" fill="#fff"/>"## }.joined()
        return """
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="Honk">\(bg)\(barsSVG)<circle cx="74" cy="27" r="11" fill="#ff5a36" stroke="#1c1c1e" stroke-width="4"/></svg>

        """
    }

    static func n(_ v: CGFloat) -> String { v == v.rounded() ? String(Int(v)) : String(describing: v) }
}

// MARK: drawing helpers (top-left origin)

func canvas(_ w: Int, _ h: Int, _ draw: (CGContext) -> Void) -> Data {
    let cx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                       space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    cx.translateBy(x: 0, y: CGFloat(h))
    cx.scaleBy(x: 1, y: -1)
    let ns = NSGraphicsContext(cgContext: cx, flipped: true)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = ns
    draw(cx)
    NSGraphicsContext.restoreGraphicsState()
    let rep = NSBitmapImageRep(cgImage: cx.makeImage()!)
    return rep.representation(using: .png, properties: [:])!
}

func write(_ data: Data, _ path: String) {
    let url = root.appendingPathComponent(path)
    try! FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try! data.write(to: url)
    print("wrote", path)
}

func write(_ text: String, _ path: String) { write(Data(text.utf8), path) }

func font(_ size: CGFloat, _ weight: NSFont.Weight) -> NSFont {
    let name: String
    switch weight {
    case .bold, .heavy, .black: name = "PingFangSC-Semibold"
    case .semibold, .medium: name = "PingFangSC-Medium"
    default: name = "PingFangSC-Regular"
    }
    return NSFont(name: name, size: size) ?? NSFont.systemFont(ofSize: size, weight: weight)
}

/// Draws `text` centred in `rect` (wrapping), top-aligned.
func text(_ s: String, _ rect: CGRect, size: CGFloat, weight: NSFont.Weight, color: CGColor, align: NSTextAlignment = .center, lineHeight: CGFloat? = nil) {
    let para = NSMutableParagraphStyle()
    para.alignment = align
    if let lineHeight { para.minimumLineHeight = lineHeight; para.maximumLineHeight = lineHeight }
    NSAttributedString(string: s, attributes: [
        .font: font(size, weight), .foregroundColor: NSColor(cgColor: color)!, .paragraphStyle: para, .kern: -0.5,
    ]).draw(with: rect, options: [.usesLineFragmentOrigin])
}

/// Draws an image the right way up in a flipped context.
func image(_ cx: CGContext, _ img: CGImage, in rect: CGRect) {
    cx.saveGState()
    cx.translateBy(x: rect.minX, y: rect.maxY)
    cx.scaleBy(x: 1, y: -1)
    cx.draw(img, in: CGRect(origin: .zero, size: rect.size))
    cx.restoreGState()
}

func load(_ name: String) -> CGImage {
    let url = screens.appendingPathComponent(name)
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
        fatalError("missing \(url.path): run scripts/brand/capture-screens.sh first")
    }
    // The macOS capture includes the window's 1 px top edge; drop it.
    return img.cropping(to: CGRect(x: 0, y: 2, width: img.width, height: img.height - 2)) ?? img
}

func symbol(_ name: String, size: CGFloat, color: CGColor) -> CGImage? {
    let cfg = NSImage.SymbolConfiguration(pointSize: size, weight: .semibold).applying(.init(paletteColors: [NSColor(cgColor: color)!]))
    guard let img = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(cfg) else { return nil }
    var r = CGRect(origin: .zero, size: img.size)
    return img.cgImage(forProposedRect: &r, context: nil, hints: nil)
}

// MARK: logo and icon

write(Mark.svg(rounded: true), "brand/honk-icon.svg")
write(Mark.svg(rounded: false), "brand/honk-icon-square.svg")
write("""
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 100" role="img" aria-label="Honk"><g>\(Mark.svg(rounded: true).replacingOccurrences(of: ##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="Honk">"##, with: "").replacingOccurrences(of: "</svg>\n", with: ""))</g><text x="124" y="70" font-family="-apple-system, 'SF Pro Display', 'Helvetica Neue', sans-serif" font-size="58" font-weight="700" letter-spacing="-1" fill="#1c1c1e">Honk</text></svg>

""", "brand/honk-wordmark.svg")

for size in [1024, 512, 256, 128] {
    write(canvas(size, size) { cx in
        Mark.draw(cx, in: CGRect(x: 0, y: 0, width: size, height: size), background: ink, cornerRadius: 22)
    }, "brand/honk-icon-\(size).png")
}

// iOS: one full-bleed 1024 icon; the system rounds it.
let appIcon = canvas(1024, 1024) { cx in Mark.draw(cx, in: CGRect(x: 0, y: 0, width: 1024, height: 1024), background: ink, cornerRadius: nil) }
write(appIcon, "ios/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png")
write("""
{
  "images" : [
    { "filename" : "AppIcon-1024.png", "idiom" : "universal", "platform" : "ios", "size" : "1024x1024" }
  ],
  "info" : { "author" : "xcode", "version" : 1 }
}

""", "ios/App/Assets.xcassets/AppIcon.appiconset/Contents.json")
write("""
{
  "info" : { "author" : "xcode", "version" : 1 }
}

""", "ios/App/Assets.xcassets/Contents.json")

// Android adaptive icon layers, 432 px (108 dp at xxxhdpi): the mark's
// foreground inside the 66 dp safe zone, on the ink background.
write(canvas(432, 432) { cx in
    let safe: CGFloat = 432 * 66 / 108
    let inset = (432 - safe) / 2
    // Draw the mark without its background: background clear, then the shapes.
    cx.clear(CGRect(x: 0, y: 0, width: 432, height: 432))
    let s = safe / 100
    cx.saveGState()
    cx.translateBy(x: inset, y: inset)
    cx.scaleBy(x: s, y: s)
    cx.setFillColor(white)
    for (x, y, w, h, r) in Mark.bars {
        cx.addPath(CGPath(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerWidth: r, cornerHeight: r, transform: nil))
    }
    cx.fillPath()
    let ring = Mark.badgeRadius + Mark.badgeRing / 2
    cx.setBlendMode(.clear)
    cx.fillEllipse(in: CGRect(x: Mark.badgeCenter.x - ring, y: Mark.badgeCenter.y - ring, width: ring * 2, height: ring * 2))
    cx.setBlendMode(.normal)
    cx.setFillColor(badge)
    cx.fillEllipse(in: CGRect(x: Mark.badgeCenter.x - Mark.badgeRadius, y: Mark.badgeCenter.y - Mark.badgeRadius, width: Mark.badgeRadius * 2, height: Mark.badgeRadius * 2))
    cx.restoreGState()
}, "brand/android/ic_launcher_foreground.png")

// MARK: App Store images (1320 x 2868)

let W = 1320, H = 2868

struct Slide {
    var file: String
    var title: String
    var subtitle: String
    var background: CGColor
    var dark: Bool
    var screen: String? // nil: drawn (the lock screen)
    /// Points to leave above a screen whose page relies on the native
    /// navigation bar, which a headless capture does not draw.
    var navBar: (height: CGFloat, color: CGColor)? = nil
}

let slides = [
    Slide(file: "01-channels", title: "每个服务，一个频道", subtitle: "部署、告警、账单各用一个 Bot\n通知不再挤成一堆", background: rgb(0xf2f2f7), dark: false, screen: "chats.png"),
    Slide(file: "02-cards", title: "通知不止一行字", subtitle: "HTML 卡片显示完整状态\n部署进度原地更新", background: rgb(0xd7e4c6), dark: false, screen: "chat.png"),
    Slide(file: "03-lockscreen", title: "锁屏上就认得出是谁", subtitle: "每条通知带着 Bot 的头像和名字", background: ink, dark: true, screen: nil),
    Slide(file: "04-curl", title: "一行 curl 就能推送", subtitle: "建一个 Bot，复制 token\n接进任何脚本和 CI", background: rgb(0xf2f2f7), dark: false, screen: "created.png", navBar: (106, rgb(0xf2f2f7))),
    Slide(file: "05-dark", title: "深夜值班也看得清", subtitle: "完整适配深色模式", background: rgb(0x0f1a12), dark: true, screen: "chat-dark.png"),
]

/// The phone: a bezel with the screen inside, cropped by the image's bottom edge.
let phoneX: CGFloat = 150, phoneY: CGFloat = 820, phoneW: CGFloat = 1020
let bezel: CGFloat = 22
let screenRect = CGRect(x: phoneX + bezel, y: phoneY + bezel, width: phoneW - bezel * 2, height: (phoneW - bezel * 2) * 1912 / 880)

func drawPhone(_ cx: CGContext, dark: Bool, showTime: Bool = true, content: (CGContext, CGRect) -> Void) {
    let outer = CGRect(x: phoneX, y: phoneY, width: phoneW, height: screenRect.height + bezel * 2)
    cx.saveGState()
    cx.setShadow(offset: CGSize(width: 0, height: 30), blur: 80, color: rgb(0x000000, dark ? 0.5 : 0.18))
    cx.setFillColor(rgb(0x0b0b0c))
    cx.addPath(CGPath(roundedRect: outer, cornerWidth: 150, cornerHeight: 150, transform: nil))
    cx.fillPath()
    cx.restoreGState()
    cx.setStrokeColor(rgb(0x3a3a3c))
    cx.setLineWidth(3)
    cx.addPath(CGPath(roundedRect: outer.insetBy(dx: 1.5, dy: 1.5), cornerWidth: 148, cornerHeight: 148, transform: nil))
    cx.strokePath()

    cx.saveGState()
    cx.addPath(CGPath(roundedRect: screenRect, cornerWidth: 128, cornerHeight: 128, transform: nil))
    cx.clip()
    content(cx, screenRect)
    // Status bar and Dynamic Island over the screen's top inset.
    let s = screenRect.width / 440
    let fg = dark ? white : ink
    if showTime {
        text("9:41", CGRect(x: screenRect.minX + 46 * s, y: screenRect.minY + 18 * s, width: 90 * s, height: 30 * s), size: 17 * s, weight: .semibold, color: fg)
    }
    cx.setFillColor(rgb(0x000000))
    let island = CGRect(x: screenRect.midX - 63 * s, y: screenRect.minY + 11 * s, width: 126 * s, height: 37 * s)
    cx.addPath(CGPath(roundedRect: island, cornerWidth: island.height / 2, cornerHeight: island.height / 2, transform: nil))
    cx.fillPath()
    // Battery.
    let bx = screenRect.maxX - 72 * s, by = screenRect.minY + 24 * s
    cx.setStrokeColor(fg.copy(alpha: 0.5)!)
    cx.setLineWidth(1.2 * s)
    cx.addPath(CGPath(roundedRect: CGRect(x: bx, y: by, width: 25 * s, height: 12 * s), cornerWidth: 3.5 * s, cornerHeight: 3.5 * s, transform: nil))
    cx.strokePath()
    cx.setFillColor(fg)
    cx.addPath(CGPath(roundedRect: CGRect(x: bx + 2 * s, y: by + 2 * s, width: 21 * s, height: 8 * s), cornerWidth: 2 * s, cornerHeight: 2 * s, transform: nil))
    cx.fillPath()
    cx.restoreGState()
}

/// The lock screen with two notifications, drawn rather than captured.
func lockScreen(_ cx: CGContext, _ r: CGRect) {
    let s = r.width / 440
    let wall = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [rgb(0x26303d), rgb(0x10151c)] as CFArray, locations: [0, 1])!
    cx.drawLinearGradient(wall, start: CGPoint(x: r.midX, y: r.minY), end: CGPoint(x: r.midX, y: r.maxY), options: [])
    text("11月17日 星期二", CGRect(x: r.minX, y: r.minY + 92 * s, width: r.width, height: 30 * s), size: 20 * s, weight: .semibold, color: white)
    text("9:41", CGRect(x: r.minX, y: r.minY + 110 * s, width: r.width, height: 120 * s), size: 96 * s, weight: .bold, color: white)

    struct Note { var app: String; var symbol: String; var color: UInt32; var title: String; var body: String; var time: String; var flag: String? }
    let notes = [
        Note(app: "服务器告警", symbol: "exclamationmark.triangle", color: 0xc2410c, title: "hk-edge-02 CPU 92%", body: "持续 5 分钟超过阈值 85%，负载 7.8。", time: "现在", flag: "时效性通知"),
        Note(app: "Berth 部署", symbol: "ferry", color: 0x1c1c1e, title: "部署成功：sub2api / sluice", body: "production 环境的部署已上线。", time: "2 分钟前", flag: nil),
        Note(app: "CI 构建", symbol: "checkmark.circle", color: 0x2f6f3e, title: "main #482 通过", body: "3 分 12 秒 · 128 个测试全部通过", time: "8 分钟前", flag: nil),
    ]
    var y = r.minY + 470 * s
    for n in notes {
        let h: CGFloat = (n.flag == nil ? 92 : 112) * s
        let card = CGRect(x: r.minX + 12 * s, y: y, width: r.width - 24 * s, height: h)
        cx.setFillColor(rgb(0xf2f2f7, 0.92))
        cx.addPath(CGPath(roundedRect: card, cornerWidth: 24 * s, cornerHeight: 24 * s, transform: nil))
        cx.fillPath()
        let av = CGRect(x: card.minX + 14 * s, y: card.minY + (h - 40 * s) / 2, width: 40 * s, height: 40 * s)
        cx.setFillColor(rgb(n.color))
        cx.fillEllipse(in: av)
        if let sym = symbol(n.symbol, size: 40, color: white) {
            // The bitmap's pixel size depends on the screen scale: fit it to half the avatar.
            let aspect = CGFloat(sym.width) / CGFloat(sym.height)
            let h = av.height * 0.5, w = h * aspect
            image(cx, sym, in: CGRect(x: av.midX - w / 2, y: av.midY - h / 2, width: w, height: h))
        }
        // The app's own small icon on the avatar's corner.
        let mini = CGRect(x: av.maxX - 13 * s, y: av.maxY - 13 * s, width: 17 * s, height: 17 * s)
        Mark.draw(cx, in: mini, background: ink, cornerRadius: 22)
        var ty = card.minY + 12 * s
        let tx = av.maxX + 12 * s, tw = card.maxX - tx - 14 * s
        if let flag = n.flag {
            text(flag, CGRect(x: tx, y: ty, width: tw, height: 18 * s), size: 12.5 * s, weight: .semibold, color: rgb(0xa33508), align: .left)
            ty += 19 * s
        }
        text(n.app, CGRect(x: tx, y: ty, width: tw - 70 * s, height: 22 * s), size: 15.5 * s, weight: .semibold, color: ink, align: .left)
        text(n.time, CGRect(x: tx, y: ty + 1 * s, width: tw, height: 22 * s), size: 13 * s, weight: .regular, color: rgb(0x4a4a4f), align: .right)
        text(n.title, CGRect(x: tx, y: ty + 21 * s, width: tw, height: 22 * s), size: 15.5 * s, weight: .medium, color: ink, align: .left)
        text(n.body, CGRect(x: tx, y: ty + 42 * s, width: tw, height: 22 * s), size: 15 * s, weight: .regular, color: rgb(0x1c1c1e, 0.85), align: .left)
        y += h + 10 * s
    }
}

for slide in slides {
    let png = canvas(W, H) { cx in
        cx.setFillColor(slide.background)
        cx.fill(CGRect(x: 0, y: 0, width: W, height: H))
        let fg = slide.dark ? white : ink
        let sub = slide.dark ? rgb(0xffffff, 0.72) : rgb(0x3c3c43, 0.8)
        let logo = CGRect(x: CGFloat(W) / 2 - 48, y: 150, width: 96, height: 96)
        Mark.draw(cx, in: logo, background: ink, cornerRadius: 22)
        if slide.dark {
            // On a dark page the ink tile needs an edge.
            cx.setStrokeColor(rgb(0xffffff, 0.18))
            cx.setLineWidth(2)
            cx.addPath(CGPath(roundedRect: logo.insetBy(dx: 1, dy: 1), cornerWidth: 21, cornerHeight: 21, transform: nil))
            cx.strokePath()
        }
        text(slide.title, CGRect(x: 80, y: 300, width: CGFloat(W) - 160, height: 150), size: 104, weight: .bold, color: fg, lineHeight: 140)
        text(slide.subtitle, CGRect(x: 120, y: 460, width: CGFloat(W) - 240, height: 200), size: 50, weight: .regular, color: sub, lineHeight: 72)
        drawPhone(cx, dark: slide.dark, showTime: slide.screen != nil) { cx, r in
            if let name = slide.screen {
                var rect = r
                if let bar = slide.navBar {
                    cx.setFillColor(bar.color)
                    cx.fill(r)
                    rect.origin.y += bar.height * r.width / 440
                }
                image(cx, load(name), in: rect)
            } else {
                lockScreen(cx, r)
            }
        }
    }
    write(png, "public/appstore/iphone-6.9/\(slide.file).png")
}
