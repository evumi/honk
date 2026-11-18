import Foundation

/// An error the gateway returned, or a transport failure.
public enum APIError: Error, Equatable, LocalizedError {
    case gateway(code: Int, description: String)
    case notRegistered
    case badResponse

    public var errorDescription: String? {
        switch self {
        case let .gateway(code, desc): return "\(code) \(desc)"
        case .notRegistered: return "这台设备还没有注册到网关。到「设置 → 设备注册」查看原因并重试。"
        case .badResponse: return "网关的响应无法解析，请确认地址是 Honk 网关"
        }
    }

    /// The device secret is unknown to the gateway (the device was deleted).
    public var isUnauthorized: Bool {
        if case let .gateway(code, _) = self { return code == 401 }
        return false
    }
}

/// A client for the gateway's app API (`/v1`).
public struct APIClient: Sendable {
    public let baseURL: URL
    public let secret: String?
    let session: URLSession
    /// Seconds per request.
    let timeout: TimeInterval

    public init(baseURL: URL, secret: String?, session: URLSession = .shared, timeout: TimeInterval = 15) {
        self.baseURL = baseURL
        self.secret = secret
        self.session = session
        self.timeout = timeout
    }

    // MARK: gateway

    /// How the gateway sends pushes to each platform: `direct` (its own APNs/FCM
    /// credentials), `relay` (through a push relay) or `off`.
    public struct PushRoutes: Decodable, Equatable, Sendable {
        public let ios: String
        public let android: String

        public init(ios: String, android: String) {
            self.ios = ios
            self.android = android
        }
    }

    public struct GatewayInfo: Decodable, Equatable, Sendable {
        public let name: String
        public let version: String
        public let api: Int
        /// The gateway only registers devices that send its `register_key` (HONK_REGISTER_KEY).
        public let registerKeyRequired: Bool
        /// What the gateway can do beyond the base API, e.g. `relay`; empty for an older gateway.
        public let features: [String]
        /// Nil for a gateway that does not say.
        public let push: PushRoutes?

        enum CodingKeys: String, CodingKey {
            case name, version, api, features, push
            case registerKeyRequired = "register_key_required"
        }

        public init(name: String, version: String, api: Int, registerKeyRequired: Bool = false,
                    features: [String] = [], push: PushRoutes? = nil) {
            self.name = name
            self.version = version
            self.api = api
            self.registerKeyRequired = registerKeyRequired
            self.features = features
            self.push = push
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = try c.decode(String.self, forKey: .name)
            version = try c.decode(String.self, forKey: .version)
            api = try c.decode(Int.self, forKey: .api)
            registerKeyRequired = try c.decodeIfPresent(Bool.self, forKey: .registerKeyRequired) ?? false
            features = try c.decodeIfPresent([String].self, forKey: .features) ?? []
            push = try c.decodeIfPresent(PushRoutes.self, forKey: .push)
        }
    }

    /// What the gateway says it is; a Honk gateway answers `name` "honk".
    public func info() async throws -> GatewayInfo {
        try await request("GET", "v1/info", auth: false)
    }

    // MARK: devices

    public struct Registration: Decodable, Sendable {
        public let device: DeviceInfo
        public let deviceSecret: String
        enum CodingKeys: String, CodingKey {
            case device
            case deviceSecret = "device_secret"
        }
    }

    /// `registerKey`: what a gateway with HONK_REGISTER_KEY set wants to see; sent only when not empty.
    /// `name`: what the device group's list shows (the phone's name or model).
    public func registerDevice(platform: String = "ios", pushToken: String, registerKey: String? = nil, name: String? = nil) async throws -> Registration {
        var body = ["platform": platform, "push_token": pushToken]
        if let name, !name.isEmpty { body["name"] = name }
        if let registerKey, !registerKey.isEmpty { body["register_key"] = registerKey }
        return try await request("POST", "v1/devices", body: body, auth: false)
    }

    /// Removes this device from its group (`DELETE /v1/devices/me`); when it is the
    /// last one the group's bots and queued messages go too. With `all`, the
    /// whole group goes: every device, bot and queued message.
    public func deleteDevice(all: Bool = false) async throws {
        let _: Bool = try await request("DELETE", all ? "v1/devices/me?all=true" : "v1/devices/me")
    }

    /// A device of the group, as `GET /v1/devices` lists it.
    public struct GroupDevice: Decodable, Equatable, Sendable {
        public let id: String
        public let name: String
        public let platform: String
        /// Unix milliseconds of its last request (written at most hourly).
        public let seenAt: Int64
        public let current: Bool
        enum CodingKeys: String, CodingKey {
            case id, name, platform, current
            case seenAt = "seen_at"
        }

        public init(id: String, name: String, platform: String, seenAt: Int64, current: Bool) {
            self.id = id
            self.name = name
            self.platform = platform
            self.seenAt = seenAt
            self.current = current
        }
    }

