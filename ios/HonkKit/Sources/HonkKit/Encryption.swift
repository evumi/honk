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
    /// The ids of the bots that have a key here; used to drop the keys of bots the gateway no longer lists.
    func ids() -> [String]
}

public extension BotKeyStoring {
    func ids() -> [String] { [] }
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

    public func ids() -> [String] { Keychain.accounts(query(nil, group: nil), accessGroup) }

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

    public func ids() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return Array(keys.keys)
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

    /// The message with the limits applied that the gateway checks for plaintext: clipped title, body and copy,
    /// url / icon / image that are http(s) (https for the last two), and a card only when it and its data fit (an
    /// invalid card is dropped; the message stays with its body). The same rules for opened ciphertext and for
    /// imported archives.
    public static func sanitize(_ m: QueuedMessage) -> QueuedMessage {
        var out = m
        out.title = clip(m.title, title)
        out.body = clip(m.body, body)
        out.copy = clip(m.copy, copy)
        out.url = link(m.url, httpsOnly: false)
        out.icon = link(m.icon, httpsOnly: true)
        out.image = link(m.image, httpsOnly: true)
        let dataFits = m.data.utf8.count <= data
        if m.html.isEmpty {
            out.data = dataFits ? m.data : ""
        } else if dataFits, cardFits(m.html) {
            out.html = m.html
            out.data = m.data
        } else {
            out.html = ""
            out.data = ""
        }
        return out
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
            out.title = Self.text(json["title"])
            out.body = Self.text(json["body"])
            out.copy = Self.text(json["copy"])
            out.url = Self.text(json["url"])
            out.icon = Self.text(json["icon"])
            out.image = Self.text(json["image"])
            out.html = Self.text(json["html"])
            out.data = Self.text(json["data"])
            out = ContentLimits.sanitize(out)
        case .delete:
            break
        }
        return out
    }

    /// Whether `open` gets the item's content: a plaintext item for a bot without
    /// a key, or a ciphertext that opens with the key held now. The extension
    /// checks it to know when to fetch the wrapped key first.
    public func opens(_ m: QueuedMessage) -> Bool {
        if m.kind == .delete { return true }
        let key = keys.key(botID: m.botID)
        if m.ciphertext.isEmpty { return key == nil }
        guard let key else { return false }
        return (try? Seal.open(m.ciphertext, key: key, aad: m.botID)) != nil
    }

    private func failed(_ m: QueuedMessage) -> QueuedMessage {
        QueuedMessage(id: m.id, botID: m.botID, kind: .message, body: placeholder, level: m.level, group: m.group,
                      silent: m.silent, collapseID: m.collapseID, date: m.date, placeholder: true)
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

// MARK: - several devices

/// A bot's key sealed with the group key, as the gateway stores it in
/// `bots.key_wrapped`: AES-256-GCM(group key, bot key), additional data
/// `honk bot key v1|<bot id>`, the same text format as a message's ciphertext.
/// The gateway cannot open it; any device of the group can.
public enum KeyWrap {
    public static func aad(botID: String) -> String { "honk bot key v1|" + botID }

    public static func wrap(botKey: Data, groupKey: Data, botID: String, nonce: Data? = nil) throws -> String {
        try Seal.seal(botKey, key: groupKey, aad: aad(botID: botID), nonce: nonce)
    }

    /// The bot key, or `nil` when `text` was not sealed with `groupKey` for this bot.
    public static func unwrap(_ text: String, groupKey: Data, botID: String) -> Data? {
        guard let k = try? Seal.open(text, key: groupKey, aad: aad(botID: botID)), k.count == 32 else { return nil }
        return k
    }
}

/// Where the group key is kept: the keychain access group in the app, memory in tests.
public protocol GroupKeyStoring: Sendable {
    func groupKey() -> Data?
    func save(_ key: Data)
    func remove()
}

/// The group key in the shared keychain group (like the bot keys), so the
/// Notification Service Extension can unwrap a key too. It never goes to the
/// gateway in clear: a pairing bundle (sealed with the pairing code) carries it
/// to a new phone.
public struct GroupKeyStore: GroupKeyStoring, Sendable {
    let service: String
    let accessGroup: String?

    public init(service: String = "dev.evumi.honk.group-key", accessGroup: String?) {
        self.service = service
        self.accessGroup = accessGroup
    }

    private func query(group: String?) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: "group"]
        if let group { q[kSecAttrAccessGroup as String] = group }
        return q
    }

    public func groupKey() -> Data? {
        for group in Keychain.groups(accessGroup) {
            if let data = Keychain.read(query(group: group)), data.count == 32 { return data }
        }
        return nil
    }

    public func save(_ key: Data) { _ = Keychain.write(key, accessGroup) { query(group: $0) } }

    public func remove() {
        for group in Keychain.groups(accessGroup) { SecItemDelete(query(group: group) as CFDictionary) }
    }
}

