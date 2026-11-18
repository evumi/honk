import Foundation
import SQLite3
import Testing
@testable import HonkKit

/// Collects what the fake card and app saw.
private final class Log: @unchecked Sendable {
    private let lock = NSLock()
    private var _queries: [(Int64, String)] = []
    private var _answers: [(String, Int, Bool, String)] = []
    private var _changes: [(String, String)] = []
    var queries: [(Int64, String)] { lock.withLock { _queries } }
    var answers: [(String, Int, Bool, String)] { lock.withLock { _answers } }
    var changes: [(String, String)] { lock.withLock { _changes } }
    func query(_ m: Int64, _ d: String) { lock.withLock { _queries.append((m, d)) } }
    func answer(_ k: String, _ s: Int, _ ok: Bool, _ d: String) { lock.withLock { _answers.append((k, s, ok, d)) } }
    func change(_ k: String, _ r: String) { lock.withLock { _changes.append((k, r)) } }
}

private let drawn = #"{"tree":[{"type":"text","text":"7"}],"prevented":false,"stopped":null,"logs":[]}"#
private let load = #"{"tree":[],"data":"{}","messageId":42,"allowQueries":true}"#

private func requests(_ log: Log, reply: @escaping @Sendable (Int64, String) async throws -> String,
                      answerResult: String = drawn) -> CardRequests {
    CardRequests(
        query: { m, d in
            log.query(m, d)
            return try await reply(m, d)
        },
        answer: { k, s, ok, d in
            log.answer(k, s, ok, d)
            return answerResult
        },
        changed: { k, r in log.change(k, r) })
}

@Suite struct CardRequestsTests {
    @Test func theRequestIsCutOutOfTheResultAndServed() async throws {
        let log = Log()
        let cr = requests(log) { _, _ in "7" }
        cr.opened(key: "c1", load: load)
        let click = #"{"tree":null,"prevented":false,"stopped":null,"logs":[],"request":{"seq":3,"data":"plus"}}"#
        let forApp = cr.filter(key: "c1", result: click)
        let obj = try #require(try JSONSerialization.jsonObject(with: Data(forApp.utf8)) as? [String: Any])
        #expect(obj["request"] == nil && obj["prevented"] as? Bool == false && obj["tree"] is NSNull)

        // The query runs in the background: wait for the card's redraw.
        for _ in 0..<200 where log.changes.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        #expect(log.queries.count == 1 && log.queries[0].0 == 42 && log.queries[0].1 == "plus")
        #expect(log.answers.count == 1 && log.answers[0] == ("c1", 3, true, "7"))
        #expect(log.changes.count == 1 && log.changes[0].0 == "c1" && log.changes[0].1 == drawn)
    }

    @Test func aResultWithoutARequestIsLeftAlone() {
        let cr = requests(Log()) { _, _ in "" }
        let plain = #"{"tree":null,"prevented":false,"stopped":null,"logs":[]}"#
        #expect(cr.filter(key: "c1", result: plain) == plain)
        // The word in a log line is not a request.
        let logged = #"{"tree":null,"prevented":false,"stopped":null,"logs":["\"request\""]}"#
        #expect(cr.filter(key: "c1", result: logged) == logged)
    }

    @Test func failuresBecomeCodesTheCardCanSee() async throws {
        let cases: [(Error, String)] = [
            (APIError.gateway(code: 504, description: "Gateway Timeout"), "TIMEOUT"),
            (APIError.gateway(code: 403, description: "Forbidden"), "NOT_ALLOWED"),
            (APIError.gateway(code: 404, description: "Not Found"), "NOT_ALLOWED"),
            (APIError.gateway(code: 429, description: "Too Many Requests"), "RATE_LIMITED"),
            (APIError.gateway(code: 502, description: "Bad Gateway"), "REQUEST_FAILED"),
            (URLError(.timedOut), "TIMEOUT"),
            (URLError(.notConnectedToInternet), "NETWORK"),
        ]
        for (error, code) in cases {
            let log = Log()
            let cr = requests(log) { _, _ in throw error }
            cr.opened(key: "c1", load: load)
            await cr.serve(key: "c1", seq: 1, data: "x")
            #expect(log.answers.count == 1 && log.answers[0] == ("c1", 1, false, code), "\(error) → \(code)")
        }
    }

