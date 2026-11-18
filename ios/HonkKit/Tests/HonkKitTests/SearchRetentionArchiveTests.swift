import Foundation
import Testing
@testable import HonkKit

// The same cases as android/core/src/test/kotlin/dev/evumi/honk/core/SearchRetentionArchiveTest.kt.

@Suite struct SearchTests {
    @Test func matchesTitleAndBodyNewestFirstInPages() throws {
        let store = try tempStore()
        try store.apply(QueuedMessage(id: 1, botID: "bot1", title: "Deploy ok", body: "x", date: 1))
        try store.apply(QueuedMessage(id: 2, botID: "bot2", title: "t", body: "the DEPLOY failed", date: 2))
        try store.apply(QueuedMessage(id: 3, botID: "bot1", title: "部署完成", body: "", date: 3))
        try store.apply(QueuedMessage(id: 4, botID: "bot1", title: "other", body: "none", date: 4))
        #expect(try store.search("deploy").map(\.id) == [2, 1], "ASCII case-insensitive, across bots")
        #expect(try store.search("部署").map(\.id) == [3])
        #expect(try store.search("deploy", limit: 1).map(\.id) == [2])
        #expect(try store.search("deploy", before: 2, limit: 1).map(\.id) == [1])
        #expect(try store.search("   ").isEmpty)
    }

