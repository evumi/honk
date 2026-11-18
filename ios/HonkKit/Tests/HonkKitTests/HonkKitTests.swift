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

    @Test func notificationThreads() {
        #expect(NotificationThread.identifier(botID: "aZ3kQ9xT", group: "") == "bot-aZ3kQ9xT")
        #expect(NotificationThread.identifier(botID: "aZ3kQ9xT", group: "prod") == "bot-aZ3kQ9xT:prod")
        // The gateway's thread-id: b<bot>:<group>, or b<bot> without a group.
        #expect(NotificationThread.group(fromAPNsThread: "baZ3kQ9xT:prod", botID: "aZ3kQ9xT") == "prod")
        #expect(NotificationThread.group(fromAPNsThread: "baZ3kQ9xT:a:b", botID: "aZ3kQ9xT") == "a:b")
        #expect(NotificationThread.group(fromAPNsThread: "baZ3kQ9xT", botID: "aZ3kQ9xT") == "")
        #expect(NotificationThread.group(fromAPNsThread: "", botID: "aZ3kQ9xT") == "")
        #expect(NotificationThread.group(fromAPNsThread: "bOther:prod", botID: "aZ3kQ9xT") == "")
    }

    @Test func avatar() {
        #expect(Avatar("preset:box:#1c1c1e") == .preset(icon: "box", color: "#1c1c1e"))
        #expect(Avatar("https://e.com/a.png") == .image(URL(string: "https://e.com/a.png")!))
        #expect(Avatar("http://e.com/a.png") == .default)
        #expect(Avatar("preset:nope:#000000") == .preset(icon: "bell", color: "#000000"))
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

    @Test func pushBeforeTheRefreshRenamesFirst() async throws {
        let store = try legacyStore()
        try store.setMuted(botID: "4", true)
        MockGateway.handler = { req in
            switch req.url!.path {
            case "/v1/bots":
                return (200, #"{"ok":true,"result":[{"id":"aZ3kQ9xT","name":"部署","created_at":100,"updated_at":1}]}"#)
            case "/bot4:sec/getMe":
                return (200, #"{"ok":true,"result":{"id":"aZ3kQ9xT","name":"部署","created_at":100,"updated_at":1}}"#)
            default:
                return (404, #"{"ok":false,"error_code":404,"description":"Not Found"}"#)
            }
        }
        let api = APIClient(baseURL: URL(string: "https://gw.test/")!, secret: "s", session: MockGateway.session())
        await LegacyBotIDs.renameBeforePush(store: store, tokens: MemoryTokens(["4": "4:sec"]), api: api)
        #expect(try store.bot(id: "aZ3kQ9xT")?.name == "部署")
        #expect(try store.isMuted(botID: "aZ3kQ9xT"), "the push sees the bot's mute flag")
        #expect(try store.bot(id: "5") == nil, "a legacy bot the list lacks goes, as in a refresh")
        // Nothing to do once renamed: no more requests.
        MockGateway.requests = []
        await LegacyBotIDs.renameBeforePush(store: store, tokens: MemoryTokens(), api: api)
        #expect(MockGateway.requests.isEmpty)
    }

    @Test func registerSendsTheRegisterKeyOnlyWhenSet() async throws {
        MockGateway.requests = []
        MockGateway.handler = { _ in (200, #"{"ok":true,"result":{"device":{"id":"d","platform":"ios","push_ok":true},"device_secret":"sec"}}"#) }
        let api = APIClient(baseURL: URL(string: "https://gw.test/")!, secret: nil, session: MockGateway.session())
        func body(_ i: Int) throws -> [String: String] {
            let data = MockGateway.requests[i].httpBody ?? MockGateway.requests[i].httpBodyStream.map { s in
                s.open(); defer { s.close() }
                var d = Data(); var buf = [UInt8](repeating: 0, count: 1024)
                while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; d.append(buf, count: n) }
                return d
            } ?? Data()
            return try JSONDecoder().decode([String: String].self, from: data)
        }
        _ = try await api.registerDevice(pushToken: "t", registerKey: "s3cret")
        _ = try await api.registerDevice(pushToken: "t")
        _ = try await api.registerDevice(pushToken: "t", registerKey: "")
        #expect(try body(0)["register_key"] == "s3cret")
        #expect(try body(1)["register_key"] == nil)
        #expect(try body(2)["register_key"] == nil)
    }

    @Test func deleteDeviceCallsTheGatewayWithTheDeviceSecret() async throws {
        MockGateway.requests = []
        MockGateway.handler = { req in
            req.httpMethod == "DELETE" && req.url!.path == "/v1/devices/me"
                ? (200, #"{"ok":true,"result":true}"#)
                : (404, #"{"ok":false,"error_code":404,"description":"Not Found"}"#)
        }
        let api = APIClient(baseURL: URL(string: "https://gw.test/")!, secret: "s3cret", session: MockGateway.session())
        try await api.deleteDevice()
        #expect(MockGateway.requests.first?.value(forHTTPHeaderField: "Authorization") == "Bearer s3cret")

        MockGateway.handler = { _ in (500, #"{"ok":false,"error_code":500,"description":"Internal Server Error"}"#) }
        let error = await #expect(throws: APIError.self) { try await api.deleteDevice() }
        #expect(error == .gateway(code: 500, description: "Internal Server Error"))
        let anonymous = APIClient(baseURL: URL(string: "https://gw.test/")!, secret: nil, session: MockGateway.session())
        await #expect(throws: APIError.notRegistered) { try await anonymous.deleteDevice() }
    }

    @Test func infoSaysWhetherARegisterKeyIsRequired() async throws {
        let api = APIClient(baseURL: URL(string: "https://gw.test/")!, secret: nil, session: MockGateway.session())
        MockGateway.handler = { _ in (200, #"{"ok":true,"result":{"name":"honk","version":"1","api":2,"register_key_required":true}}"#) }
        #expect(try await api.info().registerKeyRequired)
        MockGateway.handler = { _ in (200, #"{"ok":true,"result":{"name":"honk","version":"1","api":2}}"#) }
        #expect(try await api.info().registerKeyRequired == false)
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

@Suite struct RegisterKeyTests {
    @Test func saveLoadAndClear() {
        let store = RegisterKeyStore(service: "dev.evumi.honk.test.\(UUID().uuidString)", accessGroup: nil)
        defer { store.clear() }
        #expect(store.load() == nil)
        store.save("s3cret")
        #expect(store.load() == "s3cret")
        store.save("other")
        #expect(store.load() == "other")
        store.save("")
        #expect(store.load() == nil, "an empty key removes it")
        store.save("again")
        store.save(nil)
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
        #expect(Avatar("local:x.bmp") == .default)
        #expect(Avatar("local:x.webp") == .local("x.webp"))
        #expect(Avatar("preset:ship:#c2410c") == .preset(icon: "bell", color: "#c2410c"), "the ship is gone; its colour stays")
    }

    @Test func removeAllForgetsEveryImage() throws {
        let avatars = temp()
        let a = try avatars.save(Data([0xFF, 0xD8, 0xFF, 0xD9]))
        #expect(avatars.data(for: a) != nil)
        avatars.removeAll()
        #expect(avatars.data(for: a) == nil)
        avatars.removeAll() // nothing left: no harm
        let b = try avatars.save(Data([0xFF, 0xD8, 0xFF, 0xD9]))
        #expect(avatars.data(for: b) != nil, "saving works again")
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
        #expect(try avatars.save(Data("GIF89a\u{1}\u{0}".utf8)).hasSuffix(".gif"))
        let webp = try avatars.save(Data("RIFF\u{0}\u{0}\u{0}\u{0}WEBPVP8 ".utf8))
        #expect(webp.hasSuffix(".webp") && avatars.dataURL(for: webp)?.hasPrefix("data:image/webp;base64,") == true)
        #expect(throws: LocalAvatars.SaveError.self) { try avatars.save(Data("BM\u{0}\u{0}".utf8)) }
        #expect(throws: LocalAvatars.SaveError.self) { try avatars.save(Data(count: LocalAvatars.maxBytes + 1)) }
        // Young files stay (a bot may be about to use them); old unused ones go.
        avatars.prune(keeping: [a])
        #expect(avatars.data(for: b) != nil)
        avatars.prune(keeping: [a], now: Date().addingTimeInterval(7200))
        #expect(avatars.data(for: b) == nil)
        #expect(avatars.data(for: webp) == nil)
        #expect(avatars.data(for: a) != nil)
    }
}

final class MemoryTokens: BotTokenStoring, @unchecked Sendable {
    var map: [String: String]
    init(_ map: [String: String] = [:]) { self.map = map }
    func token(botID: String) -> String? { map[botID] }
    func save(_ token: String, botID: String) { map[botID] = token }
    func remove(botID: String) { map[botID] = nil }
}

struct Offline: Error {}

/// A store with legacy bots "4" (token "4:sec", pinned, one message) and "5" (no token).
func legacyStore() throws -> LocalStore {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".sqlite").path
    let store = try LocalStore(path: path)
    try store.saveBot(Bot(id: "4", name: "部署", createdAt: 100))
    try store.saveBot(Bot(id: "5", name: "告警", createdAt: 200))
    try store.setPinned(botID: "4", true)
    try store.apply(QueuedMessage(id: 1, botID: "4", body: "old"), notificationID: "n1")
    return store
}

let serverBots = [Bot(id: "aZ3kQ9xT", name: "部署", createdAt: 100), Bot(id: "bQ7mN2pR", name: "告警", createdAt: 200)]

@Suite struct LegacyBotIDTests {
    @Test func renamesByTokenAndByCreationAndName() async throws {
        let store = try legacyStore()
        let tokens = MemoryTokens(["4": "4:sec"])
        let out = await LegacyBotIDs.rename(store: store, tokens: tokens, serverBots: serverBots) { token in
            #expect(token == "4:sec")
            return serverBots[0]
        }
        #expect(out.renamed == [.init(old: "4", new: "aZ3kQ9xT"), .init(old: "5", new: "bQ7mN2pR")])
        #expect(out.pending.isEmpty)
        try store.replaceBots(serverBots, keeping: out.pending)
        #expect(try store.messages(botID: "aZ3kQ9xT").map(\.body) == ["old"])
        #expect(try store.chats().first { $0.bot.id == "aZ3kQ9xT" }?.pinned == true)
        #expect(tokens.map == ["aZ3kQ9xT": "4:sec"])
        // Taps on notifications from before the rename still find the bot.
        #expect(store.currentBotID("4") == "aZ3kQ9xT")
        #expect(store.currentBotID("aZ3kQ9xT") == "aZ3kQ9xT")
        #expect(store.currentBotID("9") == "9")
        // The old notification id still removes it.
        #expect(try store.markRead(botID: "aZ3kQ9xT") == ["n1"])
    }

    @Test func transientFailureKeepsTheBot() async throws {
        let store = try legacyStore()
        try store.saveBot(Bot(id: "6", name: "部署", createdAt: 100)) // a twin: no safe match by name
        let tokens = MemoryTokens(["4": "4:sec"])
        let out = await LegacyBotIDs.rename(store: store, tokens: tokens, serverBots: serverBots) { _ in throw Offline() }
        #expect(out.pending == ["4"])
        try store.replaceBots(serverBots, keeping: out.pending)
        #expect(try store.messages(botID: "4").map(\.body) == ["old"], "kept for the next try")
        #expect(tokens.map == ["4": "4:sec"])
        #expect(try store.bot(id: "6") == nil, "an unmatched bot without a pending rename goes")
    }

    @Test func pendingBotMergesIntoItsListedRowLater() async throws {
        // Refresh 1: getMe is offline, so "4" stays pending while the list's short id is stored too.
        let store = try legacyStore()
        try store.saveBot(Bot(id: "6", name: "部署", createdAt: 100)) // a twin: no safe match by name
        try store.setMuted(botID: "4", true)
        let tokens = MemoryTokens(["4": "4:sec"])
        let first = await LegacyBotIDs.rename(store: store, tokens: tokens, serverBots: serverBots) { _ in throw Offline() }
        try store.replaceBots(serverBots, keeping: first.pending)
        try store.apply(QueuedMessage(id: 2, botID: "aZ3kQ9xT", body: "new"))
        #expect(try store.bot(id: "aZ3kQ9xT") != nil && store.bot(id: "4") != nil)
        // Refresh 2: getMe answers; the two rows merge instead of the old one being dropped.
        let second = await LegacyBotIDs.rename(store: store, tokens: tokens, serverBots: serverBots) { _ in serverBots[0] }
        #expect(second.renamed == [.init(old: "4", new: "aZ3kQ9xT")])
        try store.replaceBots(serverBots, keeping: second.pending)
        #expect(try store.messages(botID: "aZ3kQ9xT").map(\.body) == ["new", "old"])
        #expect(try store.isMuted(botID: "aZ3kQ9xT"))
        #expect(try store.chats().first { $0.bot.id == "aZ3kQ9xT" }?.pinned == true)
        #expect(try store.bot(id: "4") == nil)
        #expect(tokens.map == ["aZ3kQ9xT": "4:sec"])
    }

    @Test func getMeAnswerIsNotSecondGuessedByName() async throws {
        // The token names a bot the gateway no longer lists: no matching by name and time.
        let store = try legacyStore()
        let out = await LegacyBotIDs.rename(store: store, tokens: MemoryTokens(["4": "4:sec"]), serverBots: serverBots) { _ in
            Bot(id: "gone1234", name: "部署", createdAt: 100)
        }
        #expect(out.renamed == [.init(old: "5", new: "bQ7mN2pR")])
    }

    @Test func goneTokenFallsBackToCreationAndName() async throws {
        let store = try legacyStore()
        let out = await LegacyBotIDs.rename(store: store, tokens: MemoryTokens(["4": "4:old"]), serverBots: serverBots) { _ in
            throw APIError.gateway(code: 401, description: "Unauthorized")
        }
        #expect(out.renamed.map(\.new) == ["aZ3kQ9xT", "bQ7mN2pR"])
        #expect(out.pending.isEmpty)
    }

    @Test func noMatchIsDropped() async throws {
        let store = try legacyStore()
        let others = [Bot(id: "cX1", name: "别的", createdAt: 100)]
        let out = await LegacyBotIDs.rename(store: store, tokens: MemoryTokens(), serverBots: others) { _ in
            Issue.record("no token, no getMe")
            throw Offline()
        }
        #expect(out == .init())
        try store.replaceBots(others, keeping: out.pending)
        #expect(try store.botIDs() == ["cX1"])
    }
}
