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

    private func query(group: String?) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "credentials",
        ]
        if let group { q[kSecAttrAccessGroup as String] = group }
        return q
    }

    public func load() -> Credentials? {
        for group in Keychain.groups(accessGroup) {
            if let data = Keychain.read(query(group: group)) { return try? JSONDecoder().decode(Credentials.self, from: data) }
        }
        return nil
    }

    public func save(_ c: Credentials) throws {
        let status = Keychain.write(try JSONEncoder().encode(c), accessGroup) { query(group: $0) }
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }

    public func clear() {
        for group in Keychain.groups(accessGroup) { SecItemDelete(query(group: group) as CFDictionary) }
    }
}

/// Keychain helpers. A build without the shared access group entitlement (an
/// unsigned or ad hoc simulator build) gets errSecMissingEntitlement for it;
/// such builds fall back to the app's own keychain, which the extension then
/// cannot read, but the app works.
enum Keychain {
    static func groups(_ accessGroup: String?) -> [String?] {
        accessGroup == nil ? [nil] : [accessGroup, nil]
    }

    static func read(_ query: [String: Any]) -> Data? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    static func write(_ data: Data, _ accessGroup: String?, query: (String?) -> [String: Any]) -> OSStatus {
        let attrs: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = errSecParam
        for group in groups(accessGroup) {
            let q = query(group)
            status = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)
            if status == errSecItemNotFound {
                status = SecItemAdd(q.merging(attrs) { $1 } as CFDictionary, nil)
            }
            if status != errSecMissingEntitlement { return status }
        }
        return status
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

    private func query(_ botID: Int64?, group: String?) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        if let botID { q[kSecAttrAccount as String] = String(botID) }
        if let group { q[kSecAttrAccessGroup as String] = group }
        return q
    }

    public func token(botID: Int64) -> String? {
        for group in Keychain.groups(accessGroup) {
            if let data = Keychain.read(query(botID, group: group)) { return String(data: data, encoding: .utf8) }
        }
        return nil
    }

    public func save(_ token: String, botID: Int64) {
        _ = Keychain.write(Data(token.utf8), accessGroup) { query(botID, group: $0) }
    }

    public func remove(botID: Int64) {
        for group in Keychain.groups(accessGroup) { SecItemDelete(query(botID, group: group) as CFDictionary) }
    }

    /// Removes every bot's token.
    public func removeAll() {
        for group in Keychain.groups(accessGroup) { SecItemDelete(query(nil, group: group) as CFDictionary) }
    }
}
