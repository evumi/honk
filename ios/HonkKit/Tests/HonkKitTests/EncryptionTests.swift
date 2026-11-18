import Foundation
import Testing
@testable import HonkKit

// End-to-end encryption: the wire format against the vector shared with the Go
// client and :core (app/src/e2e.vector.json), then MessageOpener's rules.

private struct Vector {
    let key: Data
    let aad: String
    let plaintext: String
    let ciphertext: String
}

private func vector() throws -> Vector {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() } // → repo root
    let data = try Data(contentsOf: url.appendingPathComponent("app/src/e2e.vector.json"))
    let j = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    return Vector(key: try #require(Seal.parseKey(j["key"] as! String)), aad: j["aad"] as! String,
                  plaintext: j["plaintext"] as! String, ciphertext: j["ciphertext"] as! String)
}

let placeholder = "Couldn't decrypt this notification"

func opener(_ keys: MemoryBotKeys) -> MessageOpener { MessageOpener(keys: keys, placeholder: placeholder) }

func sealed(_ content: [String: Any], key: Data, aad: String = "bot1") throws -> String {
    try Seal.seal(JSONSerialization.data(withJSONObject: content), key: key, aad: aad)
}

@Suite struct EncryptionTests {
    @Test func opensTheSharedVector() throws {
        let v = try vector()
        let plain = try Seal.open(v.ciphertext, key: v.key, aad: v.aad)
        #expect(String(decoding: plain, as: UTF8.self) == v.plaintext)
        #expect(throws: Seal.Failure.authentication) { try Seal.open(v.ciphertext, key: v.key, aad: "other") }
        #expect(throws: Seal.Failure.authentication) { try Seal.open(v.ciphertext, key: Seal.generateKey(), aad: v.aad) }
    }

    @Test func sealsToTheSharedVector() throws {
        let v = try vector()
        let nonce = Data((0..<12).map { UInt8(0xa0 + $0) })
        let text = try Seal.seal(Data(v.plaintext.utf8), key: v.key, aad: v.aad, nonce: nonce)
        #expect(text == v.ciphertext)
    }

    @Test func rejectsBadInput() throws {
        let key = Seal.generateKey()
        #expect(throws: Seal.Failure.badKey) { try Seal.open("AAAA", key: Data(count: 16), aad: "a") }
        #expect(throws: Seal.Failure.badText) { try Seal.open("!!!", key: key, aad: "a") }
        #expect(throws: Seal.Failure.tooShort) { try Seal.open("AAAA", key: key, aad: "a") }
        var raw = Data(base64Encoded: try Seal.seal(Data("hi".utf8), key: key, aad: "a").padded())!
        raw[raw.count - 1] ^= 1
        #expect(throws: Seal.Failure.authentication) { try Seal.open(Seal.encode(raw), key: key, aad: "a") }
    }

    @Test func keyText() throws {
        let k = Seal.generateKey()
        #expect(k.count == 32)
        let text = Seal.encode(k)
        #expect(!text.contains("=") && !text.contains("+") && !text.contains("/"))
        #expect(Seal.parseKey(text) == k)
        #expect(Seal.parseKey(k.base64EncodedString()) == k, "standard base64 with padding works too")
        #expect(Seal.parseKey("AAAA") == nil)
    }

    @Test func opensAMessage() throws {
        let keys = MemoryBotKeys()
        let key = Seal.generateKey()
        keys.save(key, botID: "bot1")
        let ct = try sealed(["title": "部署成功", "body": "已上线", "html": "<p>{{s}}</p>", "data": #"{"s":"ok"}"#,
                             "url": "https://example.com/a", "copy": "dep_1", "icon": "https://example.com/i.png",
                             "image": "https://example.com/p.jpg"], key: key)
        let m = QueuedMessage(id: 5, botID: "bot1", level: "passive", group: "ci", ciphertext: ct, collapseID: "dep", date: 9)
        let out = try #require(opener(keys).open(m))
        #expect(out.title == "部署成功" && out.body == "已上线" && out.html == "<p>{{s}}</p>" && out.data == #"{"s":"ok"}"#)
        #expect(out.url == "https://example.com/a" && out.copy == "dep_1" && out.icon == "https://example.com/i.png")
        #expect(out.image == "https://example.com/p.jpg")
        #expect(out.ciphertext.isEmpty)
        #expect(out.level == "passive" && out.group == "ci" && out.collapseID == "dep" && out.date == 9, "plaintext fields stay")

        // Stored, it reads like any other message.
        let store = try tempStore()
        try store.apply(out)
        #expect(try store.message(id: 5)?.body == "已上线")
    }

