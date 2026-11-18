import CryptoKit
import Foundation

// Pairing a new phone with the device group (docs/DESIGN.zh-CN.md, 3.2). The
// gateway never sees the pairing code: both phones derive from it a `link_id`
// (what the gateway files the bundle under) and a `wrap_key` (which seals the
// bundle). The same derivation lives in android/core's DeviceLink.kt; the
// vectors in docs/link-vectors.json are tested on both.

/// The pairing code: 16 random bytes, shown as 26 characters of Crockford
/// base32 (no I, L, O, U), grouped in fours.
public enum PairingCode {
    public static let byteCount = 16
    public static let length = 26
    static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    /// A fresh code, as its 16 bytes.
    public static func generate() -> Data {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        precondition(SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess)
        return Data(bytes)
    }

    /// The 26 characters of `bytes` (no grouping).
    public static func encode(_ bytes: Data) -> String {
        var out = ""
        var acc: UInt32 = 0
        var bits = 0
        for b in bytes {
            acc = (acc << 8) | UInt32(b)
            bits += 8
            while bits >= 5 {
                out.append(alphabet[Int((acc >> UInt32(bits - 5)) & 31)])
                bits -= 5
            }
        }
        if bits > 0 { out.append(alphabet[Int((acc << UInt32(5 - bits)) & 31)]) }
        return out
    }

    /// `ABCD-EFGH-…`: groups of four with dashes, for reading out and typing.
    public static func display(_ bytes: Data) -> String {
        let s = Array(encode(bytes))
        return stride(from: 0, to: s.count, by: 4).map { String(s[$0..<min($0 + 4, s.count)]) }.joined(separator: "-")
    }

    /// Reads what a person typed or pasted: case, spaces and dashes do not
    /// matter, and O reads as 0, I and L as 1. `nil` when it is not a code
    /// (wrong length, a character outside the alphabet, or non-zero padding bits).
    public static func decode(_ text: String) -> Data? {
        var chars: [Character] = []
        for c in text.uppercased() where !c.isWhitespace && c != "-" {
            switch c {
            case "O": chars.append("0")
            case "I", "L": chars.append("1")
            default: chars.append(c)
            }
        }
        guard chars.count == length else { return nil }
        var out = [UInt8]()
        var acc: UInt32 = 0
        var bits = 0
        for c in chars {
            guard let v = alphabet.firstIndex(of: c) else { return nil }
            acc = (acc << 5) | UInt32(v)
            bits += 5
            if bits >= 8 {
                out.append(UInt8((acc >> UInt32(bits - 8)) & 0xff))
                bits -= 8
            }
        }
        // 26 × 5 = 130 bits: the last two are padding and must be zero.
        guard bits == 2, acc & 3 == 0, out.count == byteCount else { return nil }
        return Data(out)
    }
}

/// Key derivation and sealing for the pairing bundle.
public enum LinkCrypto {
    static let aad = Data("honk link v1".utf8)

    private static func derive(_ code: Data, info: String) -> SymmetricKey {
        // HKDF-SHA256 (RFC 5869) with an empty salt (a block of zeros).
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: code), salt: Data(), info: Data(info.utf8), outputByteCount: 32)
    }

    /// What the gateway files the bundle under: base64url (no padding) of 32 derived bytes.
    public static func linkID(code: Data) -> String {
        base64url(derive(code, info: "honk link id").withUnsafeBytes { Data($0) })
    }

    public static func wrapKey(code: Data) -> Data {
        derive(code, info: "honk link key").withUnsafeBytes { Data($0) }
    }

    /// `nonce(12) || ciphertext || tag(16)` of AES-256-GCM, as base64url without padding.
    /// The nonce is random unless a test passes one.
    public static func seal(_ plaintext: Data, wrapKey: Data, nonce: Data? = nil) throws -> String {
        let n = try nonce.map { try AES.GCM.Nonce(data: $0) } ?? AES.GCM.Nonce()
        let box = try AES.GCM.seal(plaintext, using: SymmetricKey(data: wrapKey), nonce: n, authenticating: aad)
        return base64url(box.nonce.withUnsafeBytes { Data($0) } + box.ciphertext + box.tag)
    }

    /// Opens what `seal` made. Throws when the key is wrong or the text was changed.
    public static func open(_ sealed: String, wrapKey: Data) throws -> Data {
        guard let blob = fromBase64url(sealed), blob.count >= 12 + 16 else { throw LinkError.malformed }
        let box = try AES.GCM.SealedBox(combined: blob)
        return try AES.GCM.open(box, using: SymmetricKey(data: wrapKey), authenticating: aad)
    }

    public static func base64url(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func fromBase64url(_ s: String) -> Data? {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)
    }
}

public enum LinkError: Error, LocalizedError, Equatable {
    case malformed
    case badCode
    case tooLarge
    /// The gateway does not know the code: wrong, expired or already used.
    case unknownCode
    /// Too many attempts from this address.
    case rateLimited

