import Foundation
import Security

/// The device's id and secret from registration.
public struct Credentials: Codable, Equatable, Sendable {
    public var deviceID: String
    public var secret: String
    /// The push token last sent to the gateway.
    public var pushToken: String

    public init(deviceID: String, secret: String, pushToken: String) {
        self.deviceID = deviceID
        self.secret = secret
        self.pushToken = pushToken
    }
}

/// Keeps `Credentials` in the keychain, shared with the extension through a
/// keychain access group. Readable after the first unlock, so the extension
/// can fetch messages while the phone is locked.
public struct CredentialStore: Sendable {
    let service: String
    let accessGroup: String?

    public init(service: String = "dev.evumi.honk.device", accessGroup: String?) {
        self.service = service
        self.accessGroup = accessGroup
    }

    private var query: [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "credentials",
        ]
        if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }

    public func load() -> Credentials? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(Credentials.self, from: data)
    }

    public func save(_ c: Credentials) throws {
        let data = try JSONEncoder().encode(c)
        let attrs: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attrs) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }

    public func clear() {
        SecItemDelete(query as CFDictionary)
    }
}

/// Keeps each bot's token in the keychain. The gateway shows a token only when
/// it is created or reset, so the app keeps it to show and copy later.
public struct BotTokenStore: Sendable {
    let service: String
    let accessGroup: String?

    public init(service: String = "dev.evumi.honk.bot-token", accessGroup: String?) {
        self.service = service
        self.accessGroup = accessGroup
    }

    private func query(_ botID: Int64) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: String(botID),
        ]
        if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }

    public func token(botID: Int64) -> String? {
        var q = query(botID)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func save(_ token: String, botID: Int64) {
        let attrs: [String: Any] = [
            kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        if SecItemUpdate(query(botID) as CFDictionary, attrs as CFDictionary) == errSecItemNotFound {
            SecItemAdd(query(botID).merging(attrs) { $1 } as CFDictionary, nil)
        }
    }

    public func remove(botID: Int64) {
        SecItemDelete(query(botID) as CFDictionary)
    }
}
