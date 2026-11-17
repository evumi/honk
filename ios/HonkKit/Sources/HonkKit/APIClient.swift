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

    public init(baseURL: URL, secret: String?, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.secret = secret
        self.session = session
    }

    // MARK: gateway

    public struct GatewayInfo: Decodable, Equatable, Sendable {
        public let name: String
        public let version: String
        public let api: Int
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

    public func registerDevice(platform: String = "ios", pushToken: String) async throws -> Registration {
        try await request("POST", "v1/devices", body: ["platform": platform, "push_token": pushToken], auth: false)
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

    public func updateBot(id: String, name: String? = nil, avatar: String? = nil, defaultLevel: String? = nil) async throws -> Bot {
        var body: [String: String] = [:]
        body["name"] = name
        body["avatar"] = avatar
        body["default_level"] = defaultLevel
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
        enum CodingKeys: String, CodingKey {
            case messages, cursor
            case hasMore = "has_more"
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
        var req = URLRequest(url: url, timeoutInterval: 15)
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
