import Foundation
import Testing
@testable import HonkKit

// swift-testing rather than XCTest, so `swift test` also runs with only the
// Command Line Tools installed.

func tempStore() throws -> LocalStore {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".sqlite").path
    let store = try LocalStore(path: path)
    try store.replaceBots([Bot(id: 1, name: "部署"), Bot(id: 2, name: "告警")])
    return store
}

@Suite struct LocalStoreTests {
    @Test func collapseEditDelete() throws {
        let store = try tempStore()
        try store.apply(QueuedMessage(id: 10, botID: 1, body: "部署中", data: #"{"s":"部署中"}"#, collapseID: "dep", date: 1), notificationID: "n10")
        let r = try store.apply(QueuedMessage(id: 11, botID: 1, body: "重试", collapseID: "dep", date: 2), notificationID: "n11")
        #expect(r.staleNotificationIDs == ["n10"], "the replaced message's notification goes")
        #expect(try store.message(id: 10) == nil)

        // An edit by collapse id reaches the newest message with it.
        let e = try store.apply(QueuedMessage(id: 12, botID: 1, kind: .edit, data: #"{"s":"已上线"}"#, collapseID: "dep"))
        #expect(e.message?.id == 11)
        #expect(try store.message(id: 11)?.data == #"{"s":"已上线"}"#)

        // Another bot cannot edit it by id.
        try store.apply(QueuedMessage(id: 13, botID: 2, kind: .edit, targetID: 11, data: "x"))
        #expect(try store.message(id: 11)?.data == #"{"s":"已上线"}"#)

        let d = try store.apply(QueuedMessage(id: 14, botID: 1, kind: .delete, targetID: 11))
        #expect(d.staleNotificationIDs == ["n11"])
        #expect(try store.message(id: 11) == nil)
    }

    @Test func applyTwiceKeepsReadAndNotification() throws {
        let store = try tempStore()
        let m = QueuedMessage(id: 20, botID: 1, body: "x", date: 5)
        try store.apply(m, notificationID: "n20")
        try store.markRead(botID: 1)
        try store.apply(m) // the later sync sees it again
        #expect(try store.message(id: 20)?.read == true)
        #expect(try store.clearMessages(botID: 1) == ["n20"])
    }

    @Test func chatsAndUnread() throws {
        let store = try tempStore()
        try store.apply(QueuedMessage(id: 1, botID: 1, body: "a", date: 100))
        try store.apply(QueuedMessage(id: 2, botID: 2, body: "b", date: 200))
        try store.apply(QueuedMessage(id: 3, botID: 2, body: "c", date: 300))
        var chats = try store.chats()
        #expect(chats.map(\.bot.id) == [2, 1], "latest first")
        #expect(chats.first?.unread == 2)
        #expect(chats.first?.last?.body == "c")
        #expect(try store.unreadTotal() == 3)

        try store.setPinned(botID: 1, true)
        try store.setMuted(botID: 2, true)
        chats = try store.chats()
        #expect(chats.map(\.bot.id) == [1, 2], "pinned first")
        #expect(try store.unreadTotal() == 1, "muted bots don't count")

        #expect(try store.messages(botID: 2).map(\.id) == [3, 2])
        #expect(try store.messages(botID: 2, before: 3).map(\.id) == [2])
    }

    @Test func replaceBotsDropsGoneBots() throws {
        let store = try tempStore()
        try store.apply(QueuedMessage(id: 1, botID: 2, body: "x"))
        try store.setMuted(botID: 1, true)
        try store.replaceBots([Bot(id: 1, name: "改名")])
        #expect(try store.bot(id: 2) == nil)
        #expect(try store.messages(botID: 2).isEmpty)
        #expect(try store.bot(id: 1)?.name == "改名")
        #expect(try store.isMuted(botID: 1), "local flags survive")
    }

    @Test func cursor() throws {
        let store = try tempStore()
        #expect(store.syncCursor == 0)
        try store.setSyncCursor(42)
        #expect(store.syncCursor == 42)
    }

    @Test func twoConnectionsShareTheFile() throws {
        // The app and the extension each open the file.
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".sqlite").path
        let app = try LocalStore(path: path)
        let ext = try LocalStore(path: path)
        try app.replaceBots([Bot(id: 1, name: "b")])
        try ext.apply(QueuedMessage(id: 5, botID: 1, body: "from the extension"))
        #expect(try app.messages(botID: 1).first?.body == "from the extension")
    }
}

@Suite struct ModelTests {
    @Test func decodeGatewayMessage() throws {
        let json = #"{"message_id":7,"bot_id":1,"kind":"edit","target_id":3,"data":"{\"a\":1}","id":"dep","date":99}"#
        let m = try JSONDecoder().decode(QueuedMessage.self, from: Data(json.utf8))
        #expect(m == QueuedMessage(id: 7, botID: 1, kind: .edit, targetID: 3, data: #"{"a":1}"#, collapseID: "dep", date: 99))
    }

    @Test func pushInfo() {
        // APNs gives numbers, FCM data gives strings.
        #expect(PushInfo(userInfo: ["kind": "message", "msg_id": 7, "bot_id": 1])?.messageID == 7)
        #expect(PushInfo(userInfo: ["kind": "delete", "msg_id": "8", "bot_id": "1", "target_id": "7"])?.targetID == 7)
        #expect(PushInfo(userInfo: ["aps": [String: Any]()]) == nil)
    }

    @Test func avatar() {
        #expect(Avatar("preset:ship:#1c1c1e") == .preset(icon: "ship", color: "#1c1c1e"))
        #expect(Avatar("https://e.com/a.png") == .image(URL(string: "https://e.com/a.png")!))
        #expect(Avatar("http://e.com/a.png") == .default)
        #expect(Avatar("preset:nope:#000000") == .default)
        #expect(Avatar("") == .default)
    }
}

/// Serves canned gateway responses.
final class MockGateway: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) -> (Int, String))?
    nonisolated(unsafe) static var requests: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        let (status, body) = Self.handler?(request) ?? (404, "{}")
        let res = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}

    static func session() -> URLSession {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [MockGateway.self]
        return URLSession(configuration: cfg)
    }
}