    @Test func dataMayBeAnObject() throws {
        let keys = MemoryBotKeys()
        let key = Seal.generateKey()
        keys.save(key, botID: "bot1")
        let ct = try sealed(["body": "b", "html": "<p>x</p>", "data": ["n": 1]], key: key)
        let out = try #require(opener(keys).open(QueuedMessage(id: 1, botID: "bot1", ciphertext: ct)))
        #expect(out.data == #"{"n":1}"#)
    }

    @Test func plaintextWithoutAKeyPassesThrough() throws {
        let m = QueuedMessage(id: 1, botID: "bot1", body: "plain", date: 3)
        #expect(opener(MemoryBotKeys()).open(m) == m)
        let d = QueuedMessage(id: 2, botID: "bot1", kind: .delete, targetID: 1)
        #expect(opener(MemoryBotKeys()).open(d) == d)
    }

    @Test func undecryptableMessageBecomesAPlaceholder() throws {
        let keys = MemoryBotKeys()
        let ct = try sealed(["body": "secret"], key: Seal.generateKey())
        let m = QueuedMessage(id: 7, botID: "bot1", level: "active", group: "g", ciphertext: ct, collapseID: "c", date: 4)

        // No key on this device.
        var out = try #require(opener(keys).open(m))
        #expect(out.body == placeholder && out.title.isEmpty && out.html.isEmpty && out.ciphertext.isEmpty)
        #expect(out.id == 7 && out.group == "g" && out.collapseID == "c" && out.date == 4)
        // A different key.
        keys.save(Seal.generateKey(), botID: "bot1")
        out = try #require(opener(keys).open(m))
        #expect(out.body == placeholder)
        // The bot id is the AAD: another bot's ciphertext does not open.
        let key = Seal.generateKey()
        keys.save(key, botID: "bot1")
        let other = try sealed(["body": "x"], key: key, aad: "bot2")
        #expect(opener(keys).open(QueuedMessage(id: 8, botID: "bot1", ciphertext: other))?.body == placeholder)
        // Not JSON.
        let junk = try Seal.seal(Data("not json".utf8), key: key, aad: "bot1")
        #expect(opener(keys).open(QueuedMessage(id: 9, botID: "bot1", ciphertext: junk))?.body == placeholder)

        // It lands in the store as a normal message.
        let store = try tempStore()
        try store.apply(try #require(opener(keys).open(m)))
        #expect(try store.message(id: 7)?.body == placeholder)
    }

    @Test func plaintextForABotWithAKeyIsNotTrusted() throws {
        let keys = MemoryBotKeys()
        keys.save(Seal.generateKey(), botID: "bot1")
        let forged = QueuedMessage(id: 1, botID: "bot1", body: "from the gateway", date: 1)
        #expect(opener(keys).open(forged)?.body == placeholder)
        #expect(opener(keys).open(QueuedMessage(id: 2, botID: "bot1", kind: .edit, targetID: 1, data: "x")) == nil)
        // A delete has no content.
        #expect(opener(keys).open(QueuedMessage(id: 3, botID: "bot1", kind: .delete, targetID: 1))?.kind == .delete)
        // Another bot without a key is untouched.
        #expect(opener(keys).open(QueuedMessage(id: 4, botID: "bot2", body: "ok"))?.body == "ok")
    }

    @Test func editsCarryDataInTheCiphertext() throws {
        let keys = MemoryBotKeys()
        let key = Seal.generateKey()
        keys.save(key, botID: "bot1")
        let edit = QueuedMessage(id: 2, botID: "bot1", kind: .edit, targetID: 1, ciphertext: try sealed(["data": #"{"s":"已回滚"}"#], key: key))
        #expect(opener(keys).open(edit)?.data == #"{"s":"已回滚"}"#)
        // Cannot be opened: skipped, nothing is overwritten.
        let bad = QueuedMessage(id: 3, botID: "bot1", kind: .edit, targetID: 1, ciphertext: try sealed(["data": "x"], key: Seal.generateKey()))
        #expect(opener(keys).open(bad) == nil)
        // Over 1 KB: skipped.
        let big = QueuedMessage(id: 4, botID: "bot1", kind: .edit, targetID: 1, ciphertext: try sealed(["data": String(repeating: "a", count: 1025)], key: key))
        #expect(opener(keys).open(big) == nil)
    }

    @Test func limitsAreEnforcedAfterDecrypting() throws {
        let keys = MemoryBotKeys()
        let key = Seal.generateKey()
        keys.save(key, botID: "bot1")
        func open(_ content: [String: Any]) throws -> QueuedMessage {
            try #require(opener(keys).open(QueuedMessage(id: 1, botID: "bot1", ciphertext: try sealed(content, key: key))))
        }

        let long = try open(["title": String(repeating: "标", count: 300), "body": String(repeating: "x", count: 5000), "copy": String(repeating: "c", count: 5000)])
        #expect(long.title.unicodeScalars.count == 256 && long.body.unicodeScalars.count == 4096 && long.copy.unicodeScalars.count == 4096)

        let links = try open(["body": "b", "url": "javascript:alert(1)", "icon": "http://example.com/i.png", "image": "http://example.com/p.png"])
        #expect(links.url.isEmpty && links.icon.isEmpty && links.image.isEmpty, "url must be http(s), icon and image https")
        #expect(try open(["body": "b", "url": "http://example.com/x"]).url == "http://example.com/x")
        #expect(try open(["body": "b", "url": "ftp://example.com/x"]).url.isEmpty)
        #expect(try open(["body": "b", "url": "https:///nohost"]).url.isEmpty)

        // A card: raw size, compressed size and data are checked; an invalid card is dropped, the body stays.
        let fine = try open(["body": "b", "html": "<p>ok</p>", "data": "{}"])
        #expect(fine.html == "<p>ok</p>" && fine.data == "{}")
        let tooRaw = try open(["body": "keep me", "html": "<p>" + String(repeating: "a", count: 33 * 1024) + "</p>", "data": "{}"])
        #expect(tooRaw.html.isEmpty && tooRaw.data.isEmpty && tooRaw.body == "keep me")
        var noise = SystemRandomNumberGenerator()
        let incompressible = (0..<2000).map { _ in String(UInt64.random(in: 0...UInt64.max, using: &noise), radix: 36) }.joined()
        #expect(incompressible.utf8.count < ContentLimits.htmlRaw)
        let tooPacked = try open(["body": "keep me", "html": "<p>\(incompressible)</p>"])
        #expect(tooPacked.html.isEmpty && tooPacked.body == "keep me")
        let bigData = try open(["body": "b", "html": "<p>x</p>", "data": String(repeating: "d", count: 1025)])
        #expect(bigData.html.isEmpty && bigData.data.isEmpty)
    }

    @Test func compressedSizeMatchesZlib() throws {
        // 10 000 zeros deflate to a handful of bytes.
        let size = try #require(ContentLimits.compressedSize(String(repeating: "0", count: 10_000)))
        #expect(size > 6 && size < 60)
    }
}

private extension String {
    /// Base64url text with padding, for `Data(base64Encoded:)`.
    func padded() -> String {
        var s = replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        s += String(repeating: "=", count: (4 - s.count % 4) % 4)
        return s
    }
}
