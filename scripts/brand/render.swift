// Renders Honk's brand assets with CoreGraphics (macOS, no extra tools):
//   brand/                       logo SVGs and PNGs
//   ios/App/Assets.xcassets      the iOS app icon
//   public/appstore/             App Store images, 1320x2868 (6.9" iPhone)
// Usage: swift scripts/brand/render.swift <English screens dir> <Chinese screens dir>
// The screens come from scripts/brand/capture-screens.sh (en-US, zh-Hans-CN).
import AppKit
import CoreText

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
let args = CommandLine.arguments
let screenDirs = [
    "en": URL(fileURLWithPath: args.count > 1 ? args[1] : root.appendingPathComponent("build/screens-en").path),
    "zh-Hans": URL(fileURLWithPath: args.count > 2 ? args[2] : root.appendingPathComponent("build/screens-zh").path),
]

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

/// Draws a PNG. `opaque` ones have no alpha channel (RGB): App Store Connect
/// rejects an app icon or screenshot with one, even when every pixel is opaque.
/// Draw a full background into those; what is left undrawn comes out black.
func canvas(_ w: Int, _ h: Int, opaque: Bool = false, _ draw: (CGContext) -> Void) -> Data {
    let alpha: CGImageAlphaInfo = opaque ? .noneSkipLast : .premultipliedLast
    let cx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                       space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: alpha.rawValue)!
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

func load(_ name: String, _ lang: String) -> CGImage {
    let url = screenDirs[lang]!.appendingPathComponent(name)
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
let appIcon = canvas(1024, 1024, opaque: true) { cx in Mark.draw(cx, in: CGRect(x: 0, y: 0, width: 1024, height: 1024), background: ink, cornerRadius: nil) }
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

// MARK: App Store images (1320 x 2868, 6.9" iPhone)

let W: CGFloat = 1320, H: CGFloat = 2868
let orange = rgb(0xff5a36)
let base = rgb(0x111113)

/// SF Pro for English, PingFang for Chinese.
func uiFont(_ size: CGFloat, _ weight: NSFont.Weight, _ lang: String) -> NSFont {
    lang == "en" ? NSFont.systemFont(ofSize: size, weight: weight) : font(size, weight)
}

/// Draws `s` with the substring `accent` in orange; returns the text's height.
@discardableResult
func headline(_ s: String, accent: String, at origin: CGPoint, width: CGFloat, size: CGFloat, lang: String) -> CGFloat {
    let para = NSMutableParagraphStyle()
    para.minimumLineHeight = size * 1.08
    para.maximumLineHeight = size * 1.08
    let str = NSMutableAttributedString(string: s, attributes: [
        .font: uiFont(size, .bold, lang), .foregroundColor: NSColor.white, .paragraphStyle: para,
        .kern: lang == "en" ? -size * 0.025 : -size * 0.01,
    ])
    if let r = s.range(of: accent) {
        str.addAttribute(.foregroundColor, value: NSColor(cgColor: orange)!, range: NSRange(r, in: s))
    }
    let box = str.boundingRect(with: CGSize(width: width, height: 1000), options: [.usesLineFragmentOrigin])
    str.draw(with: CGRect(origin: origin, size: CGSize(width: width, height: box.height + 10)), options: [.usesLineFragmentOrigin])
    return box.height
}

func label(_ s: String, _ rect: CGRect, size: CGFloat, weight: NSFont.Weight, color: CGColor, lang: String, kern: CGFloat = 0, lineHeight: CGFloat? = nil, align: NSTextAlignment = .left, mono: Bool = false) {
    let para = NSMutableParagraphStyle()
    para.alignment = align
    if let lineHeight { para.minimumLineHeight = lineHeight; para.maximumLineHeight = lineHeight }
    let f = mono ? NSFont.monospacedSystemFont(ofSize: size, weight: weight) : uiFont(size, weight, lang)
    NSAttributedString(string: s, attributes: [.font: f, .foregroundColor: NSColor(cgColor: color)!, .paragraphStyle: para, .kern: kern])
        .draw(with: rect, options: [.usesLineFragmentOrigin])
}

func roundRect(_ cx: CGContext, _ r: CGRect, _ radius: CGFloat, fill: CGColor?, stroke: CGColor? = nil, width: CGFloat = 2) {
    let path = CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil)
    if let fill { cx.addPath(path); cx.setFillColor(fill); cx.fillPath() }
    if let stroke { cx.addPath(path); cx.setStrokeColor(stroke); cx.setLineWidth(width); cx.strokePath() }
}