    @Test func wildcardsAreLiteral() throws {
        let store = try tempStore()
        try store.apply(QueuedMessage(id: 1, botID: "bot1", title: "100% done", date: 1))
        try store.apply(QueuedMessage(id: 2, botID: "bot1", title: "a_b", date: 2))
        try store.apply(QueuedMessage(id: 3, botID: "bot1", title: "axb", date: 3))
        try store.apply(QueuedMessage(id: 4, botID: "bot1", title: #"back\slash"#, date: 4))
        #expect(try store.search("%").map(\.id) == [1])
        #expect(try store.search("_").map(\.id) == [2])
        #expect(try store.search("a_b").map(\.id) == [2])
        #expect(try store.search(#"\"#).map(\.id) == [4])
    }

    @Test func windowAroundAMessage() throws {
        let store = try tempStore()
        for i in 1...100 { try store.apply(QueuedMessage(id: Int64(i), botID: "bot1", body: "m\(i)", date: Int64(i))) }
        try store.apply(QueuedMessage(id: 500, botID: "bot2", body: "other bot", date: 500))
        let w = try store.messages(botID: "bot1", around: 50, limit: 10).map(\.id)
        #expect(w == [55, 54, 53, 52, 51, 50, 49, 48, 47, 46], "five newer, the message and the rest older")
        // Near the newest end the window fills up with older ones.
        #expect(try store.messages(botID: "bot1", around: 99, limit: 10).map(\.id) == [100, 99, 98, 97, 96, 95, 94, 93, 92, 91])
        // Not this bot's message: the newest.
        #expect(try store.messages(botID: "bot1", around: 500, limit: 3).map(\.id) == [100, 99, 98])
    }
}

@Suite struct RetentionTests {
    @Test func prunesOldMessagesAndReturnsTheirNotifications() throws {
        let store = try tempStore()
        let day: Int64 = 86_400_000
        let now: Int64 = 1_000 * day
        try store.apply(QueuedMessage(id: 1, botID: "bot1", body: "old", date: now - 40 * day), notificationID: "n1")
        try store.apply(QueuedMessage(id: 2, botID: "bot1", body: "recent", date: now - 10 * day), notificationID: "n2")
        try store.apply(QueuedMessage(id: 3, botID: "bot2", body: "older", date: now - 400 * day))

        #expect(try store.retentionDays == 0)
        #expect(try store.pruneExpired(now: now).isEmpty, "forever keeps everything")
        #expect(try store.exportMessages().count == 3)

        try store.setRetentionDays(30)
        #expect(try store.retentionDays == 30)
        #expect(try store.pruneExpired(now: now) == ["n1"])
        #expect(try store.exportMessages().map(\.id) == [2])

        try store.setRetentionDays(365)
        try store.apply(QueuedMessage(id: 4, botID: "bot1", body: "x", date: now - 366 * day))
        try store.pruneExpired(now: now)
        #expect(try store.exportMessages().map(\.id) == [2])
    }

    @Test func choiceSurvivesAGatewayReset() throws {
        let store = try tempStore()
        try store.setRetentionDays(90)
        try store.setSyncCursor(7)
        try store.reset()
        #expect(store.retentionDays == 90)
        #expect(store.syncCursor == 0)
    }
}

@Suite struct ArchiveTests {
    @Test func linesMatchTheAppAPIAndRoundTrip() throws {
        let store = try tempStore()
        try store.apply(QueuedMessage(id: 1, botID: "bot1", title: "部署", body: "完成 \"ok\"\n第二行", html: "<b>x</b>", data: #"{"a":1}"#,
                                      level: "active", group: "g", url: "https://x.test/a", copy: "c", icon: "bell", open: "url",
                                      image: "https://x.test/i.png", parseMode: "Markdown", silent: true, collapseID: "dep", date: 10))
        try store.apply(QueuedMessage(id: 2, botID: "bot2", body: "plain", date: 20))
        let data = try MessageArchive.encode(try store.exportMessages())
        let lines = String(decoding: data, as: UTF8.self).split(separator: "\n")
        #expect(lines.count == 2)
        #expect(lines[1] == #"{"body":"plain","bot_id":"bot2","date":20,"kind":"message","message_id":2}"#, "empty fields are left out")
        #expect(lines[0].contains(#""id":"dep""#), "the collapse id is `id`, as in the API")

        let back = MessageArchive.decode(data)
        #expect(back.invalid == 0)
        #expect(back.messages.count == 2)
        #expect(back.messages[0].collapseID == "dep" && back.messages[0].body == "完成 \"ok\"\n第二行")
        let m = back.messages[0]
        #expect(m.open == "url" && m.image == "https://x.test/i.png" && m.parseMode == "Markdown" && m.silent)
        #expect(back.messages[1].silent == false && back.messages[1].open == "")
        // Importing keeps them.
        let target = try tempStore()
        _ = try target.importMessages(back.messages)
        let kept = try #require(try target.message(id: 1))
        #expect(kept.open == "url" && kept.image == "https://x.test/i.png" && kept.parseMode == "Markdown" && kept.silent)
    }

    @Test func badLinesAreCounted() {
        let text = "\n{\"message_id\":1,\"bot_id\":\"b\",\"kind\":\"message\",\"date\":1}\r\nnot json\n{\"bot_id\":\"b\"}\n  \n"
        let d = MessageArchive.decode(Data(text.utf8))
        #expect(d.messages.map(\.id) == [1])
        #expect(d.invalid == 2)
    }

    @Test func importIsIdempotentAndSkipsUnknownBots() throws {
        let source = try tempStore()
        try source.apply(QueuedMessage(id: 1, botID: "bot1", body: "a", collapseID: "k", date: 1))
        try source.apply(QueuedMessage(id: 2, botID: "bot1", body: "b", date: 2))
        try source.apply(QueuedMessage(id: 3, botID: "bot2", body: "c", date: 3))
        try source.apply(QueuedMessage(id: 4, botID: "bot1", body: "newer k", collapseID: "k", date: 4))
        let archive = try MessageArchive.encode(try source.exportMessages(botID: "bot1"))
        #expect(try source.exportMessages(botID: "bot1").map(\.id) == [2, 4])

        let target = try tempStore()
        try target.deleteBot(id: "bot2")
        let items = MessageArchive.decode(archive).messages + [QueuedMessage(id: 9, botID: "gone", body: "z", date: 9)]
        let first = try target.importMessages(items)
        #expect(first == .init(imported: 2, existing: 0, unknownBot: 1))
        #expect(try target.exportMessages().map(\.id) == [2, 4])
        #expect(try target.unreadCount(botID: "bot1") == 0, "imported messages arrive read")

        let again = try target.importMessages(items)
        #expect(again == .init(imported: 0, existing: 2, unknownBot: 1))
        #expect(try target.exportMessages().map(\.id) == [2, 4])

        // An older message of a collapse id does not replace a newer stored one.
        let old = try target.importMessages([QueuedMessage(id: 1, botID: "bot1", body: "a", collapseID: "k", date: 1)])
        #expect(old.existing == 1)
        #expect(try target.exportMessages().map(\.id) == [2, 4])
    }

    @Test func fileNames() {
        let d = Date(timeIntervalSince1970: 1_767_312_000) // 2026-01-02 UTC
        #expect(MessageArchive.fileName(botName: nil, now: d).hasPrefix("honk-all-"))
        #expect(MessageArchive.fileName(botName: "My Bot/部署", now: d).hasPrefix("honk-My-Bot-部署-"))
        #expect(MessageArchive.fileName(botName: "///", now: d).hasPrefix("honk-bot-"))
    }
}
