import CZlib
import CryptoKit
import Foundation

// End-to-end encryption (docs/DESIGN.zh-CN.md, section "端到端加密"): a bot with
// a key gets its content as one AES-256-GCM `ciphertext`. The gateway stores
// and forwards it without reading it, so the checks it makes for plaintext
// messages happen here, after decrypting and before `LocalStore.apply`.

/// AES-256-GCM in the wire format: the unpadded base64url text of
/// nonce (12 bytes) || ciphertext || tag (16 bytes), with the bot's short id
/// as additional authenticated data. The same format as `honk send --key`
/// (gateway/internal/client).
public enum Seal {
    public enum Failure: Error, Equatable {
        case badKey, badText, tooShort, authentication
    }

    static let nonceSize = 12
    static let tagSize = 16

    /// A new random 256-bit key.
    public static func generateKey() -> Data {
        SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
    }

    /// The key as people copy it: unpadded base64url.
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Decodes base64 or base64url, padded or not.
    public static func decode(_ text: String) -> Data? {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
            .replacingOccurrences(of: "=", with: "")
        if s.isEmpty { return nil }
        s += String(repeating: "=", count: (4 - s.count % 4) % 4)
        return Data(base64Encoded: s)
    }

    /// A 32-byte key from its text, or `nil`.
    public static func parseKey(_ text: String) -> Data? {
        guard let k = decode(text), k.count == 32 else { return nil }
        return k
    }

    /// Opens `text`; throws when the key, the text or the bot id (AAD) is wrong.
    public static func open(_ text: String, key: Data, aad: String) throws -> Data {
        guard key.count == 32 else { throw Failure.badKey }
        guard let raw = decode(text) else { throw Failure.badText }
        guard raw.count >= nonceSize + tagSize else { throw Failure.tooShort }
        do {
            let box = try AES.GCM.SealedBox(combined: raw)
            return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: Data(aad.utf8))
        } catch {
            throw Failure.authentication
        }
    }

    /// Seals `plaintext`. `nonce` is for tests; leave it out to get a random one.
    public static func seal(_ plaintext: Data, key: Data, aad: String, nonce: Data? = nil) throws -> String {
        guard key.count == 32 else { throw Failure.badKey }
        let n = try nonce.map { try AES.GCM.Nonce(data: $0) } ?? AES.GCM.Nonce()
        let box = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key), nonce: n, authenticating: Data(aad.utf8))
        guard let combined = box.combined else { throw Failure.badText }
        return encode(combined)
    }
}

/// Where each bot's key comes from. A later step (keys wrapped with a group
/// key, fetched from the gateway) is another provider; the message format does
/// not change.
public protocol BotKeyProviding: Sendable {
    /// The 32-byte key of the bot, or `nil` when the bot has none on this device.
    func key(botID: String) -> Data?
}

/// Where bot keys are kept: the keychain in the app, memory in tests.
public protocol BotKeyStoring: BotKeyProviding {
    func save(_ key: Data, botID: String)
    func remove(botID: String)
}

/// Keeps each bot's key in the keychain access group the app and the
/// Notification Service Extension share (like `BotTokenStore`), so the
/// extension can decrypt a banner while the app is closed.
public struct BotKeyStore: BotKeyStoring, Sendable {
    let service: String
    let accessGroup: String?

    public init(service: String = "dev.evumi.honk.bot-key", accessGroup: String?) {
        self.service = service
        self.accessGroup = accessGroup
    }

    private func query(_ botID: String?, group: String?) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        if let botID { q[kSecAttrAccount as String] = botID }
        if let group { q[kSecAttrAccessGroup as String] = group }
        return q
    }

    public func key(botID: String) -> Data? {
        for group in Keychain.groups(accessGroup) {
            if let data = Keychain.read(query(botID, group: group)), data.count == 32 { return data }
        }
        return nil
    }

    public func save(_ key: Data, botID: String) {
        _ = Keychain.write(key, accessGroup) { query(botID, group: $0) }
    }

    public func remove(botID: String) {
        for group in Keychain.groups(accessGroup) { SecItemDelete(query(botID, group: group) as CFDictionary) }
    }

    /// Removes every bot's key.
    public func removeAll() {
        for group in Keychain.groups(accessGroup) { SecItemDelete(query(nil, group: group) as CFDictionary) }
    }
}

/// Keys in memory, for tests.
public final class MemoryBotKeys: BotKeyStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var keys: [String: Data] = [:]

    public init() {}

    public func key(botID: String) -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return keys[botID]
    }

    public func save(_ key: Data, botID: String) {
        lock.lock()
        defer { lock.unlock() }
        keys[botID] = key
    }

    public func remove(botID: String) {
        lock.lock()
        defer { lock.unlock() }
        keys.removeValue(forKey: botID)
    }
}

/// The limits the gateway checks for a plaintext message and cannot for a
/// sealed one (gateway/internal/widget and bot.go).
public enum ContentLimits {
    public static let htmlRaw = 32 * 1024
    public static let htmlCompressed = 4 * 1024
    public static let data = 1024
    public static let title = 256
    public static let body = 4096
    public static let copy = 4096
    public static let url = 2048

