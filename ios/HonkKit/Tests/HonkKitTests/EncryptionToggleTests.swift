import Foundation
import Testing
@testable import HonkKit

private func bot(_ id: String, encrypted: Bool, wrapped: String = "") -> Bot {
    var b = Bot(id: id, name: id)
    b.encrypted = encrypted
    b.keyWrapped = wrapped
    return b
}

@Suite struct EncryptionToggleTests {
    private func ring() -> KeyRing { KeyRing(keys: MemoryBotKeys(), group: MemoryGroupKey()) }

    @Test func enablingAnUnencryptedBotMakesAndPublishesAKey() async throws {
        let r = ring()
        var sent: String?
        let k = try await r.enable(bot: bot("b1", encrypted: false)) { sent = $0 }
        #expect(r.keys.key(botID: "b1") == k)
        let g = try #require(r.group.groupKey())
        #expect(KeyWrap.unwrap(try #require(sent), groupKey: g, botID: "b1") == k)
    }

    @Test func aFailedPublishLeavesNoKey() async {
        let r = ring()
        await #expect(throws: Offline.self) { try await r.enable(bot: bot("b1", encrypted: false)) { _ in throw Offline() } }
        #expect(r.keys.key(botID: "b1") == nil)
    }

    @Test func enablingAnEncryptedBotWithoutItsKeyWaitsInsteadOfReplacingTheGroupsKey() async throws {
        let creator = ring()
        creator.keys.save(Seal.generateKey(), botID: "b1")
        let wrapped = try #require(creator.wrapped(botID: "b1", createGroupKey: true))
        // A phone without the group key yet: nothing to unwrap with.
        let fresh = ring()
        var patched = 0
        await #expect(throws: EncryptionError.waitingForKey) {
            try await fresh.enable(bot: bot("b1", encrypted: true, wrapped: wrapped)) { _ in patched += 1 }
        }
        #expect(patched == 0 && fresh.keys.key(botID: "b1") == nil)
        // Once it has the group key (pairing), the same call returns the group's key.
        let paired = KeyRing(keys: MemoryBotKeys(), group: MemoryGroupKey(creator.group.groupKey()))
        let k = try await paired.enable(bot: bot("b1", encrypted: true, wrapped: wrapped)) { _ in patched += 1 }
        #expect(k == creator.keys.key(botID: "b1") && patched == 0)
    }

    @Test func resetKeepsTheOldKeyWhenThePatchFails() async throws {
        let r = ring()
        let old = Seal.generateKey()
        r.keys.save(old, botID: "b1")
        await #expect(throws: Offline.self) { try await r.reset(botID: "b1") { _ in throw Offline() } }
        #expect(r.keys.key(botID: "b1") == old)
        let k = try await r.reset(botID: "b1") { _ in }
        #expect(k != old && r.keys.key(botID: "b1") == k)
    }

    @Test func theEncryptedFlagIsStored() throws {
        let store = try tempStore()
        var b = Bot(id: "bot1", name: "部署")
        b.encrypted = true
        try store.replaceBots([b, Bot(id: "bot2", name: "告警")])
        #expect(try store.bot(id: "bot1")?.encrypted == true)
        #expect(try store.chats().first { $0.bot.id == "bot1" }?.bot.encrypted == true)
        try store.setEncrypted(botID: "bot1", false)
        #expect(try store.bot(id: "bot1")?.encrypted == false)
    }

    @Test func aKeyRefreshSlotOpensOncePerInterval() throws {
        let store = try tempStore()
        #expect(try store.claimSlot("key-refresh", interval: 1000, now: 10_000))
        #expect(try !store.claimSlot("key-refresh", interval: 1000, now: 10_500))
        #expect(try store.claimSlot("other", interval: 1000, now: 10_500))
        #expect(try store.claimSlot("key-refresh", interval: 1000, now: 11_000))
    }
}
