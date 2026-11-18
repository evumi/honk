import Foundation
import Testing
@testable import HonkKit

// Sharing a bot's key between the devices of a group: the wrapped-key vector
// (app/src/e2e.vector.json, also checked by Go and :core) and KeyRing.

private func wrapVector() throws -> (group: Data, bot: Data, id: String, wrapped: String) {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() } // → repo root
    let data = try Data(contentsOf: url.appendingPathComponent("app/src/e2e.vector.json"))
    let j = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    let w = try #require(j["key_wrap"] as? [String: Any])
    return (try #require(Seal.parseKey(w["group_key"] as! String)), try #require(Seal.parseKey(w["bot_key"] as! String)),
            w["bot_id"] as! String, w["wrapped"] as! String)
}

private func ring() -> KeyRing { KeyRing(keys: MemoryBotKeys(), group: MemoryGroupKey()) }

private func bot(_ id: String, wrapped: String = "", encrypted: Bool = true) -> Bot {
    var b = Bot(id: id, name: id)
    b.encrypted = encrypted
    b.keyWrapped = wrapped
    return b
}

@Suite struct KeyRingTests {
    @Test func wrapsToTheSharedVector() throws {
        let v = try wrapVector()
        let nonce = Data((0..<12).map { UInt8(0xc0 + $0) })
        #expect(try KeyWrap.wrap(botKey: v.bot, groupKey: v.group, botID: v.id, nonce: nonce) == v.wrapped)
        #expect(v.wrapped.count == 80)
        #expect(KeyWrap.unwrap(v.wrapped, groupKey: v.group, botID: v.id) == v.bot)
        #expect(KeyWrap.unwrap(v.wrapped, groupKey: v.group, botID: "other") == nil, "the bot id is bound in")
        #expect(KeyWrap.unwrap(v.wrapped, groupKey: Seal.generateKey(), botID: v.id) == nil)
    }

    @Test func groupKeyIsMadeOnFirstNeedAndKept() {
        let r = ring()
        #expect(r.group.groupKey() == nil)
        let g = r.ensureGroupKey()
        #expect(g.count == 32 && r.group.groupKey() == g && r.ensureGroupKey() == g)
        #expect(r.wrapped(botID: "b1") == nil, "no local key, nothing to wrap")
        r.keys.save(Seal.generateKey(), botID: "b1")
        let w = r.wrapped(botID: "b1")
        #expect(w.flatMap { KeyWrap.unwrap($0, groupKey: g, botID: "b1") } == r.keys.key(botID: "b1"))
    }

    @Test func anotherDeviceUnwrapsAndFollowsAReset() async throws {
        let a = ring()
        let key1 = Seal.generateKey()
        a.keys.save(key1, botID: "b1")
        let wrapped1 = try #require(a.wrapped(botID: "b1", createGroupKey: true))

        // B has the group key (paired) but no bot key yet.
        let b = KeyRing(keys: MemoryBotKeys(), group: MemoryGroupKey(a.group.groupKey()))
        var patched: [String] = []
        await b.reconcile(bots: [bot("b1", wrapped: wrapped1)]) { id, _ in patched.append(id) }
        #expect(b.keys.key(botID: "b1") == key1)
        #expect(patched.isEmpty, "nothing to send when the gateway's key opens")

        // A resets the key; B follows on the next refresh.
        let key2 = Seal.generateKey()
        a.keys.save(key2, botID: "b1")
        let wrapped2 = try #require(a.wrapped(botID: "b1", createGroupKey: true))
        await b.reconcile(bots: [bot("b1", wrapped: wrapped2)]) { _, _ in }
        #expect(b.keys.key(botID: "b1") == key2)

        // A bot that is not encrypted is left alone.
        await b.reconcile(bots: [bot("b2", wrapped: wrapped1, encrypted: false)]) { _, _ in }
        #expect(b.keys.key(botID: "b2") == nil)
    }

    @Test func aDeviceWithoutTheGroupKeyCannotOpenIt() async throws {
        let a = ring()
        a.keys.save(Seal.generateKey(), botID: "b1")
        let wrapped = try #require(a.wrapped(botID: "b1", createGroupKey: true))
        let stranger = ring()
        var patched = 0
        await stranger.reconcile(bots: [bot("b1", wrapped: wrapped)]) { _, _ in patched += 1 }
        #expect(stranger.keys.key(botID: "b1") == nil && patched == 0)
    }