    /// The size of `text` after zlib at level 9, as the gateway measures a card.
    static func compressedSize(_ text: String) -> Int? {
        let src = Array(text.utf8)
        var cap = compressBound(uLong(src.count))
        var out = [UInt8](repeating: 0, count: Int(cap))
        let status = compress2(&out, &cap, src, uLong(src.count), 9)
        return status == Z_OK ? Int(cap) : nil
    }

    /// Whether `html` is a card the whitelist's size limits accept.
    static func cardFits(_ html: String) -> Bool {
        html.utf8.count <= htmlRaw && (compressedSize(html).map { $0 <= htmlCompressed } ?? false)
    }

    /// `text` cut to at most `limit` characters (Unicode scalars, as the gateway counts runes).
    static func clip(_ text: String, _ limit: Int) -> String {
        text.unicodeScalars.count <= limit ? text : String(String.UnicodeScalarView(text.unicodeScalars.prefix(limit)))
    }

    /// `v` when it is an http(s) URL with a host (https only when `httpsOnly`), else "".
    static func link(_ v: String, httpsOnly: Bool) -> String {
        guard v.utf8.count <= url, let c = URLComponents(string: v), let host = c.host, !host.isEmpty,
              let scheme = c.scheme?.lowercased(), scheme == "https" || (!httpsOnly && scheme == "http") else { return "" }
        return v
    }
}

/// Turns the queue's sealed items into the plain ones `LocalStore.apply`
/// stores. Every path that applies queue items goes through it: sync, the
/// extension's fetch, the background push fetch.
public struct MessageOpener: Sendable {
    let keys: BotKeyProviding
    /// The body of the message left in the chat when a ciphertext cannot be opened.
    let placeholder: String

    public static var defaultPlaceholder: String {
        NSLocalizedString("Couldn't decrypt this notification", comment: "Body of a message whose ciphertext could not be opened")
    }

    public init(keys: BotKeyProviding, placeholder: String? = nil) {
        self.keys = keys
        self.placeholder = placeholder ?? Self.defaultPlaceholder
    }

    /// The item ready to apply, or `nil` to skip it (an edit that cannot be opened changes nothing).
    ///
    /// A bot with a key on this device only takes sealed content: a plaintext
    /// message for it (the gateway refuses to queue one, so it is a forgery or
    /// a leftover from before encryption was turned on) cannot be trusted and
    /// becomes the placeholder too.
    public func open(_ m: QueuedMessage) -> QueuedMessage? {
        let key = keys.key(botID: m.botID)
        if m.kind == .delete { return m }
        if m.ciphertext.isEmpty {
            if key == nil { return m }
            return m.kind == .message ? failed(m) : nil
        }
        guard let key, let plain = try? Seal.open(m.ciphertext, key: key, aad: m.botID),
              let json = try? JSONSerialization.jsonObject(with: plain) as? [String: Any] else {
            return m.kind == .message ? failed(m) : nil
        }
        var out = m
        out.ciphertext = ""
        switch m.kind {
        case .edit:
            let data = Self.text(json["data"])
            guard data.utf8.count <= ContentLimits.data else { return nil }
            out.data = data
        case .message:
            out.title = ContentLimits.clip(Self.text(json["title"]), ContentLimits.title)
            out.body = ContentLimits.clip(Self.text(json["body"]), ContentLimits.body)
            out.copy = ContentLimits.clip(Self.text(json["copy"]), ContentLimits.copy)
            out.url = ContentLimits.link(Self.text(json["url"]), httpsOnly: false)
            out.icon = ContentLimits.link(Self.text(json["icon"]), httpsOnly: true)
            out.image = ContentLimits.link(Self.text(json["image"]), httpsOnly: true)
            // An invalid card is dropped; the message stays with its body.
            let html = Self.text(json["html"])
            let data = Self.text(json["data"])
            let dataFits = data.utf8.count <= ContentLimits.data
            if html.isEmpty {
                out.data = dataFits ? data : ""
            } else if dataFits, ContentLimits.cardFits(html) {
                out.html = html
                out.data = data
            } else {
                out.html = ""
                out.data = ""
            }
        case .delete:
            break
        }
        return out
    }

    private func failed(_ m: QueuedMessage) -> QueuedMessage {
        QueuedMessage(id: m.id, botID: m.botID, kind: .message, body: placeholder, level: m.level, group: m.group,
                      silent: m.silent, collapseID: m.collapseID, date: m.date)
    }

    /// A string field: a JSON string as it is, any other value as its JSON text (`data` may be an object).
    private static func text(_ v: Any?) -> String {
        switch v {
        case let s as String: return s
        case nil, is NSNull: return ""
        case let n as NSNumber: return n.stringValue
        case let v?:
            guard JSONSerialization.isValidJSONObject(v),
                  let d = try? JSONSerialization.data(withJSONObject: v, options: [.sortedKeys]) else { return "" }
            return String(decoding: d, as: UTF8.self)
        }
    }
}