/// The group key in memory, for tests.
public final class MemoryGroupKey: GroupKeyStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var key: Data?

    public init(_ key: Data? = nil) { self.key = key }

    public func groupKey() -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return key
    }

    public func save(_ key: Data) {
        lock.lock()
        defer { lock.unlock() }
        self.key = key
    }

    public func remove() {
        lock.lock()
        defer { lock.unlock() }
        key = nil
    }
}

/// The bot keys and the group key of this device, and how they agree with the
/// wrapped keys on the gateway.
public struct KeyRing: Sendable {
    public let keys: BotKeyStoring
    public let group: GroupKeyStoring

    public init(keys: BotKeyStoring, group: GroupKeyStoring) {
        self.keys = keys
        self.group = group
    }

    /// The group key, made on first need.
    @discardableResult
    public func ensureGroupKey() -> Data {
        if let k = group.groupKey() { return k }
        let k = Seal.generateKey()
        group.save(k)
        return k
    }

    /// `botID`'s key wrapped with the group key, for `PATCH /v1/bots/:id`; `nil` without a local key.
    /// It uses the existing group key and makes one only with `createGroupKey` (where a patch is about to be
    /// sent), so a no-op reconcile (the notification extension) never mints a key as a side effect.
    public func wrapped(botID: String, createGroupKey: Bool = false) -> String? {
        guard let k = keys.key(botID: botID), let g = createGroupKey ? ensureGroupKey() : group.groupKey() else { return nil }
        return try? KeyWrap.wrap(botKey: k, groupKey: g, botID: botID)
    }

    /// What a pairing bundle carries: every listed bot's key (base64url).
    public func bundleKeys(botIDs: [String]) -> [String: String] {
        var out: [String: String] = [:]
        for id in botIDs { if let k = keys.key(botID: id) { out[id] = Seal.encode(k) } }
        return out
    }

    /// A claiming device takes the creator's group key and bot keys. Its own
    /// keys for other bots stay; `reconcile` wraps them with the adopted group key.
    public func adopt(_ bundle: LinkBundle) {
        if let g = bundle.groupKey.flatMap(Seal.parseKey) { group.save(g) }
        for (id, text) in bundle.keys ?? [:] {
            if let k = Seal.parseKey(text) { keys.save(k, botID: id) }
        }
    }

    /// Makes this device and the gateway agree about each encrypted bot of `bots`:
    ///
    /// - the gateway's wrapped key opens with our group key: it is the group's
    ///   current key (another device turned encryption on or reset it), so keep it;
    /// - otherwise, with a local key: wrap ours and send it (`patch`), so the
    ///   other devices can open it (this also covers a claiming device whose own
    ///   keys were wrapped with its old group key);
    /// - otherwise there is nothing to do: without the group key (pair this
    ///   phone) or a wrapped key, the bot's messages show the placeholder.
    ///
    /// A bot the gateway lists as not encrypted loses its local key (another device turned encryption off), so
    /// its plaintext messages are not taken for forgeries.
    ///
    /// A failed `patch` is skipped; the next refresh tries again.
    public func reconcile(bots: [Bot], patch: (_ botID: String, _ wrapped: String) async throws -> Void) async {
        for bot in bots {
            guard bot.encrypted else {
                if keys.key(botID: bot.id) != nil { keys.remove(botID: bot.id) }
                continue
            }
            let local = keys.key(botID: bot.id)
            if let g = group.groupKey(), !bot.keyWrapped.isEmpty,
               let k = KeyWrap.unwrap(bot.keyWrapped, groupKey: g, botID: bot.id) {
                if local != k { keys.save(k, botID: bot.id) }
            } else if let w = wrapped(botID: bot.id, createGroupKey: true) {
                try? await patch(bot.id, w)
            }
        }
    }
}