/// A soft round glow (the only gradient: light falling on the base colour).
func glow(_ cx: CGContext, center: CGPoint, radius: CGFloat, color: UInt32, alpha: CGFloat) {
    let g = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [rgb(color, alpha), rgb(color, 0)] as CFArray, locations: [0, 1])!
    cx.drawRadialGradient(g, startCenter: center, startRadius: 0, endCenter: center, endRadius: radius, options: [])
}

struct Shot {
    var file: String
    var kicker: [String: String]
    var title: [String: String]
    var accent: [String: String]
    var subtitle: [String: String]
    var screen: String? // nil: the drawn lock screen
    var dark = false
    var glowColor: UInt32 = 0xff5a36
    /// Height in points of the native navigation bar a headless capture lacks, its colour and title.
    var navBar: (CGFloat, UInt32, [String: String])? = nil
    /// A terminal that overlaps the phone.
    var terminal: [String: [(String, UInt32)]]? = nil
}

let shots: [Shot] = [
    Shot(file: "01-channels",
         kicker: ["en": "ONE BOT PER SERVICE", "zh-Hans": "每个服务一个 BOT"],
         title: ["en": "Every service gets its own channel.", "zh-Hans": "每个服务，\n一个频道"],
         accent: ["en": "its own channel.", "zh-Hans": "一个频道"],
         subtitle: ["en": "Deploys, alerts and bills stop piling up in one feed.", "zh-Hans": "部署、告警、账单各用一个 Bot，\n通知不再挤成一堆。"],
         screen: "chats.png"),
    Shot(file: "02-cards",
         kicker: ["en": "RICH CARDS", "zh-Hans": "HTML 卡片"],
         title: ["en": "Notifications that say more than one line.", "zh-Hans": "通知，\n不止一行字"],
         accent: ["en": "more than one line.", "zh-Hans": "不止一行字"],
         subtitle: ["en": "Cards show the full status, and update in place when it changes.", "zh-Hans": "卡片显示完整状态，\n部署进度原地更新。"],
         screen: "chat.png"),
    Shot(file: "03-lockscreen",
         kicker: ["en": "LOCK SCREEN", "zh-Hans": "锁屏"],
         title: ["en": "Know who’s honking at a glance.", "zh-Hans": "锁屏上，\n一眼认出是谁"],
         accent: ["en": "at a glance.", "zh-Hans": "一眼认出是谁"],
         subtitle: ["en": "Every alert arrives with its bot’s name and avatar.", "zh-Hans": "每条通知都带着 Bot 的头像和名字。"],
         screen: nil),
    Shot(file: "04-curl",
         kicker: ["en": "ONE REQUEST", "zh-Hans": "一个请求"],
         title: ["en": "Push from any script with one curl.", "zh-Hans": "一行 curl，\n随处推送"],
         accent: ["en": "one curl.", "zh-Hans": "随处推送"],
         subtitle: ["en": "Create a bot, copy its token, and call it from CI, cron or anywhere else.", "zh-Hans": "建一个 Bot，复制 token，\n接进 CI、定时任务和任何脚本。"],
         screen: "created.png", navBar: (106, 0xf2f2f7, [:]),
         terminal: [
            "en": [("$ curl honk.example.com/bot$TOKEN/sendMessage \\", 0xe5e5ea), ("    -d title=\"Deployed\" \\", 0xe5e5ea), ("    -d body=\"evumi / sluice is live\"", 0xe5e5ea), ("{\"ok\":true,\"result\":{\"message_id\":42}}", 0x5ad18b)],
            "zh-Hans": [("$ curl honk.example.com/bot$TOKEN/sendMessage \\", 0xe5e5ea), ("    -d title=\"部署成功\" \\", 0xe5e5ea), ("    -d body=\"evumi / sluice 已上线\"", 0xe5e5ea), ("{\"ok\":true,\"result\":{\"message_id\":42}}", 0x5ad18b)],
         ]),
    Shot(file: "05-dark",
         kicker: ["en": "DARK MODE", "zh-Hans": "深色模式"],
         title: ["en": "Built for the night shift.", "zh-Hans": "深夜值班，\n也看得清"],
         accent: ["en": "the night shift.", "zh-Hans": "也看得清"],
         subtitle: ["en": "A full dark mode that is easy on the eyes at 3 a.m.", "zh-Hans": "完整适配深色模式，凌晨三点也不刺眼。"],
         screen: "chat-dark.png", dark: true, glowColor: 0x2f9e6e),
    Shot(file: "06-self-hosted",
         kicker: ["en": "SELF-HOSTED", "zh-Hans": "自己部署"],
         title: ["en": "Your gateway. Your data.", "zh-Hans": "网关和数据，\n都在你手里"],
         accent: ["en": "Your data.", "zh-Hans": "都在你手里"],
         subtitle: ["en": "One Go binary and SQLite, with a Docker image. Point the app at it in Settings.", "zh-Hans": "一个 Go 程序加 SQLite，自带 Docker 镜像，\n在设置里填上地址即可。"],
         screen: "gateway.png", navBar: (106, 0xf2f2f7, ["en": "Gateway", "zh-Hans": "网关"]),
         terminal: [
            "en": [("$ docker compose up -d", 0xe5e5ea), ("✔ Container honk-gateway  Started", 0x5ad18b), ("$ curl honk.example.com/healthz", 0xe5e5ea), ("{\"ok\":true,\"result\":\"ok\"}", 0x5ad18b)],
            "zh-Hans": [("$ docker compose up -d", 0xe5e5ea), ("✔ Container honk-gateway  Started", 0x5ad18b), ("$ curl honk.example.com/healthz", 0xe5e5ea), ("{\"ok\":true,\"result\":\"ok\"}", 0x5ad18b)],
         ]),
]