// Serialized: the mock's handler is shared.
@Suite(.serialized) struct GatewayTests {
    @Test func syncAppliesPagesAndAcks() async throws {
        MockGateway.requests = []
        MockGateway.handler = { req in
            let url = req.url!.absoluteString
            if url.contains("cursor=0") {
                return (200, #"{"ok":true,"result":{"messages":[{"message_id":1,"bot_id":1,"kind":"message","body":"a","date":1}],"cursor":1,"has_more":true}}"#)
            }
            if url.contains("cursor=1") {
                return (200, #"{"ok":true,"result":{"messages":[{"message_id":2,"bot_id":1,"kind":"edit","target_id":1,"data":"d","date":2}],"cursor":2,"has_more":false}}"#)
            }
            if url.hasSuffix("v1/ack") { return (200, #"{"ok":true,"result":{"acked":1}}"#) }
            return (404, #"{"ok":false,"error_code":404,"description":"Not Found"}"#)
        }
        let store = try tempStore()
        let api = APIClient(baseURL: URL(string: "https://gw.test/")!, secret: "s", session: MockGateway.session())

        let out = try await SyncEngine(api: api, store: store).run()
        #expect(out.applied == 2)
        #expect(store.syncCursor == 2)
        #expect(try store.message(id: 1)?.data == "d")
        #expect(MockGateway.requests.filter { $0.url!.path == "/v1/ack" }.count == 2)
        #expect(MockGateway.requests.first?.value(forHTTPHeaderField: "Authorization") == "Bearer s")
    }

    @Test func gatewayError() async throws {
        MockGateway.handler = { _ in (401, #"{"ok":false,"error_code":401,"description":"Unauthorized"}"#) }
        let api = APIClient(baseURL: URL(string: "https://gw.test/")!, secret: "bad", session: MockGateway.session())
        let error = await #expect(throws: APIError.self) { try await api.listBots() }
        #expect(error?.isUnauthorized == true)
    }
}

@Suite struct GatewayConfigTests {
    @Test func normalize() {
        #expect(HonkConfig.normalizeGateway("honk.example.com")?.absoluteString == "https://honk.example.com/")
        #expect(HonkConfig.normalizeGateway(" HTTP://10.0.0.2:8080 ")?.absoluteString == "http://10.0.0.2:8080/")
        #expect(HonkConfig.normalizeGateway("https://e.com/honk")?.absoluteString == "https://e.com/honk/")
        #expect(HonkConfig.normalizeGateway("ftp://e.com") == nil)
        #expect(HonkConfig.normalizeGateway("https://e.com/?a=1") == nil)
        #expect(HonkConfig.normalizeGateway("") == nil)
    }

    @Test func overrideRoundTrip() {
        let group = "test.honk.\(UUID().uuidString)"
        HonkConfig.setGatewayOverride(URL(string: "https://mine.example/")!, appGroup: group)
        let stored = UserDefaults(suiteName: group)?.string(forKey: HonkConfig.overrideKey)
        #expect(stored == "https://mine.example/")
        HonkConfig.setGatewayOverride(nil, appGroup: group)
        #expect(UserDefaults(suiteName: group)?.string(forKey: HonkConfig.overrideKey) == nil)
    }

    @Test func resetForgetsEverything() throws {
        let store = try tempStore()
        try store.apply(QueuedMessage(id: 1, botID: 1, body: "x"), notificationID: "n1")
        try store.setSyncCursor(9)
        #expect(try store.reset() == ["n1"])
        #expect(try store.chats().isEmpty)
        #expect(store.syncCursor == 0)
    }
}