    @Test func aCardThatMayNotQueryIsRefusedWithoutAQuery() async {
        for l in [#"{"tree":[],"messageId":42,"allowQueries":false}"#, #"{"tree":[]}"#, "not json"] {
            let log = Log()
            let cr = requests(log) { _, _ in "never" }
            cr.opened(key: "c1", load: l)
            await cr.serve(key: "c1", seq: 2, data: "x")
            #expect(log.queries.isEmpty)
            #expect(log.answers.count == 1 && log.answers[0] == ("c1", 2, false, "NOT_ALLOWED"))
        }
        // A closed card (or one never opened) is refused too.
        let log = Log()
        let cr = requests(log) { _, _ in "never" }
        cr.opened(key: "c1", load: load)
        cr.closed(key: "c1")
        await cr.serve(key: "c1", seq: 3, data: "x")
        #expect(log.queries.isEmpty && log.answers.first?.3 == "NOT_ALLOWED")
    }

    @Test func anEmptyAnswerResultIsNotReported() async {
        let log = Log()
        let quiet = #"{"tree":null,"prevented":false,"stopped":null,"logs":[]}"#
        let cr = requests(log, reply: { _, _ in "ok" }, answerResult: quiet)
        cr.opened(key: "c1", load: load)
        await cr.serve(key: "c1", seq: 1, data: "x")
        #expect(log.changes.isEmpty)
        // A log line is worth reporting.
        let cr2 = requests(log, reply: { _, _ in "ok" }, answerResult: #"{"tree":null,"prevented":false,"stopped":null,"logs":["hi"]}"#)
        cr2.opened(key: "c1", load: load)
        await cr2.serve(key: "c1", seq: 1, data: "x")
        #expect(log.changes.count == 1)
    }
}

@Suite struct AllowQueriesStoreTests {
    @Test func theFlagIsStoredAndEditsKeepIt() throws {
        let store = try tempStore()
        try store.apply(QueuedMessage(id: 1, botID: "bot1", body: "a", allowQueries: true, date: 1))
        try store.apply(QueuedMessage(id: 2, botID: "bot1", body: "b", date: 2))
        #expect(try store.message(id: 1)?.allowQueries == true)
        #expect(try store.message(id: 2)?.allowQueries == false)
        try store.apply(QueuedMessage(id: 3, botID: "bot1", kind: .edit, targetID: 1, data: "{}"))
        #expect(try store.message(id: 1)?.allowQueries == true)
        // Applying the same item twice is harmless.
        try store.apply(QueuedMessage(id: 1, botID: "bot1", body: "a", allowQueries: true, date: 1))
        #expect(try store.messages(botID: "bot1").count == 2)
    }

    @Test func aV3FileGetsTheColumn() throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".sqlite").path
        let first = try LocalStore(path: path)
        try first.replaceBots([Bot(id: "bot1", name: "n")])
        try first.apply(QueuedMessage(id: 1, botID: "bot1", body: "old", date: 1))
        // Make it look like v3 again.
        var db: OpaquePointer?
        #expect(sqlite3_open(path, &db) == SQLITE_OK)
        #expect(sqlite3_exec(db, "ALTER TABLE messages DROP COLUMN allow_queries; ALTER TABLE messages DROP COLUMN placeholder; PRAGMA user_version = 3;", nil, nil, nil) == SQLITE_OK)
        sqlite3_close(db)
        let store = try LocalStore(path: path)
        #expect(try store.message(id: 1)?.allowQueries == false)
        try store.apply(QueuedMessage(id: 2, botID: "bot1", body: "new", allowQueries: true, date: 2))
        #expect(try store.message(id: 2)?.allowQueries == true)
    }

    @Test func theGatewayJSONCarriesTheFlag() throws {
        let m = try JSONDecoder().decode(QueuedMessage.self, from: Data(#"{"message_id":1,"bot_id":"aZ3kQ9xT","kind":"message","allow_queries":true}"#.utf8))
        #expect(m.allowQueries)
        let n = try JSONDecoder().decode(QueuedMessage.self, from: Data(#"{"message_id":1,"bot_id":"aZ3kQ9xT","kind":"message"}"#.utf8))
        #expect(!n.allowQueries)
    }
}
