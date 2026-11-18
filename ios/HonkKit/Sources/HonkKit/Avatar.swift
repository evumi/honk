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
    /// A file in `LocalAvatars`: `<name>.jpg`, `.png`, `.webp` or `.gif`.
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
        if parts.count == 3, parts[0] == "preset", Avatar.isHex(String(parts[2])) {
            // An icon the app no longer offers (the ship) keeps its colour with the bell.
            let icon = Avatar.symbols[String(parts[1])] != nil ? String(parts[1]) : "bell"
            self = .preset(icon: icon, color: String(parts[2]))
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
    /// The most a picked image may weigh (the app scales it to 512 px first;
    /// a PNG that size can still be close to 1 MB).
    public static let maxBytes = 1024 * 1024

    /// The formats kept, by file extension, with their media types.
    static let types = ["jpg": "image/jpeg", "png": "image/png", "webp": "image/webp", "gif": "image/gif"]

    public enum SaveError: Error, LocalizedError {
        case tooLarge, notAnImage
        public var errorDescription: String? {
            switch self {
            case .tooLarge: return "图片太大，请换一张小一点的"
            case .notAnImage: return "只支持 JPEG、PNG、WebP 和 GIF 图片"
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
        return parts.count == 2 && types[String(parts[1])] != nil && !parts[0].isEmpty
            && parts[0].allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }

    /// The format of an image's bytes, by its signature, as a file extension.
    static func format(_ data: Data) -> String? {
        let b = [UInt8](data.prefix(12))
        if b.starts(with: [0xFF, 0xD8, 0xFF]) { return "jpg" }
        if b.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return "png" }
        if b.starts(with: Array("GIF8".utf8)) { return "gif" }
        if b.count == 12, b.starts(with: Array("RIFF".utf8)), Array(b[8..<12]) == Array("WEBP".utf8) { return "webp" }
        return nil
    }

    /// Keeps a JPEG, PNG, WebP or GIF and returns the avatar that names it, `local:<name>`.
    public func save(_ data: Data) throws -> String {
        guard data.count <= Self.maxBytes else { throw SaveError.tooLarge }
        guard let ext = Self.format(data) else { throw SaveError.notAnImage }
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
        let ext = avatar.split(separator: ".").last.map(String.init) ?? "jpg"
        return "data:" + (Self.types[ext] ?? "image/jpeg") + ";base64," + d.base64EncodedString()
    }

    /// Deletes every kept image (the device's data was deleted).
    public func removeAll() {
        try? FileManager.default.removeItem(at: dir)
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

    /// Forgets every downloaded image.
    public func removeAll() {
        try? FileManager.default.removeItem(at: dir)
    }

    /// The most an avatar or icon download may weigh.
    static let maxBytes = 2 << 20

    /// The image's bytes, from the cache or the network (2 MB at most, `timeout` seconds in all).
    public func data(for url: URL, timeout: TimeInterval = 5) async -> Data? {
        let f = file(for: url)
        if let d = try? Data(contentsOf: f) { return d }
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        guard let (d, _) = await CappedDownload.fetch(req, session: session, maxBytes: Self.maxBytes, deadline: timeout) else { return nil }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? d.write(to: f, options: .atomic)
        return d
    }
}
