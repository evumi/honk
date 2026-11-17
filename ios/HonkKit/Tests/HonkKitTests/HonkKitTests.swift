import Foundation
import SQLite3
import Testing
@testable import HonkKit

// swift-testing rather than XCTest, so `swift test` also runs with only the
// Command Line Tools installed.

func tempStore() throws -> LocalStore {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".sqlite").path
    let store = try LocalStore(path: path)
    try store.replaceBots([Bot(id: "bot1", name: "部署"), Bot(id: "bot2", name: "告警")])
    return store
}

@Suite struct LocalStoreTests {
    @Test func collapseEditDelete() throws {
        let store = try tempStore()
        try store.apply(QueuedMessage(id: 10, botID: "bot1", body: "部署中", data: #"{"s":"部署中"}"#, collapseID: "dep", date: 1), notificationID: "n10")
        let r = try store.apply(QueuedMessage(id: 11, botID: "bot1", body: "重试", collapseID: "dep", date: 2), notificationID: "n11")
        #expect(r.staleNotificationIDs == ["n10"], "the replaced message's notification goes")
        #expect(try store.message(id: 10) == nil)

        // An edit by collapse id reaches the newest message with it.
        let e = try store.apply(QueuedMessage(id: 12, botID: "bot1", kind: .edit, data: #"{"s":"已上线"}"#, collapseID: "dep"))
        #expect(e.message?.id == 11)
        #expect(try store.message(id: 11)?.data == #"{"s":"已上线"}"#)

        // Another bot cannot edit it by id.
        try store.apply(QueuedMessage(id: 13, botID: "bot2", kind: .edit, targetID: 11, data: "x"))
        #expect(try store.message(id: 11)?.data == #"{"s":"已上线"}"#)

        let d = try store.apply(QueuedMessage(id: 14, botID: "bot1", kind: .delete, targetID: 11))
        #expect(d.staleNotificationIDs == ["n11"])
        #expect(try store.message(id: 11) == nil)
    }

    @Test func applyTwiceKeepsReadAndNotification() throws {
        let store = try tempStore()
        let m = QueuedMessage(id: 20, botID: "bot1", body: "x", date: 5)
        try store.apply(m, notificationID: "n20")
        try store.markRead(botID: "bot1")
        try store.apply(m) // the later sync sees it again
        #expect(try store.message(id: 20)?.read == true)
        #expect(try store.clearMessages(botID: "bot1") == ["n20"])
    }

    @Test func chatsAndUnread() throws {
        let store = try tempStore()
        try store.apply(QueuedMessage(id: 1, botID: "bot1", body: "a", date: 100))
        try store.apply(QueuedMessage(id: 2, botID: "bot2", body: "b", date: 200))
        try store.apply(QueuedMessage(id: 3, botID: "bot2", body: "c", date: 300))
        var chats = try store.chats()
        #expect(chats.map(\.bot.id) == ["bot2", "bot1"], "latest first")
        #expect(chats.first?.unread == 2)
        #expect(chats.first?.last?.body == "c")
        #expect(try store.unreadTotal() == 3)

        try store.setPinned(botID: "bot1", true)
        try store.setMuted(botID: "bot2", true)
        chats = try store.chats()
        #expect(chats.map(\.bot.id) == ["bot1", "bot2"], "pinned first")
        #expect(try store.unreadTotal() == 1, "muted bots don't count")

        #expect(try store.messages(botID: "bot2").map(\.id) == [3, 2])
        #expect(try store.messages(botID: "bot2", before: 3).map(\.id) == [2])
    }

    @Test func replaceBotsDropsGoneBots() throws {
        let store = try tempStore()
        try store.apply(QueuedMessage(id: 1, botID: "bot2", body: "x"))
        try store.setMuted(botID: "bot1", true)
        try store.replaceBots([Bot(id: "bot1", name: "改名")])
        #expect(try store.bot(id: "bot2") == nil)
        #expect(try store.messages(botID: "bot2").isEmpty)
        #expect(try store.bot(id: "bot1")?.name == "改名")
        #expect(try store.isMuted(botID: "bot1"), "local flags survive")
    }

    @Test func cursor() throws {
        let store = try tempStore()
        #expect(store.syncCursor == 0)
        try store.setSyncCursor(42)
        #expect(store.syncCursor == 42)
    }

    @Test func concurrentFirstOpensAllMigrate() throws {
        // The app and the extension opening a new file together must both succeed.
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".sqlite").path
        let errors = NSLock()
        var failures: [Error] = []
        DispatchQueue.concurrentPerform(iterations: 8) { _ in
            do { _ = try LocalStore(path: path) } catch {
                errors.lock(); failures.append(error); errors.unlock()
            }
        }
        #expect(failures.isEmpty, "\(failures)")
        #expect(try LocalStore(path: path).chats().isEmpty)
    }

    @Test func unreadCount() throws {
        let store = try tempStore()
        try store.apply(QueuedMessage(id: 1, botID: "bot1", body: "a"))
        try store.apply(QueuedMessage(id: 2, botID: "bot1", body: "b"))
        #expect(try store.unreadCount(botID: "bot1") == 2)
        try store.markRead(botID: "bot1")
        #expect(try store.unreadCount(botID: "bot1") == 0)
    }

    @Test func migratesIntegerBotIDs() throws {
        // A v1 file: integer bot ids.
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".sqlite").path
        var db: OpaquePointer?
        #expect(sqlite3_open(path, &db) == SQLITE_OK)
        let v1 = """
        CREATE TABLE bots (id INTEGER PRIMARY KEY, name TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT '',
          default_level TEXT NOT NULL DEFAULT 'active', muted INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE messages (id INTEGER PRIMARY KEY, bot_id INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '',
          body TEXT NOT NULL DEFAULT '', html TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '',
          level TEXT NOT NULL DEFAULT '', group_key TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
          copy_text TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL DEFAULT '', collapse_id TEXT NOT NULL DEFAULT '',
          date INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0, notif_id TEXT);
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO bots (id, name, pinned) VALUES (4, '部署', 1);
        INSERT INTO messages (id, bot_id, body, date) VALUES (1, 4, 'old', 1);
        PRAGMA user_version = 1;
        """
        #expect(sqlite3_exec(db, v1, nil, nil, nil) == SQLITE_OK)
        sqlite3_close(db)

        let store = try LocalStore(path: path)
        #expect(try store.botIDs() == ["4"])
        #expect(try store.messages(botID: "4").map(\.body) == ["old"])
        // The gateway's list names it by its short id now; the local data moves over.
        try store.renameBot(from: "4", to: "aZ3kQ9xT")
        try store.replaceBots([Bot(id: "aZ3kQ9xT", name: "部署")])
        #expect(try store.messages(botID: "aZ3kQ9xT").map(\.body) == ["old"])
        #expect(try store.chats().first?.pinned == true)
        // Text ids that look like numbers stay text.
        try store.saveBot(Bot(id: "123", name: "n"))
        try store.apply(QueuedMessage(id: 2, botID: "123", body: "x"))
        #expect(try store.messages(botID: "123").count == 1)
    }

    @Test func twoConnectionsShareTheFile() throws {
        // The app and the extension each open the file.
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".sqlite").path
        let app = try LocalStore(path: path)
        let ext = try LocalStore(path: path)
        try app.replaceBots([Bot(id: "bot1", name: "b")])
        try ext.apply(QueuedMessage(id: 5, botID: "bot1", body: "from the extension"))
        #expect(try app.messages(botID: "bot1").first?.body == "from the extension")
    }
}

@Suite struct ModelTests {
    @Test func decodeGatewayMessage() throws {
        let json = #"{"message_id":7,"bot_id":"bot1","kind":"edit","target_id":3,"data":"{\"a\":1}","id":"dep","date":99}"#
        let m = try JSONDecoder().decode(QueuedMessage.self, from: Data(json.utf8))
        #expect(m == QueuedMessage(id: 7, botID: "bot1", kind: .edit, targetID: 3, data: #"{"a":1}"#, collapseID: "dep", date: 99))
        // A gateway from before short ids sends integers.
        let legacy = try JSONDecoder().decode(Bot.self, from: Data(#"{"id":4,"name":"b","avatar":"","default_level":"active","created_at":1,"updated_at":1}"#.utf8))
        #expect(legacy.id == "4" && BotID.isLegacy(legacy.id))
        #expect(!BotID.isLegacy("aZ3kQ9xT"))
    }

    @Test func pushInfo() {
        // APNs gives numbers, FCM data gives strings.
        #expect(PushInfo(userInfo: ["kind": "message", "msg_id": 7, "bot_id": "aZ3kQ9xT"])?.botID == "aZ3kQ9xT")
        #expect(PushInfo(userInfo: ["kind": "message", "msg_id": 7, "bot_id": 1])?.botID == "1")
        #expect(PushInfo(userInfo: ["kind": "delete", "msg_id": "8", "bot_id": "1", "target_id": "7"])?.targetID == 7)
        #expect(PushInfo(userInfo: ["aps": [String: Any]()]) == nil)
    }

    @Test func avatar() {
        #expect(Avatar("preset:box:#1c1c1e") == .preset(icon: "box", color: "#1c1c1e"))
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
                return (200, #"{"ok":true,"result":{"messages":[{"message_id":1,"bot_id":"bot1","kind":"message","body":"a","date":1}],"cursor":1,"has_more":true}}"#)
            }
            if url.contains("cursor=1") {
                return (200, #"{"ok":true,"result":{"messages":[{"message_id":2,"bot_id":"bot1","kind":"edit","target_id":1,"data":"d","date":2}],"cursor":2,"has_more":false}}"#)
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

    @Test func getMeByToken() async throws {
        MockGateway.requests = []
        MockGateway.handler = { req in
            req.url!.path == "/bot4:sec/getMe"
                ? (200, #"{"ok":true,"result":{"id":"aZ3kQ9xT","name":"b","avatar":"","default_level":"active","created_at":1,"updated_at":1}}"#)
                : (404, #"{"ok":false,"error_code":404,"description":"Not Found"}"#)
        }
        let api = APIClient(baseURL: URL(string: "https://gw.test/")!, secret: "s", session: MockGateway.session())
        #expect(try await api.getMe(token: "4:sec").id == "aZ3kQ9xT")
        #expect(MockGateway.requests.first?.value(forHTTPHeaderField: "Authorization") == nil)
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
        try store.apply(QueuedMessage(id: 1, botID: "bot1", body: "x"), notificationID: "n1")
        try store.setSyncCursor(9)
        #expect(try store.reset() == ["n1"])
        #expect(try store.chats().isEmpty)
        #expect(store.syncCursor == 0)
    }
}

@Suite struct KeychainTests {
    @Test func credentialsRoundTripWithoutTheGroupEntitlement() throws {
        // This test binary has no keychain-access-groups entitlement, like an
        // unsigned simulator build: the store must still save and read.
        let store = CredentialStore(service: "dev.evumi.honk.test.\(UUID().uuidString)", accessGroup: "ABCDE12345.dev.evumi.honk.shared")
        defer { store.clear() }
        let c = Credentials(deviceID: "d", secret: "s", pushToken: "t")
        try store.save(c)
        #expect(store.load() == c)
        store.clear()
        #expect(store.load() == nil)
    }
}

@Suite struct LocalAvatarTests {
    func temp() -> LocalAvatars {
        LocalAvatars(dir: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true))
    }

    @Test func parsesLocalAndDropsTheShip() {
        #expect(Avatar("local:ab-12.jpg") == .local("ab-12.jpg"))
        #expect(Avatar("local:ab-12.jpg").stringValue == "local:ab-12.jpg")
        #expect(Avatar("local:../x.jpg") == .default)
        #expect(Avatar("local:x.gif") == .default)
        #expect(Avatar("preset:ship:#1c1c1e") == .default, "the ship is no longer offered")
    }

    @Test func savesReadsAndPrunes() throws {
        let avatars = temp()
        let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3])
        let a = try avatars.save(png)
        #expect(a.hasPrefix("local:") && a.hasSuffix(".png"))
        #expect(avatars.data(for: a) == png)
        #expect(avatars.dataURL(for: a) == "data:image/png;base64," + png.base64EncodedString())
        #expect(avatars.data(for: "local:missing.png") == nil)
        let b = try avatars.save(Data([0xFF, 0xD8, 0xFF, 0xD9]))
        #expect(b.hasSuffix(".jpg"))
        #expect(throws: LocalAvatars.SaveError.self) { try avatars.save(Data("GIF89a".utf8)) }
        #expect(throws: LocalAvatars.SaveError.self) { try avatars.save(Data(count: LocalAvatars.maxBytes + 1)) }
        // Young files stay (a bot may be about to use them); old unused ones go.
        avatars.prune(keeping: [a])
        #expect(avatars.data(for: b) != nil)
        avatars.prune(keeping: [a], now: Date().addingTimeInterval(7200))
        #expect(avatars.data(for: b) == nil)
        #expect(avatars.data(for: a) != nil)
    }
}