    @Test func enablingWithoutAWrappedKeyPublishesOurs() async throws {
        let r = ring()
        let k = Seal.generateKey()
        r.keys.save(k, botID: "b1")
        var sent: [String: String] = [:]
        await r.reconcile(bots: [bot("b1")]) { id, w in sent[id] = w }
        let g = try #require(r.group.groupKey())
        #expect(KeyWrap.unwrap(try #require(sent["b1"]), groupKey: g, botID: "b1") == k)
    }

    @Test func pairingCarriesTheGroupKeyAndTheBotKeys() throws {
        let creator = ring()
        let k1 = Seal.generateKey()
        creator.keys.save(k1, botID: "b1")
        let g = creator.ensureGroupKey()
        let bundle = LinkBundle(tokens: ["b1": "b1:secret"], keys: creator.bundleKeys(botIDs: ["b1", "b2"]), groupKey: Seal.encode(g))
        #expect(bundle.keys?.keys.sorted() == ["b1"], "bots without a key are not listed")

        // Through the sealed bundle, as the gateway relays it.
        let code = PairingCode.generate()
        let opened = try LinkBundle.open(try bundle.seal(code: code), code: code)

        let claimer = ring()
        claimer.adopt(opened)
        #expect(claimer.group.groupKey() == g && claimer.keys.key(botID: "b1") == k1)
    }

    @Test func aClaimerWithItsOwnGroupKeyAdoptsTheCreatorsAndRewrapsItsKeys() async throws {
        // The creator's group and bot b1.
        let creator = ring()
        let k1 = Seal.generateKey()
        creator.keys.save(k1, botID: "b1")
        let bundle = LinkBundle(tokens: [:], keys: creator.bundleKeys(botIDs: ["b1"]), groupKey: Seal.encode(creator.ensureGroupKey()))
        let wrapped1 = try #require(creator.wrapped(botID: "b1", createGroupKey: true))

        // The claimer already encrypted its own bot b2, wrapped with its own group key.
        let claimer = ring()
        let k2 = Seal.generateKey()
        claimer.keys.save(k2, botID: "b2")
        let oldWrapped2 = try #require(claimer.wrapped(botID: "b2", createGroupKey: true))
        let oldGroup = try #require(claimer.group.groupKey())

        claimer.adopt(bundle)
        #expect(claimer.group.groupKey() == creator.group.groupKey() && claimer.group.groupKey() != oldGroup)

        // After the merge the gateway lists both bots.
        var sent: [String: String] = [:]
        await claimer.reconcile(bots: [bot("b1", wrapped: wrapped1), bot("b2", wrapped: oldWrapped2)]) { id, w in sent[id] = w }
        #expect(claimer.keys.key(botID: "b1") == k1 && claimer.keys.key(botID: "b2") == k2)
        #expect(sent.keys.sorted() == ["b2"], "only the key the group cannot open is re-wrapped")
        let g = try #require(creator.group.groupKey())
        #expect(KeyWrap.unwrap(try #require(sent["b2"]), groupKey: g, botID: "b2") == k2)

        // The creator now reads b2 too.
        await creator.reconcile(bots: [bot("b2", wrapped: try #require(sent["b2"]))]) { _, _ in }
        #expect(creator.keys.key(botID: "b2") == k2)
    }

    @Test func openerReportsWhetherItOpens() throws {
        let keys = MemoryBotKeys()
        let o = MessageOpener(keys: keys, placeholder: "x")
        let key = Seal.generateKey()
        let ct = try Seal.seal(Data(#"{"body":"b"}"#.utf8), key: key, aad: "b1")
        let m = QueuedMessage(id: 1, botID: "b1", ciphertext: ct)
        #expect(!o.opens(m), "no key yet")
        keys.save(Seal.generateKey(), botID: "b1")
        #expect(!o.opens(m), "wrong key")
        keys.save(key, botID: "b1")
        #expect(o.opens(m))
        #expect(!o.opens(QueuedMessage(id: 2, botID: "b1", body: "plain")), "plaintext for a keyed bot")
        #expect(o.opens(QueuedMessage(id: 3, botID: "b9", body: "plain")))
    }
}