// The phone: bezel and screen, its bottom cropped by the image's edge.
let phoneW: CGFloat = 1000, phoneX = (W - 1000) / 2, phoneY: CGFloat = 1000
let bezelW: CGFloat = 20
let screenR = CGRect(x: phoneX + bezelW, y: phoneY + bezelW, width: phoneW - bezelW * 2, height: (phoneW - bezelW * 2) * 1912 / 880)

func phone(_ cx: CGContext, dark: Bool, lockScreen: Bool, _ content: (CGContext, CGRect) -> Void) {
    let outer = CGRect(x: phoneX, y: phoneY, width: phoneW, height: screenR.height + bezelW * 2)
    cx.saveGState()
    cx.setShadow(offset: CGSize(width: 0, height: 40), blur: 120, color: rgb(0x000000, 0.6))
    roundRect(cx, outer, 146, fill: rgb(0x1d1d1f))
    cx.restoreGState()
    // A thin titanium-like edge.
    roundRect(cx, outer.insetBy(dx: 1, dy: 1), 145, fill: nil, stroke: rgb(0x8e8e93, 0.55), width: 2)
    roundRect(cx, outer.insetBy(dx: 8, dy: 8), 138, fill: rgb(0x000000))
    cx.saveGState()
    cx.addPath(CGPath(roundedRect: screenR, cornerWidth: 126, cornerHeight: 126, transform: nil))
    cx.clip()
    content(cx, screenR)
    let s = screenR.width / 440
    let fg = dark || lockScreen ? white : ink
    if !lockScreen {
        label("9:41", CGRect(x: screenR.minX + 50 * s, y: screenR.minY + 19 * s, width: 90 * s, height: 30 * s), size: 17 * s, weight: .semibold, color: fg, lang: "en", align: .center)
    }
    let island = CGRect(x: screenR.midX - 63 * s, y: screenR.minY + 11 * s, width: 126 * s, height: 37 * s)
    roundRect(cx, island, island.height / 2, fill: rgb(0x000000))
    let bx = screenR.maxX - 74 * s, by = screenR.minY + 24 * s
    roundRect(cx, CGRect(x: bx, y: by, width: 25 * s, height: 12 * s), 3.5 * s, fill: nil, stroke: fg.copy(alpha: 0.45)!, width: 1.2 * s)
    roundRect(cx, CGRect(x: bx + 2 * s, y: by + 2 * s, width: 21 * s, height: 8 * s), 2 * s, fill: fg)
    cx.restoreGState()
}