    public func listDevices() async throws -> [GroupDevice] {
        try await request("GET", "v1/devices")
    }

    /// Removes another device of the group (`DELETE /v1/devices/<id>`).
    public func removeDevice(id: String) async throws {
        let _: Bool = try await request("DELETE", "v1/devices/\(id)")
    }

    /// Stores the sealed bundle under `linkID` for 10 minutes; returns the seconds it lives.
    public func createLink(linkID: String, bundle: String) async throws -> Int {
        struct Created: Decodable { let expiresIn: Int
            enum CodingKeys: String, CodingKey { case expiresIn = "expires_in" } }
        let c: Created = try await request("POST", "v1/links", body: ["link_id": linkID, "bundle": bundle])
        return c.expiresIn
    }

    /// Joins this device's group to the one that made the link; returns the sealed bundle.
    public func claimLink(linkID: String) async throws -> String {
        struct Claimed: Decodable { let bundle: String }
        let c: Claimed = try await request("POST", "v1/links/claim", body: ["link_id": linkID])
        return c.bundle
    }

    @discardableResult
    public func updatePushToken(_ token: String) async throws -> DeviceInfo {
        try await request("PUT", "v1/devices/me", body: ["push_token": token])
    }

    // MARK: bots

    public struct CreatedBot: Decodable, Sendable {
        public let bot: Bot
        public let token: String
    }

    public struct Token: Decodable, Sendable {
        public let token: String
    }

    public func listBots() async throws -> [Bot] {
        try await request("GET", "v1/bots")
    }

    public func createBot(name: String, avatar: String, defaultLevel: String) async throws -> CreatedBot {
        try await request("POST", "v1/bots", body: ["name": name, "avatar": avatar, "default_level": defaultLevel])
    }

    public func updateBot(id: String, name: String? = nil, avatar: String? = nil, defaultLevel: String? = nil,
                          encrypted: Bool? = nil, keyWrapped: String? = nil) async throws -> Bot {
        var body: [String: Any] = [:]
        body["name"] = name
        body["avatar"] = avatar
        body["default_level"] = defaultLevel
        body["encrypted"] = encrypted
        body["key_wrapped"] = keyWrapped
        return try await request("PATCH", "v1/bots/\(id)", body: body)
    }

    public func resetToken(botID: String) async throws -> String {
        let t: Token = try await request("POST", "v1/bots/\(botID)/token")
        return t.token
    }

    public func deleteBot(id: String) async throws {
        let _: Bool = try await request("DELETE", "v1/bots/\(id)")
    }

    /// The bot a token belongs to, through the bot API (`/bot<token>/getMe`).
    /// The app uses it to learn the short id of a bot it knew by a legacy id.
    public func getMe(token: String) async throws -> Bot {
        // "./" keeps the token's colon from reading as a URL scheme.
        guard let escaped = token.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { throw APIError.badResponse }
        return try await request("GET", "./bot\(escaped)/getMe", auth: false)
    }

    // MARK: messages

    public struct SyncPage: Decodable, Sendable {
        public let messages: [QueuedMessage]
        public let cursor: Int64
        public let hasMore: Bool
        /// The device must sync again from cursor 0 (after a merge); absent from older gateways.
        public let reset: Bool
        enum CodingKeys: String, CodingKey {
            case messages, cursor, reset
            case hasMore = "has_more"
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            messages = try c.decodeIfPresent([QueuedMessage].self, forKey: .messages) ?? []
            cursor = try c.decode(Int64.self, forKey: .cursor)
            hasMore = try c.decodeIfPresent(Bool.self, forKey: .hasMore) ?? false
            reset = try c.decodeIfPresent(Bool.self, forKey: .reset) ?? false
        }
    }

    public func message(id: Int64) async throws -> QueuedMessage {
        try await request("GET", "v1/messages/\(id)")
    }

    public func sync(cursor: Int64, limit: Int = 100) async throws -> SyncPage {
        try await request("GET", "v1/sync?cursor=\(cursor)&limit=\(limit)")
    }

    public func ack(upTo: Int64) async throws {
        struct Acked: Decodable { let acked: Int64 }
        let _: Acked = try await request("POST", "v1/ack", body: ["up_to": upTo])
    }

    // MARK: transport

    func request<T: Decodable>(_ method: String, _ path: String, body: [String: Any]? = nil, auth: Bool = true) async throws -> T {
        guard let url = URL(string: path, relativeTo: baseURL) else { throw APIError.badResponse }
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = method
        if auth {
            guard let secret else { throw APIError.notRegistered }
            req.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, _) = try await session.data(for: req)
        let env: Envelope<T>
        do {
            env = try JSONDecoder().decode(Envelope<T>.self, from: data)
        } catch {
            throw APIError.badResponse
        }
        guard env.ok, let result = env.result else {
            throw APIError.gateway(code: env.errorCode ?? 0, description: env.description ?? "")
        }
        return result
    }
}
