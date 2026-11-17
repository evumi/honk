import Foundation

/// A bot avatar: a preset icon on a coloured circle, or an image URL.
///
/// Stored as a string in the bot's `avatar` field: `preset:<icon>:<#rrggbb>`
/// (icon names are the app's own set, mapped to SF Symbols on iOS) or an
/// `https://` URL. Anything else falls back to the default preset.
public enum Avatar: Equatable, Sendable {
    case preset(icon: String, color: String)
    case image(URL)

    public static let `default` = Avatar.preset(icon: "bell", color: "#0a6ed1")

    /// The app's preset icons and the SF Symbols that draw them.
    public static let symbols: [String: String] = [
        "bell": "bell.fill",
        "ship": "ferry.fill",
        "alert": "exclamationmark.triangle.fill",
        "check": "checkmark.circle.fill",
        "wallet": "creditcard.fill",
        "server": "server.rack",
        "chart": "chart.line.uptrend.xyaxis",
        "box": "shippingbox.fill",
        "cloud": "cloud.fill",
        "code": "chevron.left.forwardslash.chevron.right",
    ]

    public init(_ s: String) {
        if s.hasPrefix("https://"), let url = URL(string: s) {
            self = .image(url)
            return
        }
        let parts = s.split(separator: ":", omittingEmptySubsequences: false)
        if parts.count == 3, parts[0] == "preset", Avatar.symbols[String(parts[1])] != nil, Avatar.isHex(String(parts[2])) {
            self = .preset(icon: String(parts[1]), color: String(parts[2]))
            return
        }
        self = .default
    }

    public var stringValue: String {
        switch self {
        case let .preset(icon, color): return "preset:\(icon):\(color)"
        case let .image(url): return url.absoluteString
        }
    }

    static func isHex(_ s: String) -> Bool {
        s.count == 7 && s.hasPrefix("#") && s.dropFirst().allSatisfy(\.isHexDigit)
    }
}

/// Downloads avatar and icon images into the App Group cache, with a time
/// limit that fits the extension's budget.
public struct ImageCache: Sendable {
    let dir: URL
    let session: URLSession

    public init(appGroup: String, session: URLSession = .shared) {
        let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
            ?? FileManager.default.temporaryDirectory
        dir = base.appendingPathComponent("Library/Caches/images", isDirectory: true)
        self.session = session
    }

    init(dir: URL, session: URLSession = .shared) {
        self.dir = dir
        self.session = session
    }

    func file(for url: URL) -> URL {
        // A stable, filesystem-safe name for the URL.
        var h: UInt64 = 1469598103934665603
        for b in url.absoluteString.utf8 { h = (h ^ UInt64(b)) &* 1099511628211 }
        return dir.appendingPathComponent(String(h, radix: 16))
    }

    /// The image's bytes, from the cache or the network (2 MB at most).
    public func data(for url: URL, timeout: TimeInterval = 5) async -> Data? {
        let f = file(for: url)
        if let d = try? Data(contentsOf: f) { return d }
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        guard let (d, res) = try? await session.data(for: req),
              (res as? HTTPURLResponse)?.statusCode == 200, d.count <= 2 << 20 else { return nil }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? d.write(to: f, options: .atomic)
        return d
    }
}
