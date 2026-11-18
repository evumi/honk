import Foundation
import Testing
@testable import HonkKit

// docs/link-vectors.json is shared with android/core's DeviceLinkTest: the
// derivation and the sealed bundle must come out byte for byte the same.

private typealias JSON = [String: Any]

private func vectors() throws -> JSON {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() } // → repo root
    let data = try Data(contentsOf: url.appendingPathComponent("docs/link-vectors.json"))
    return try #require(try JSONSerialization.jsonObject(with: data) as? JSON)
}

private func hex(_ s: String) -> Data {
    var d = Data()
    var i = s.startIndex
    while i < s.endIndex {
        let j = s.index(i, offsetBy: 2)
        d.append(UInt8(s[i..<j], radix: 16)!)
        i = j
    }
    return d
}

private func hexString(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

@Suite struct DeviceLinkTests {
    @Test func theSharedVectorsMatch() throws {
        let list = try #require(try vectors()["vectors"] as? [JSON])
        #expect(list.count >= 2)
        for v in list {
            let code = hex(v["code_hex"] as! String)
            #expect(PairingCode.encode(code) == v["code"] as! String)
            #expect(PairingCode.decode(v["code"] as! String) == code)
            #expect(LinkCrypto.linkID(code: code) == v["link_id"] as! String)
            let key = LinkCrypto.wrapKey(code: code)
            #expect(hexString(key) == v["wrap_key_hex"] as! String)
            let plain = Data((v["plaintext"] as! String).utf8)
            let sealed = try LinkCrypto.seal(plain, wrapKey: key, nonce: hex(v["nonce_hex"] as! String))
            #expect(sealed == v["sealed"] as! String)
            #expect(try LinkCrypto.open(v["sealed"] as! String, wrapKey: key) == plain)
        }
    }

    @Test func theLastVectorIsAFullBundle() throws {
        let list = try #require(try vectors()["vectors"] as? [JSON])
        let v = try #require(list.last)
        let b = try LinkBundle.open(v["sealed"] as! String, code: hex(v["code_hex"] as! String))
        #expect(b.tokens.count == 2 && b.tokens["bQ7mN2pR"]?.hasPrefix("bQ7mN2pR:") == true)
        #expect(b.keys?["aZ3kQ9xT"] != nil)
        #expect(b.groupKey != nil)
    }

    @Test func codesAreNormalisedAndChecked() throws {
        let root = try vectors()
        for n in root["normalize"] as! [JSON] {
            #expect(PairingCode.decode(n["input"] as! String) == PairingCode.decode(n["code"] as! String))
            #expect(PairingCode.decode(n["input"] as! String) != nil, "\(n["input"]!)")
        }
        for bad in root["invalid"] as! [String] {
            #expect(PairingCode.decode(bad) == nil, "\(bad)")
        }
    }

    @Test func generatedCodesRoundTripAndDisplayInGroups() {
        var seen = Set<String>()
        for _ in 0..<50 {
            let code = PairingCode.generate()
            #expect(code.count == 16)
            let text = PairingCode.encode(code)
            #expect(text.count == 26)
            #expect(PairingCode.decode(text) == code)
            #expect(PairingCode.decode(PairingCode.display(code).lowercased()) == code)
            seen.insert(text)
        }
        #expect(seen.count == 50)
        #expect(PairingCode.display(Data(0..<16)) == "000G-40R4-0M30-E209-185G-R38E-1W")
    }

    @Test func aBundleSealsAndOpensWithItsCodeOnly() throws {
        let code = PairingCode.generate()
        let bundle = LinkBundle(tokens: ["aZ3kQ9xT": "aZ3kQ9xT:secret"], keys: ["aZ3kQ9xT": "a2V5"], groupKey: "Z2s")
        let sealed = try bundle.seal(code: code)
        #expect(sealed.utf8.count < LinkBundle.maxSealedBytes)
        #expect(try LinkBundle.open(sealed, code: code) == bundle)
        #expect(throws: (any Error).self) { try LinkBundle.open(sealed, code: PairingCode.generate()) }
        // A changed byte fails the tag.
        var chars = Array(sealed)
        chars[chars.count - 3] = chars[chars.count - 3] == "A" ? "B" : "A"
        #expect(throws: (any Error).self) { try LinkBundle.open(String(chars), code: code) }
        #expect(throws: LinkError.malformed) { try LinkBundle.open("AAAA", code: code) }
    }

    @Test func theBundleFormatIsTheDocumentedJSON() throws {
        let plain = try JSONEncoder().encode(LinkBundle(tokens: ["b": "b:t"]))
        let json = try #require(try JSONSerialization.jsonObject(with: plain) as? JSON)
        #expect(Set(json.keys) == ["v", "tokens"], "keys and group_key are absent until there are some")
        let full = try JSONEncoder().encode(LinkBundle(tokens: [:], keys: ["b": "k"], groupKey: "g"))
        #expect(Set(try #require(try JSONSerialization.jsonObject(with: full) as? JSON).keys) == ["v", "tokens", "keys", "group_key"])
        // A bundle from a newer app with fields this one does not know still opens.
        let newer = Data(#"{"v":2,"tokens":{"b":"b:t"},"future":1}"#.utf8)
        #expect(try JSONDecoder().decode(LinkBundle.self, from: newer).tokens == ["b": "b:t"])
    }

    @Test func aBundleOverTheGatewayLimitIsRefused() {
        let tokens = Dictionary(uniqueKeysWithValues: (0..<400).map { ("b\($0)", String(repeating: "x", count: 60)) })
        #expect(throws: LinkError.tooLarge) { try LinkBundle(tokens: tokens).seal(code: PairingCode.generate()) }
    }
}

// In GatewayTests' suite, which is serialized: the mock's handler is shared.
extension GatewayTests {
    fileprivate func api(_ secret: String = "s") -> APIClient {
        APIClient(baseURL: URL(string: "https://gw.test/")!, secret: secret, session: MockGateway.session())
    }

    fileprivate func body(_ r: URLRequest) -> [String: String] {
        let data = r.httpBody ?? r.httpBodyStream.map { s in
            s.open(); defer { s.close() }
            var d = Data(); var buf = [UInt8](repeating: 0, count: 4096)
            while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; d.append(buf, count: n) }
            return d
        } ?? Data()
        return (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
    }

    @Test func aCodeMadeOnOnePhoneOpensOnTheOther() async throws {
        let old = try tempStore()
        try old.saveBot(Bot(id: "aZ3kQ9xT", name: "部署", avatar: "", defaultLevel: "active", createdAt: 1, updatedAt: 1))
        try old.saveBot(Bot(id: "bQ7mN2pR", name: "no token here", avatar: "", defaultLevel: "active", createdAt: 2, updatedAt: 2))
        MockGateway.requests = []
        MockGateway.handler = { _ in (200, #"{"ok":true,"result":{"expires_in":600}}"#) }
        let created = try await DeviceLinking.create(api: api(), store: old, tokens: MemoryTokens(["aZ3kQ9xT": "aZ3kQ9xT:secret"]),
                                                     now: Date(timeIntervalSince1970: 1_700_000_000))
        #expect(created.expiresAt == 1_700_000_600_000)
        #expect(created.code.count == 32 && created.code.filter { $0 == "-" }.count == 6)
        let post = try #require(MockGateway.requests.first)
        #expect(post.url!.path == "/v1/links")
        let sent = body(post)
        let code = try #require(PairingCode.decode(created.code))
        #expect(sent["link_id"] == LinkCrypto.linkID(code: code))
        #expect(!created.code.contains(sent["link_id"]!), "the gateway never gets anything but the derived id")
        let bundle = try LinkBundle.open(try #require(sent["bundle"]), code: code)
        #expect(bundle.tokens == ["aZ3kQ9xT": "aZ3kQ9xT:secret"], "only bots whose token this phone has")

        // The new phone claims it: typed in lowercase with spaces.
        let new = try tempStore()
        try new.setSyncCursor(42)
        MockGateway.requests = []
        MockGateway.handler = { _ in (200, #"{"ok":true,"result":{"bundle":"\#(sent["bundle"]!)"}}"#) }
        let tokens = MemoryTokens()
        let got = try await DeviceLinking.claim(created.code.lowercased().replacingOccurrences(of: "-", with: " "), api: api("n"), store: new, tokens: tokens)
        #expect(got.tokens == ["aZ3kQ9xT": "aZ3kQ9xT:secret"])
        #expect(tokens.map == ["aZ3kQ9xT": "aZ3kQ9xT:secret"])
        #expect(new.syncCursor == 0, "the merged group's queue is fetched from the start")
        #expect(body(MockGateway.requests[0])["link_id"] == sent["link_id"])
    }

    @Test func claimErrors() async throws {
        let store = try tempStore()
        let tokens = MemoryTokens()
        await #expect(throws: LinkError.badCode) { try await DeviceLinking.claim("nope", api: api(), store: store, tokens: tokens) }
        MockGateway.handler = { _ in (404, #"{"ok":false,"error_code":404,"description":"Not Found"}"#) }
        await #expect(throws: LinkError.unknownCode) { try await DeviceLinking.claim("000G-40R4-0M30-E209-185G-R38E-1W", api: api(), store: store, tokens: tokens) }
        MockGateway.handler = { _ in (429, #"{"ok":false,"error_code":429,"description":"Too Many Requests"}"#) }
        await #expect(throws: LinkError.rateLimited) { try await DeviceLinking.claim("000G-40R4-0M30-E209-185G-R38E-1W", api: api(), store: store, tokens: tokens) }
        // A bundle sealed with another code does not open.
        let other = try LinkBundle(tokens: ["a": "b"]).seal(code: PairingCode.generate())
        MockGateway.handler = { _ in (200, #"{"ok":true,"result":{"bundle":"\#(other)"}}"#) }
        await #expect(throws: LinkError.malformed) { try await DeviceLinking.claim("000G-40R4-0M30-E209-185G-R38E-1W", api: api(), store: store, tokens: tokens) }
        #expect(tokens.map.isEmpty)
    }
}
