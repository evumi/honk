import Foundation

/// The gateway's response envelope, the same shape as Telegram's Bot API.
struct Envelope<T: Decodable>: Decodable {
    let ok: Bool
    let result: T?
    let errorCode: Int?
    let description: String?

    enum CodingKeys: String, CodingKey {
        case ok, result, description
        case errorCode = "error_code"
    }
}

/// A bot id: a short random string (`aZ3kQ9xT`). Gateways before v2 sent
/// integers; those decode as their decimal text and are "legacy" ids.
public enum BotID {
    /// Whether `id` is an integer id from a gateway or store before short ids.
    public static func isLegacy(_ id: String) -> Bool {
        !id.isEmpty && id.allSatisfy { $0.isASCII && $0.isNumber }
    }

    static func decode<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K) throws -> String {
        if let s = try? c.decode(String.self, forKey: key) { return s }
        return String(try c.decode(Int64.self, forKey: key))
    }
}

/// A notification channel.
public struct Bot: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var avatar: String
    public var defaultLevel: String
    public var createdAt: Int64
    public var updatedAt: Int64
    /// End-to-end encryption is on for this bot (the gateway refuses its plaintext).
    public var encrypted: Bool = false
    /// The bot's key sealed with the group key (`KeyWrap`); empty when there is none.
    public var keyWrapped: String = ""

    enum CodingKeys: String, CodingKey {
        case id, name, avatar
        case defaultLevel = "default_level"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case encrypted
        case keyWrapped = "key_wrapped"
    }

    public init(id: String, name: String, avatar: String = "", defaultLevel: String = "active", createdAt: Int64 = 0, updatedAt: Int64 = 0) {
        self.id = id
        self.name = name
        self.avatar = avatar
        self.defaultLevel = defaultLevel
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try BotID.decode(c, .id)
        name = try c.decode(String.self, forKey: .name)
        avatar = try c.decodeIfPresent(String.self, forKey: .avatar) ?? ""
        defaultLevel = try c.decodeIfPresent(String.self, forKey: .defaultLevel) ?? "active"
        createdAt = try c.decodeIfPresent(Int64.self, forKey: .createdAt) ?? 0
        updatedAt = try c.decodeIfPresent(Int64.self, forKey: .updatedAt) ?? 0
        encrypted = try c.decodeIfPresent(Bool.self, forKey: .encrypted) ?? false
        keyWrapped = try c.decodeIfPresent(String.self, forKey: .keyWrapped) ?? ""
    }
}