func drawLockScreen(_ cx: CGContext, _ r: CGRect, lang: String) {
    let s = r.width / 440
    let wall = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [rgb(0x2b3a4f), rgb(0x0f141c)] as CFArray, locations: [0, 1])!
    cx.drawLinearGradient(wall, start: CGPoint(x: r.midX, y: r.minY), end: CGPoint(x: r.midX, y: r.maxY), options: [])
    let date = lang == "en" ? "Tuesday, November 17" : "11月17日 星期二"
    label(date, CGRect(x: r.minX, y: r.minY + 92 * s, width: r.width, height: 30 * s), size: 20 * s, weight: .semibold, color: white, lang: lang, align: .center)
    label("9:41", CGRect(x: r.minX, y: r.minY + 108 * s, width: r.width, height: 120 * s), size: 100 * s, weight: .bold, color: white, lang: "en", align: .center)

    struct Note { var app: String; var symbol: String; var color: UInt32; var title: String; var body: String; var time: String; var flag: String? }
    let en = lang == "en"
    let notes = [
        Note(app: en ? "Server Alerts" : "服务器告警", symbol: "exclamationmark.triangle", color: 0xc2410c, title: "hk-edge-02 CPU 92%",
             body: en ? "Above the 85% threshold for 5 minutes." : "持续 5 分钟超过阈值 85%，负载 7.8。", time: en ? "now" : "现在", flag: en ? "TIME SENSITIVE" : "时效性通知"),
        Note(app: en ? "Berth Deploys" : "Berth 部署", symbol: "ferry", color: 0x1c1c1e, title: en ? "Deployed: evumi / sluice" : "部署成功：evumi / sluice",
             body: en ? "Live in production." : "production 环境的部署已上线。", time: en ? "2m ago" : "2 分钟前", flag: nil),
        Note(app: en ? "CI Builds" : "CI 构建", symbol: "checkmark.circle", color: 0x2f6f3e, title: en ? "main #482 passed" : "main #482 通过",
             body: en ? "3m 12s · all 128 tests passed" : "3 分 12 秒 · 128 个测试全部通过", time: en ? "8m ago" : "8 分钟前", flag: nil),
    ]
    var y = r.minY + 440 * s
    for n in notes {
        let h: CGFloat = (n.flag == nil ? 92 : 112) * s
        let card = CGRect(x: r.minX + 12 * s, y: y, width: r.width - 24 * s, height: h)
        roundRect(cx, card, 24 * s, fill: rgb(0xf2f2f7, 0.9))
        let av = CGRect(x: card.minX + 14 * s, y: card.minY + (h - 40 * s) / 2, width: 40 * s, height: 40 * s)
        cx.setFillColor(rgb(n.color))
        cx.fillEllipse(in: av)
        if let sym = symbol(n.symbol, size: 40, color: white) {
            let aspect = CGFloat(sym.width) / CGFloat(sym.height)
            let ih = av.height * 0.5, iw = ih * aspect
            image(cx, sym, in: CGRect(x: av.midX - iw / 2, y: av.midY - ih / 2, width: iw, height: ih))
        }
        Mark.draw(cx, in: CGRect(x: av.maxX - 13 * s, y: av.maxY - 13 * s, width: 17 * s, height: 17 * s), background: ink, cornerRadius: 22)
        var ty = card.minY + 12 * s
        let tx = av.maxX + 12 * s, tw = card.maxX - tx - 14 * s
        if let flag = n.flag {
            label(flag, CGRect(x: tx, y: ty, width: tw, height: 18 * s), size: 12 * s, weight: .semibold, color: rgb(0xa33508), lang: lang, kern: en ? 0.6 * s : 0)
            ty += 19 * s
        }
        label(n.app, CGRect(x: tx, y: ty, width: tw - 80 * s, height: 22 * s), size: 15.5 * s, weight: .semibold, color: ink, lang: lang)
        label(n.time, CGRect(x: tx, y: ty + 1 * s, width: tw, height: 22 * s), size: 13 * s, weight: .regular, color: rgb(0x4a4a4f), lang: lang, align: .right)
        label(n.title, CGRect(x: tx, y: ty + 21 * s, width: tw, height: 22 * s), size: 15.5 * s, weight: .medium, color: ink, lang: lang)
        label(n.body, CGRect(x: tx, y: ty + 42 * s, width: tw, height: 22 * s), size: 15 * s, weight: .regular, color: rgb(0x1c1c1e, 0.85), lang: lang)
        y += h + 10 * s
    }
}

