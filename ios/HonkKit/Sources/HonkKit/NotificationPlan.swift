import Foundation

/// What a notification offers and what tapping it does, decided from the
/// message alone so the app and the extension stay thin (and this is testable
/// without UIKit).
public enum NotificationPlan {
    /// The notification's buttons.
    public enum Action: String, CaseIterable, Sendable {
        case copy = "honk.copy"
        case openURL = "honk.open"
        case markRead = "honk.read"
    }

    /// A category to register with `UNUserNotificationCenter`.
    public struct Category: Equatable, Sendable {
        public var id: String
        public var actions: [Action]
    }

    /// The four categories the app registers at launch: with or without a
    /// "copy" text, with or without a url. "Mark as read" is always there.
    public static let categories: [Category] = [false, true].flatMap { copy in
        [false, true].map { url in Category(id: categoryID(copy: copy, url: url), actions: actions(copy: copy, url: url)) }
    }

    public static func categoryID(copy: Bool, url: Bool) -> String {
        "honk.msg" + (copy ? ".copy" : "") + (url ? ".url" : "")
    }

    public static func categoryID(for m: StoredMessage) -> String {
        categoryID(copy: !m.copy.isEmpty, url: openableURL(m.url) != nil)
    }

    static func actions(copy: Bool, url: Bool) -> [Action] {
        (copy ? [.copy] : []) + (url ? [.openURL] : []) + [.markRead]
    }

    /// The localized title of an action (the app is Chinese first).
    public static func title(_ a: Action, chinese: Bool) -> String {
        switch a {
        case .copy: return chinese ? "复制" : "Copy"
        case .openURL: return chinese ? "打开链接" : "Open Link"
        case .markRead: return chinese ? "标为已读" : "Mark as Read"
        }
    }

    /// What a tap on the notification body does.
    public enum Tap: Equatable, Sendable {
        case chat(botID: String)
        case url(URL)
    }

    /// `open=url` with a usable url opens it; everything else opens the chat.
    public static func tap(_ m: StoredMessage?, botID: String) -> Tap {
        if let m, m.open == "url", let url = openableURL(m.url) { return .url(url) }
        return .chat(botID: botID)
    }

    /// Only http(s) links are opened from a notification.
    public static func openableURL(_ s: String) -> URL? {
        guard !s.isEmpty, let u = URL(string: s), let scheme = u.scheme?.lowercased(),
              scheme == "https" || scheme == "http", u.host?.isEmpty == false else { return nil }
        return u
    }

    /// Whether a message gets a banner. A silent one is stored and counted only.
    public static func shouldNotify(_ m: QueuedMessage) -> Bool { !m.silent }

    /// What an action does, given the message it is on.
    public enum Outcome: Equatable, Sendable {
        case copy(String)
        case open(URL)
        case markRead(botID: String)
        case nothing
    }

    public static func outcome(of action: Action, on m: StoredMessage?, botID: String) -> Outcome {
        switch action {
        case .copy:
            guard let m, !m.copy.isEmpty else { return .nothing }
            return .copy(m.copy)
        case .openURL:
            guard let m, let url = openableURL(m.url) else { return .nothing }
            return .open(url)
        case .markRead:
            return .markRead(botID: botID)
        }
    }

    // MARK: notification image

    /// The most an attached image may be.
    public static let maxImageBytes = 5 * 1024 * 1024
    /// How long the extension waits for the image.
    public static let imageTimeout: TimeInterval = 10

    /// The image to attach: https only (the device downloads it).
    public static func imageURL(_ s: String) -> URL? {
        guard let u = URL(string: s), u.scheme?.lowercased() == "https", u.host?.isEmpty == false else { return nil }
        return u
    }

    /// A file extension the system accepts for an image attachment, from the
    /// response's content type (or the url's extension as a fallback).
    public static func imageExtension(contentType: String?, url: URL) -> String? {
        let known = ["image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp"]
        if let type = contentType?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces).lowercased(),
           let ext = known[type] {
            return ext
        }
        let ext = url.pathExtension.lowercased()
        return ["jpg", "jpeg", "png", "gif", "webp"].contains(ext) ? ext : nil
    }
}

/// Downloads a message's image into a temporary file for a
/// `UNNotificationAttachment` (the system moves the file into its own store).
public struct NotificationImage: Sendable {
    let session: URLSession
    let directory: URL

    public init(session: URLSession = .shared, directory: URL = FileManager.default.temporaryDirectory) {
        self.session = session
        self.directory = directory
    }

    /// The file's url, or nil when the image is not https, too big (over 5 MB),
    /// not an image type, or does not arrive within 10 seconds.
    public func download(_ s: String) async -> URL? {
        guard let url = NotificationPlan.imageURL(s) else { return nil }
        var req = URLRequest(url: url, timeoutInterval: NotificationPlan.imageTimeout)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        guard let (data, res) = try? await session.data(for: req), let http = res as? HTTPURLResponse, http.statusCode == 200,
              data.count <= NotificationPlan.maxImageBytes,
              let ext = NotificationPlan.imageExtension(contentType: http.value(forHTTPHeaderField: "Content-Type"), url: url)
        else { return nil }
        let file = directory.appendingPathComponent(UUID().uuidString + "." + ext)
        do {
            try data.write(to: file, options: .atomic)
            return file
        } catch {
            return nil
        }
    }
}