    public var errorDescription: String? {
        switch self {
        case .malformed: return "配对数据无法读取"
        case .badCode: return "配对码格式不对：应是 26 个字母和数字"
        case .tooLarge: return "配对数据太大，请先删掉一些 bot"
        case .unknownCode: return "配对码不对、已过期或已用过"
        case .rateLimited: return "尝试次数太多，请稍后再试"
        }
    }
}

/// What the old phone hands the new one, sealed with the wrap key. JSON:
/// `{"v":1,"tokens":{botId:token},"keys":{botId:base64url},"group_key":base64url}`.
/// `keys` (a bot's end-to-end key) and `group_key` (the group's encryption
/// key) are reserved for the encryption phase and absent until then.
public struct LinkBundle: Codable, Equatable, Sendable {
    public var v: Int = 1
    public var tokens: [String: String]
    public var keys: [String: String]?
    public var groupKey: String?

    enum CodingKeys: String, CodingKey {
        case v, tokens, keys
        case groupKey = "group_key"
    }

    public init(tokens: [String: String], keys: [String: String]? = nil, groupKey: String? = nil) {
        self.tokens = tokens
        self.keys = keys?.isEmpty == true ? nil : keys
        self.groupKey = groupKey
    }

    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        v = try c.decodeIfPresent(Int.self, forKey: .v) ?? 1
        tokens = try c.decodeIfPresent([String: String].self, forKey: .tokens) ?? [:]
        keys = try c.decodeIfPresent([String: String].self, forKey: .keys)
        groupKey = try c.decodeIfPresent(String.self, forKey: .groupKey)
    }

    /// The text the gateway stores (at most 16 KB).
    public static let maxSealedBytes = 16 << 10

    public func seal(code: Data) throws -> String {
        let sealed = try LinkCrypto.seal(JSONEncoder().encode(self), wrapKey: LinkCrypto.wrapKey(code: code))
        guard sealed.utf8.count <= Self.maxSealedBytes else { throw LinkError.tooLarge }
        return sealed
    }

    public static func open(_ sealed: String, code: Data) throws -> LinkBundle {
        let plain = try LinkCrypto.open(sealed, wrapKey: LinkCrypto.wrapKey(code: code))
        return try JSONDecoder().decode(LinkBundle.self, from: plain)
    }
}

/// Making and using a pairing code: what the two phones do around the gateway's
/// `POST /v1/links` and `POST /v1/links/claim`.
public enum DeviceLinking {
    /// How long the gateway keeps a link (its own limit; this only labels the countdown).
    public static let lifetime: TimeInterval = 10 * 60

    public struct Created: Equatable, Sendable {
        /// The code in groups of four, to show and copy.
        public let code: String
        /// Unix milliseconds.
        public let expiresAt: Int64
    }

    /// Seals this phone's bot tokens (and, once there are any, the bots' end-to-end
    /// keys) with a new code and files them on the gateway. `keys` and `groupKey`
    /// come from the encryption storage when it exists.
    public static func create(api: APIClient, store: LocalStore, tokens: BotTokenStoring,
                              keys: [String: String] = [:], groupKey: String? = nil, now: Date = Date()) async throws -> Created {
        let code = PairingCode.generate()
        var known: [String: String] = [:]
        for id in try store.botIDs() {
            if let t = tokens.token(botID: id) { known[id] = t }
        }
        let bundle = try LinkBundle(tokens: known, keys: keys, groupKey: groupKey).seal(code: code)
        let seconds = try await api.createLink(linkID: LinkCrypto.linkID(code: code), bundle: bundle)
        return Created(code: PairingCode.display(code), expiresAt: Int64(now.timeIntervalSince1970 * 1000) + Int64(seconds) * 1000)
    }

    /// Joins this phone to the group that made the code. The gateway merges the
    /// two groups; this stores the tokens it was given and starts the sync
    /// cursor over, so the merged group's queue arrives. The caller then
    /// refreshes (bot list, sync) and stores the bundle's `keys` / `groupKey`.
    @discardableResult
    public static func claim(_ text: String, api: APIClient, store: LocalStore, tokens: BotTokenStoring) async throws -> LinkBundle {
        guard let code = PairingCode.decode(text) else { throw LinkError.badCode }
        let sealed: String
        do {
            sealed = try await api.claimLink(linkID: LinkCrypto.linkID(code: code))
        } catch let APIError.gateway(code, _) where code == 404 {
            throw LinkError.unknownCode
        } catch let APIError.gateway(code, _) where code == 429 {
            throw LinkError.rateLimited
        }
        let bundle: LinkBundle
        do {
            bundle = try LinkBundle.open(sealed, code: code)
        } catch {
            throw LinkError.malformed
        }
        for (id, token) in bundle.tokens { tokens.save(token, botID: id) }
        try store.setSyncCursor(0)
        return bundle
    }
}