/// One item from the gateway's queue: a new message, or an edit or delete of one.
public struct QueuedMessage: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case message, edit, delete }

    public var id: Int64
    public var botID: String
    public var kind: Kind
    /// For an edit or delete: the message it applies to (0 when only `collapseID` names it).
    public var targetID: Int64
    public var title: String
    public var body: String
    public var html: String
    public var data: String
    public var level: String
    public var group: String
    public var url: String
    public var copy: String
    public var icon: String
    /// `url`: tapping the notification opens `url` instead of the chat.
    public var open: String
    /// An https image for the notification and the bubble.
    public var image: String
    /// `Markdown` when `body` is Markdown.
    public var parseMode: String
    /// Stored and counted, but with no banner.
    public var silent: Bool
    /// The end-to-end sealed content (`Seal`); `MessageOpener` replaces it with the fields above.
    public var ciphertext: String
    /// The sender's replaceable id (`id` in the bot API).
    public var collapseID: String
    /// The sender let the card's `request()` reach the bot (`allow_queries`).
    public var allowQueries: Bool
    /// Unix milliseconds.
    public var date: Int64

    enum CodingKeys: String, CodingKey {
        case kind, title, body, html, data, level, group, url, copy, icon, date, open, image, silent, ciphertext
        case parseMode = "parse_mode"
        case allowQueries = "allow_queries"
        case id = "message_id"
        case botID = "bot_id"
        case targetID = "target_id"
        case collapseID = "id"
    }

    public init(id: Int64, botID: String, kind: Kind = .message, targetID: Int64 = 0, title: String = "", body: String = "",
                html: String = "", data: String = "", level: String = "", group: String = "", url: String = "",
                copy: String = "", icon: String = "", ciphertext: String = "", open: String = "", image: String = "", parseMode: String = "",
                silent: Bool = false, collapseID: String = "", allowQueries: Bool = false, date: Int64 = 0) {
        self.id = id
        self.botID = botID
        self.kind = kind
        self.targetID = targetID
        self.title = title
        self.body = body
        self.html = html
        self.data = data
        self.level = level
        self.group = group
        self.url = url
        self.copy = copy
        self.icon = icon
        self.open = open
        self.image = image
        self.parseMode = parseMode
        self.silent = silent
        self.ciphertext = ciphertext
        self.collapseID = collapseID
        self.allowQueries = allowQueries
        self.date = date
    }

    // The gateway omits empty fields.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int64.self, forKey: .id)
        botID = try BotID.decode(c, .botID)
        kind = try c.decode(Kind.self, forKey: .kind)
        targetID = try c.decodeIfPresent(Int64.self, forKey: .targetID) ?? 0
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        body = try c.decodeIfPresent(String.self, forKey: .body) ?? ""
        html = try c.decodeIfPresent(String.self, forKey: .html) ?? ""
        data = try c.decodeIfPresent(String.self, forKey: .data) ?? ""
        level = try c.decodeIfPresent(String.self, forKey: .level) ?? ""
        group = try c.decodeIfPresent(String.self, forKey: .group) ?? ""
        url = try c.decodeIfPresent(String.self, forKey: .url) ?? ""
        copy = try c.decodeIfPresent(String.self, forKey: .copy) ?? ""
        icon = try c.decodeIfPresent(String.self, forKey: .icon) ?? ""
        open = try c.decodeIfPresent(String.self, forKey: .open) ?? ""
        image = try c.decodeIfPresent(String.self, forKey: .image) ?? ""
        parseMode = try c.decodeIfPresent(String.self, forKey: .parseMode) ?? ""
        silent = try c.decodeIfPresent(Bool.self, forKey: .silent) ?? false
        ciphertext = try c.decodeIfPresent(String.self, forKey: .ciphertext) ?? ""
        collapseID = try c.decodeIfPresent(String.self, forKey: .collapseID) ?? ""
        allowQueries = try c.decodeIfPresent(Bool.self, forKey: .allowQueries) ?? false
        date = try c.decodeIfPresent(Int64.self, forKey: .date) ?? 0
    }
}

/// A registered device as the gateway reports it.
public struct DeviceInfo: Codable, Equatable, Sendable {
    public var id: String
    public var platform: String
    public var pushOK: Bool

    enum CodingKeys: String, CodingKey {
        case id, platform
        case pushOK = "push_ok"
    }
}

/// The fields of a push the app and extension read from `userInfo`.
public struct PushInfo: Equatable, Sendable {
    public var kind: QueuedMessage.Kind
    public var messageID: Int64
    public var botID: String
    public var targetID: Int64
    public var collapseID: String

    public init?(userInfo: [AnyHashable: Any]) {
        guard let k = userInfo["kind"] as? String, let kind = QueuedMessage.Kind(rawValue: k),
              let id = Self.int(userInfo["msg_id"]), let bot = Self.string(userInfo["bot_id"]) else { return nil }
        self.kind = kind
        messageID = id
        botID = bot
        targetID = Self.int(userInfo["target_id"]) ?? 0
        collapseID = userInfo["id"] as? String ?? ""
    }

    private static func string(_ v: Any?) -> String? {
        switch v {
        case let s as String where !s.isEmpty: return s
        case let n as NSNumber: return n.stringValue
        default: return nil
        }
    }

    private static func int(_ v: Any?) -> Int64? {
        switch v {
        case let n as NSNumber: return n.int64Value
        case let s as String: return Int64(s)
        default: return nil
        }
    }
}

/// How notifications are grouped in Notification Center: one thread per bot,
/// or per bot and message group when the sender sets `group`.
public enum NotificationThread {
    /// `bot-<id>`, or `bot-<id>:<group>` for a message with a group.
    public static func identifier(botID: String, group: String) -> String {
        group.isEmpty ? "bot-\(botID)" : "bot-\(botID):\(group)"
    }

    /// The group in the thread id the gateway put in the push (`thread-id`,
    /// `b<bot>:<group>`; just `b<bot>` without a group). The extension uses it
    /// when it could not fetch the message to read the group from.
    public static func group(fromAPNsThread thread: String, botID: String) -> String {
        let prefix = "b\(botID):"
        return thread.hasPrefix(prefix) ? String(thread.dropFirst(prefix.count)) : ""
    }
}
