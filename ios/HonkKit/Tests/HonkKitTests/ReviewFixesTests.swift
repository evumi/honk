import Foundation
import Testing
@testable import HonkKit

// Review fixes shared with android/core/.../HostReviewFixesTest.kt.

private func bot(_ id: String, encrypted: Bool, wrapped: String = "") -> Bot {
    var b = Bot(id: id, name: id)
    b.encrypted = encrypted
    b.keyWrapped = wrapped
    return b
}

@Suite(.serialized) struct ReviewFixesTests {
    @Test func reconcileDropsTheKeyOfABotThatIsNotEncryptedAnymore() async {
        let ring = KeyRing(keys: MemoryBotKeys(), group: MemoryGroupKey())
        ring.keys.save(Seal.generateKey(), botID: "b1")
        ring.keys.save(Seal.generateKey(), botID: "b2")
        await ring.reconcile(bots: [bot("b1", encrypted: false), bot("b2", encrypted: true)]) { _, _ in }
        #expect(ring.keys.key(botID: "b1") == nil)
        #expect(ring.keys.key(botID: "b2") != nil)
    }

    @Test func aNoOpReconcileDoesNotMakeAGroupKey() async {
        let ring = KeyRing(keys: MemoryBotKeys(), group: MemoryGroupKey())
        #expect(ring.wrapped(botID: "b1") == nil)
        await ring.reconcile(bots: [bot("b1", encrypted: true)]) { _, _ in }
        #expect(ring.group.groupKey() == nil)
        ring.keys.save(Seal.generateKey(), botID: "b1")
        #expect(ring.wrapped(botID: "b1") == nil, "no group key, no wrap")
        // The extension's reconcile adopts keys only: it neither makes a group key nor sends anything.
        var quiet = 0
        await ring.reconcile(bots: [bot("b1", encrypted: true)], createGroupKey: false) { _, _ in quiet += 1 }
        #expect(quiet == 0 && ring.group.groupKey() == nil)
        var patched = 0
        await ring.reconcile(bots: [bot("b1", encrypted: true)]) { _, _ in patched += 1 }
        #expect(patched == 1)
        #expect(ring.group.groupKey() != nil)
    }

    @Test func aPlaceholderIsRepairedByRealContent() throws {
        let store = try tempStore()
        let keys = MemoryBotKeys()
        keys.save(Seal.generateKey(), botID: "bot1")
        let opener = MessageOpener(keys: keys, placeholder: "无法解密")
        let failed = try #require(opener.open(QueuedMessage(id: 1, botID: "bot1", body: "forged", date: 5)))
        #expect(failed.placeholder)
        try store.apply(failed, notificationID: "m1")
        #expect(try store.message(id: 1)?.body == "无法解密")
        try store.apply(failed, notificationID: "m1")
        try store.apply(QueuedMessage(id: 1, botID: "bot1", title: "T", body: "real", html: "<b>x</b>", data: "d", date: 5))
        let m = try #require(try store.message(id: 1))
        #expect(m.body == "real" && m.title == "T" && m.html == "<b>x</b>")
        // Once real, a later placeholder does not clobber it.
        try store.apply(failed)
        #expect(try store.message(id: 1)?.body == "real")
        #expect(try store.message(id: 1)?.data == "d")
    }

    @Test func importRepairsPlaceholdersAndAppliesLimits() throws {
        let store = try tempStore()
        try store.apply(QueuedMessage(id: 1, botID: "bot1", body: "无法解密", date: 1, placeholder: true))
        let items = [
            QueuedMessage(id: 1, botID: "bot1", body: "restored", date: 1),
            QueuedMessage(id: 2, botID: "bot1", body: String(repeating: "b", count: ContentLimits.body + 10), html: "<p>card</p>",
                          data: String(repeating: "x", count: ContentLimits.data + 1), url: "javascript:alert(1)",
                          icon: "http://insecure/x.png", image: "https://ok.example/i.png", date: 2),
        ]
        let summary = try store.importMessages(items)
        #expect(summary.imported == 2)
        #expect(try store.message(id: 1)?.body == "restored")
        let m = try #require(try store.message(id: 2))
        #expect(m.body.unicodeScalars.count == ContentLimits.body)
        #expect(m.url == "" && m.icon == "" && m.image == "https://ok.example/i.png")
        #expect(m.html == "" && m.data == "", "a card whose data is too big is dropped")
    }

    @Test func archiveDecodeAppliesLimits() throws {
        let line = #"{"message_id":3,"bot_id":"bot1","kind":"message","body":"hi","url":"ftp://x/y","image":"http://x/y.png"}"#
        let m = try #require(MessageArchive.decode(Data(line.utf8)).messages.first)
        #expect(m.url == "" && m.image == "")
    }

    @Test func pruningKeepsStoredBotsOnly() throws {
        let store = try tempStore()
        let tokens = MemoryTokens(["bot1": "bot1:s", "gone": "gone:s", "4": "4:s"])
        let keys = MemoryBotKeys()
        keys.save(Seal.generateKey(), botID: "bot2")
        keys.save(Seal.generateKey(), botID: "gone")
        // A legacy bot still pending its rename is stored (replaceBots keeping:), so it stays.
        try store.saveBot(Bot(id: "4", name: "old"))
        try SecretPruning.prune(store: store, tokens: tokens, keys: keys)
        #expect(Set(tokens.map.keys) == ["bot1", "4"])
        #expect(keys.ids() == ["bot2"])
    }

    @Test func aSyncPageWithoutResetDecodes() throws {
        let page = try JSONDecoder().decode(APIClient.SyncPage.self, from: Data(#"{"messages":[],"cursor":3}"#.utf8))
        #expect(!page.reset && !page.hasMore)
    }
}

extension GatewayTests {
    @Test func syncRestartsFromZeroWhenTheGatewayAsksForReset() async throws {
        let store = try tempStore()
        try store.setSyncCursor(50)
        MockGateway.requests = []
        MockGateway.handler = { req in
            let url = req.url!.absoluteString
            if url.contains("cursor=50") { return (200, #"{"ok":true,"result":{"messages":[],"cursor":50,"has_more":false,"reset":true}}"#) }
            if url.contains("cursor=0") {
                return (200, #"{"ok":true,"result":{"messages":[{"message_id":7,"bot_id":"bot1","kind":"message","body":"merged","date":9}],"cursor":60,"has_more":false}}"#)
            }
            if url.hasSuffix("v1/ack") { return (200, #"{"ok":true,"result":{"acked":1}}"#) }
            return (404, #"{"ok":false,"error_code":404,"description":"Not Found"}"#)
        }
        let api = APIClient(baseURL: URL(string: "https://gw.test/")!, secret: "s", session: MockGateway.session())
        let out = try await SyncEngine(api: api, store: store, opener: MessageOpener(keys: MemoryBotKeys())).run()
        #expect(out.applied == 1)
        #expect(try store.message(id: 7)?.body == "merged")
        #expect(store.syncCursor == 60)
    }
}
