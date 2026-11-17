import Foundation

/// A bot avatar: a preset icon on a coloured circle, an image URL, or an
/// image the user picked that is kept on this phone only.
///
/// Stored as a string in the bot's `avatar` field: `preset:<icon>:<#rrggbb>`
/// (icon names are the app's own set, mapped to SF Symbols on iOS), an
/// `https://` URL, or `local:<file>` (`LocalAvatars`). Anything else,
/// including a preset icon the app no longer offers, falls back to the default.
public enum Avatar: Equatable, Sendable {
    case preset(icon: String, color: String)
    case image(URL)
    /// A file in `LocalAvatars`: `<name>.jpg` or `<name>.png`.
    case local(String)

    public static let `default` = Avatar.preset(icon: "bell", color: "#0a6ed1")

    /// The app's preset icons and the SF Symbols that draw them.
    public static let symbols: [String: String] = [
        "bell": "bell.fill",
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
        if s.hasPrefix("local:"), LocalAvatars.isValidName(String(s.dropFirst(6))) {
            self = .local(String(s.dropFirst(6)))
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
        case let .local(name): return "local:" + name
        }
    }

    static func isHex(_ s: String) -> Bool {
        s.count == 7 && s.hasPrefix("#") && s.dropFirst().allSatisfy(\.isHexDigit)
    }
}

/// Images the user picked as bot avatars, kept on this phone only: in the App
/// Group, so the Notification Service Extension can draw them too. The bot's
/// avatar names the file (`local:<name>`); the gateway stores only that string.
public struct LocalAvatars: Sendable {
    /// The most a picked image may weigh (the app scales it to 512 px first).
    public static let maxBytes = 512 * 1024

    public enum SaveError: Error, LocalizedError {
        case tooLarge, notAnImage
        public var errorDescription: String? {
            switch self {
            case .tooLarge: return "图片太大，请换一张小一点的"
            case .notAnImage: return "只支持 JPEG 和 PNG 图片"
            }
        }
    }

    let dir: URL

    public init(appGroup: String) {
        let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
            ?? FileManager.default.temporaryDirectory
        dir = base.appendingPathComponent("Library/Avatars", isDirectory: true)
    }

    init(dir: URL) { self.dir = dir }

    static func isValidName(_ name: String) -> Bool {
        let parts = name.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 2 && (parts[1] == "jpg" || parts[1] == "png") && !parts[0].isEmpty
            && parts[0].allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }

    /// Keeps a JPEG or PNG and returns the avatar that names it, `local:<name>`.
    public func save(_ data: Data) throws -> String {
        guard data.count <= Self.maxBytes else { throw SaveError.tooLarge }
        let ext: String
        if data.starts(with: [0xFF, 0xD8, 0xFF]) {
            ext = "jpg"
        } else if data.starts(with: [0x89, 0x50, 0x4E, 0x47]) {
            ext = "png"
        } else {
            throw SaveError.notAnImage
        }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let name = UUID().uuidString.lowercased() + "." + ext
        try data.write(to: dir.appendingPathComponent(name), options: .atomic)
        return "local:" + name
    }

    /// The image of a `local:` avatar; `nil` for any other avatar or when the file is not on this phone.
    public func data(for avatar: String) -> Data? {
        guard case let .local(name) = Avatar(avatar) else { return nil }
        return try? Data(contentsOf: dir.appendingPathComponent(name))
    }

    /// The image as a `data:` URL, for the nsh app to show.
    public func dataURL(for avatar: String) -> String? {
        guard let d = data(for: avatar) else { return nil }
        return "data:" + (avatar.hasSuffix(".png") ? "image/png" : "image/jpeg") + ";base64," + d.base64EncodedString()
    }

    /// Deletes images no bot uses any more. Ones younger than `grace` stay: a
    /// picked image is saved before the bot that will use it is created.
    public func prune(keeping avatars: Set<String>, grace: TimeInterval = 3600, now: Date = Date()) {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        for f in files where !avatars.contains("local:" + f.lastPathComponent) {
            let modified = (try? f.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? now
            if now.timeIntervalSince(modified) > grace { try? fm.removeItem(at: f) }
        }
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