func drawTerminal(_ cx: CGContext, lines: [(String, UInt32)], frame: CGRect) {
    cx.saveGState()
    cx.setShadow(offset: CGSize(width: 0, height: 30), blur: 80, color: rgb(0x000000, 0.55))
    roundRect(cx, frame, 34, fill: rgb(0x1c1c1e, 0.97))
    cx.restoreGState()
    roundRect(cx, frame.insetBy(dx: 1, dy: 1), 33, fill: nil, stroke: rgb(0xffffff, 0.12), width: 2)
    for (i, c) in [0xff5f57, 0xfebc2e, 0x28c840].enumerated() {
        cx.setFillColor(rgb(UInt32(c)))
        cx.fillEllipse(in: CGRect(x: frame.minX + 36 + CGFloat(i) * 34, y: frame.minY + 30, width: 20, height: 20))
    }
    var y = frame.minY + 82
    for (line, color) in lines {
        label(line, CGRect(x: frame.minX + 36, y: y, width: frame.width - 60, height: 44), size: 27, weight: .medium, color: rgb(color), lang: "en", mono: true)
        y += 46
    }
}

for lang in ["en", "zh-Hans"] {
    for shot in shots {
        let png = canvas(Int(W), Int(H), opaque: true) { cx in
            cx.setFillColor(base)
            cx.fill(CGRect(x: 0, y: 0, width: W, height: H))
            glow(cx, center: CGPoint(x: W * 0.92, y: 260), radius: 1100, color: shot.glowColor, alpha: 0.30)
            glow(cx, center: CGPoint(x: W * 0.05, y: 1500), radius: 900, color: shot.glowColor, alpha: 0.10)

            let left: CGFloat = 110, textW = W - left * 2
            Mark.draw(cx, in: CGRect(x: left, y: 150, width: 76, height: 76), background: ink, cornerRadius: 22)
            roundRect(cx, CGRect(x: left, y: 150, width: 76, height: 76).insetBy(dx: 1, dy: 1), 16, fill: nil, stroke: rgb(0xffffff, 0.16), width: 2)
            label(shot.kicker[lang]!, CGRect(x: left + 100, y: 168, width: textW - 100, height: 50), size: 32, weight: .bold, color: orange, lang: lang, kern: lang == "en" ? 4 : 2)
            let titleSize: CGFloat = lang == "en" ? 118 : 112
            let th = headline(shot.title[lang]!, accent: shot.accent[lang]!, at: CGPoint(x: left, y: 290), width: textW, size: titleSize, lang: lang)
            label(shot.subtitle[lang]!, CGRect(x: left, y: 290 + th + 40, width: textW - 40, height: 220), size: 44, weight: .regular, color: rgb(0xffffff, 0.66), lang: lang, lineHeight: 62)

            phone(cx, dark: shot.dark, lockScreen: shot.screen == nil) { cx, r in
                guard let name = shot.screen else { return drawLockScreen(cx, r, lang: lang) }
                var rect = r
                if let (h, color, title) = shot.navBar {
                    cx.setFillColor(rgb(color))
                    cx.fill(r)
                    let s = r.width / 440
                    rect.origin.y += h * s
                    if let t = title[lang] {
                        label(t, CGRect(x: r.minX, y: r.minY + 72 * s, width: r.width, height: 28 * s), size: 17 * s, weight: .semibold, color: ink, lang: lang, align: .center)
                        label("‹", CGRect(x: r.minX + 18 * s, y: r.minY + 60 * s, width: 30 * s, height: 40 * s), size: 34 * s, weight: .regular, color: rgb(0x0a6ed1), lang: "en")
                    }
                }
                image(cx, load(name, lang), in: rect)
            }
            if let lines = shot.terminal?[lang] {
                drawTerminal(cx, lines: lines, frame: CGRect(x: 60, y: 2470, width: W - 120, height: 82 + CGFloat(lines.count) * 46 + 30))
            }
        }
        write(png, "public/appstore/\(lang)/iphone-6.9/\(shot.file).png")
    }
}
