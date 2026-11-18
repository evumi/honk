import Foundation
import HonkCard
import Testing

private func load(_ script: String, allowQueries: Bool = false) -> String {
    let tree: [[String: Any]] = [
        ["type": "element", "tag": "p", "attrs": ["id": "out"], "children": [["type": "text", "text": "static"]]],
        ["type": "element", "tag": "script", "attrs": [:], "children": [["type": "text", "text": script]]],
    ]
    let load: [String: Any] = ["tree": tree, "data": "{}", "theme": ["--tg-color-scheme": "light"], "language": "en", "active": true, "allowQueries": allowQueries]
    return String(data: try! JSONSerialization.data(withJSONObject: load), encoding: .utf8)!
}

private final class Changes: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [(String, String)] = []
    func add(_ key: String, _ result: String) { lock.withLock { items.append((key, result)) } }
    var all: [(String, String)] { lock.withLock { items } }
}

@Test func opensClicksAndCloses() async throws {
    let host = CardHost { _, _ in }
    let r = await host.open(key: "a", load: load("""
        var b = document.createElement('button'); b.textContent = 'go'; document.body.appendChild(b);
        b.addEventListener('click', function () { b.textContent = 'went'; TelegramWidget.openLink('https://example.com') });
        """))
    #expect(r.contains("\"text\":\"go\""))
    let c = await host.click(key: "a", path: "[2]")
    #expect(c.contains("\"text\":\"went\""))
    #expect(c.contains("\"open\":\"https://example.com\""))
    await host.close(key: "a")
    #expect(host.count == 0)
    let gone = await host.click(key: "a", path: "[2]")
    #expect(gone.contains("\"stopped\":\"closed\""))
}

@Test func timersReportChanges() async throws {
    let changes = Changes()
    let host = CardHost { changes.add($0, $1) }
    _ = await host.open(key: "t", load: load("""
        var n = 0; var id = setInterval(function () { n++; document.getElementById('out').textContent = 'tick ' + n; if (n === 2) clearInterval(id) }, 20);
        """))
    try await Task.sleep(nanoseconds: 300_000_000)
    let all = changes.all
    #expect(all.count == 2)
    #expect(all.last?.0 == "t")
    #expect(all.last?.1.contains("tick 2") == true)
}

@Test func endlessLoopStopsWithoutBlockingOtherCards() async throws {
    let host = CardHost { _, _ in }
    let start = Date()
    let r = await host.open(key: "loop", load: load("while (true) {}"))
    #expect(r.contains("\"stopped\":\"time\""))
    #expect(Date().timeIntervalSince(start) < 1)
    let ok = await host.open(key: "ok", load: load("document.getElementById('out').textContent = 'fine'"))
    #expect(ok.contains("fine"))
}

@Test func requestsGoOutAndAnswersComeBack() async throws {
    let host = CardHost { _, _ in }
    _ = await host.open(key: "q", load: load("""
        var p = document.getElementById('out');
        var b = document.createElement('button'); document.body.appendChild(b);
        b.addEventListener('click', function () {
          TelegramWidget.request('ping').then(function (v) { p.textContent = 'got ' + v }, function (e) { p.textContent = 'err ' + e.code });
        });
        """, allowQueries: true))
    let c = await host.click(key: "q", path: "[2]")
    #expect(c.contains("\"request\":{\"seq\":1,\"data\":\"ping\"}"))
    let a = await host.answer(key: "q", seq: 1, ok: true, data: "pong \u{1F600}")
    #expect(a.contains("got pong \u{1F600}"))
    let again = await host.answer(key: "q", seq: 1, ok: true, data: "x")
    #expect(again.contains("\"tree\":null"))
    let c2 = await host.click(key: "q", path: "[2]")
    #expect(c2.contains("\"seq\":2"))
    let f = await host.answer(key: "q", seq: 2, ok: false, data: "NETWORK")
    #expect(f.contains("err NETWORK"))
    let gone = await host.answer(key: "nope", seq: 1, ok: true, data: "x")
    #expect(gone.contains("\"stopped\":\"closed\""))
}

@Test func requestsAreRefusedWithoutAllowQueries() async throws {
    let host = CardHost { _, _ in }
    _ = await host.open(key: "n", load: load("""
        var p = document.getElementById('out');
        var b = document.createElement('button'); document.body.appendChild(b);
        b.addEventListener('click', function () {
          TelegramWidget.request('ping').then(function (v) { p.textContent = 'got ' + v }, function (e) { p.textContent = 'err ' + e.code });
        });
        """))
    let c = await host.click(key: "n", path: "[2]")
    #expect(c.contains("err NOT_ALLOWED"))
    #expect(!c.contains("\"request\""))
}

@Test func anOpenAfterItsCloseIsRefused() async throws {
    let host = CardHost { _, _ in }
    await host.close(key: "late")
    let r = await host.open(key: "late", load: load("setInterval(function () {}, 16)"))
    #expect(r.contains("\"stopped\":\"closed\""))
    #expect(host.count == 0)
}

@Test func closesOldCardsPastTheMemoryBudget() async throws {
    let host = CardHost { _, _ in }
    // About 5 MB each: seven of them pass 32 MB.
    for i in 0..<7 { _ = await host.open(key: "m\(i)", load: load("var keep = []; for (var i = 0; i < 60; i++) keep.push(new Array(10000).fill(i + 0.5));")) }
    #expect(host.count < 7)
    let newest = await host.set(key: "m6", state: "{}")
    #expect(!newest.contains("\"stopped\":\"closed\""))
    let oldest = await host.set(key: "m0", state: "{}")
    #expect(oldest.contains("\"stopped\":\"closed\""))
}

@Test func keepsAtMostMaxCards() async throws {
    let host = CardHost { _, _ in }
    for i in 0..<(CardHost.maxCards + 3) { _ = await host.open(key: "k\(i)", load: load("")) }
    #expect(host.count == CardHost.maxCards)
    let first = await host.set(key: "k0", state: "{}")
    #expect(first.contains("\"stopped\":\"closed\""))
}
