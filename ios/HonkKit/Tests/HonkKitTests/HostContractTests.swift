import Foundation
import Testing
@testable import HonkKit

// The samples in app/src/host.contract.json against HostArgs and HostJSON. The
// same file is read by app/src/host.contract.test.ts and android/core's
// HostContractTest.

private typealias JSON = [String: Any]

private func contract() throws -> JSON {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() } // → repo root
    let data = try Data(contentsOf: url.appendingPathComponent("app/src/host.contract.json"))
    return try #require(try JSONSerialization.jsonObject(with: data) as? JSON)
}

private func calls() throws -> [(name: String, spec: JSON)] {
    let all = try #require(try contract()["calls"] as? JSON)
    return all.keys.sorted().map { ($0, all[$0] as! JSON) }
}

private func samples(_ spec: JSON) -> [JSON] { (spec["samples"] as? [Any])?.compactMap { $0 as? JSON } ?? [] }

/// Canonical JSON text, so two values compare by what they would send.
private func canon(_ v: Any) throws -> String {
    String(decoding: try JSONSerialization.data(withJSONObject: v, options: [.sortedKeys, .fragmentsAllowed]), as: UTF8.self)
}

private func bot(_ j: JSON) -> Bot {
    Bot(id: j["id"] as! String, name: j["name"] as! String, avatar: j["avatar"] as! String,
        defaultLevel: j["defaultLevel"] as! String, createdAt: (j["createdAt"] as! NSNumber).int64Value)
}

private func message(_ j: JSON) -> StoredMessage {
    StoredMessage(id: (j["id"] as! NSNumber).int64Value, botID: j["botId"] as! String, title: j["title"] as! String,
                  body: j["body"] as! String, html: j["html"] as! String, data: j["data"] as! String,
                  level: j["level"] as! String, group: j["group"] as! String, url: j["url"] as! String,
                  copy: j["copy"] as! String, icon: j["icon"] as! String, open: j["open"] as! String, image: j["image"] as! String,
                  parseMode: j["parseMode"] as! String, silent: j["silent"] as! Bool, collapseID: j["collapseId"] as! String,
                  date: (j["date"] as! NSNumber).int64Value, read: j["read"] as! Bool)
}

private func chat(_ j: JSON) -> ChatSummary {
    ChatSummary(bot: bot(j["bot"] as! JSON), muted: j["muted"] as! Bool, pinned: j["pinned"] as! Bool,
                last: (j["last"] as? JSON).map(message), unread: (j["unread"] as! NSNumber).intValue)
}

@Suite struct HostContractTests {
    @Test func everySampleArgumentIsAccepted() throws {
        for (name, spec) in try calls() {
            #expect(!samples(spec).isEmpty, "\(name) has samples")
            for s in samples(spec) {
                #expect(throws: Never.self, "\(name) args \(String(describing: s["args"]))") {
                    try HostArgs.validate(name, s["args"] is NSNull ? nil : s["args"])
                }
            }
        }
    }

    @Test func callsWithRequiredArgumentsRejectNone() throws {
        // These take every argument as optional (a missing botId on focus means no chat is open).
        let lenient: Set = ["honk.focus", "honk.gateway.set"]
        for (name, spec) in try calls() {
            guard let first = samples(spec).first, let args = first["args"] as? JSON, !args.isEmpty, !lenient.contains(name) else { continue }
            #expect(throws: HostError.self, "\(name) with no arguments") { try HostArgs.validate(name, [String: Any]()) }
        }
    }

    @Test func unknownCallsAreRejected() {
        #expect(throws: HostError.unknownCall("honk.nope")) { try HostArgs.validate("honk.nope", nil) }
    }

    @Test func argumentsAreRead() throws {
        let a = CallArgs(["botId": "aZ3kQ9xT", "before": 8, "limit": 20])
        #expect(try HostArgs.Messages(a) == HostArgs.Messages(CallArgs(["botId": "aZ3kQ9xT", "before": "8", "limit": 20])))
        let m = try HostArgs.Messages(a)
        #expect(m.botID == "aZ3kQ9xT" && m.before == 8 && m.limit == 20)
        let d = try HostArgs.Messages(CallArgs(["botId": "b"]))
        #expect(d.before == nil && d.limit == 50)
        let c = try HostArgs.BotCreate(CallArgs(["name": "n"]))
        #expect(c.avatar == "" && c.defaultLevel == "active")
        let g = try HostArgs.GatewaySet(CallArgs(["url": "https://gw.test/", "registerKey": "s3cret"]))
        #expect(g.url == "https://gw.test/" && g.registerKey == "s3cret")
        let none = try HostArgs.GatewaySet(CallArgs(["url": NSNull(), "registerKey": ""]))
        #expect(none.url == nil && none.registerKey == nil, "null url: the default gateway; empty key: none")
        let u = try HostArgs.BotUpdate(CallArgs(["botId": "b", "name": "x"]))
        #expect(u.name == "x" && u.avatar == nil && u.defaultLevel == nil)
        #expect(CallArgs(["muted": true]).bool("muted") == true)
        #expect(CallArgs(["n": true]).string("n") == nil, "a boolean is not a string")
        #expect(CallArgs(["n": 5]).string("n") == "5")
    }

    @Test func modelsEncodeAsTheSamples() throws {
        let c = try contract()
        let samples = try #require(c["samples"] as? JSON)
        let botJSON = try #require(samples["bot"] as? JSON)
        let messageJSON = try #require(samples["message"] as? JSON)
        #expect(try canon(HostJSON.bot(bot(botJSON))) == canon(botJSON))
        #expect(try canon(HostJSON.message(message(messageJSON))) == canon(messageJSON))
    }

    @Test func resultsEncodeAsTheSamples() throws {
        let all = Dictionary(uniqueKeysWithValues: try calls().map { ($0.name, $0.spec) })
        func results(_ name: String) throws -> [JSON] { try samples(#require(all[name])).map { $0 } }

        for s in try results("honk.chats") {
            let list = s["result"] as! [JSON]
            #expect(try canon(list.map { HostJSON.chat(chat($0)) }) == canon(list))
        }
        for s in try results("honk.messages") {
            let list = s["result"] as! [JSON]
            #expect(try canon(list.map { HostJSON.message(message($0)) }) == canon(list))
        }
        for s in try results("honk.bot.create") {
            let r = s["result"] as! JSON
            #expect(try canon(HostJSON.botCreated(bot(r["bot"] as! JSON), token: r["token"] as! String)) == canon(r))
        }
        for s in try results("honk.bot.update") {
            let r = s["result"] as! JSON
            #expect(try canon(HostJSON.bot(bot(r))) == canon(r))
        }
        for name in ["honk.status", "honk.register.retry"] {
            for s in try results(name) {
                let r = s["result"] as! JSON
                let out = HostJSON.status(registered: r["registered"] as! Bool, registration: r["registration"] as! String,
                                          registrationError: r["registrationError"] as? String, pushMode: r["pushMode"] as! String,
                                          gatewayURL: r["gatewayURL"] as! String, notifications: r["notifications"] as! String,
                                          appVersion: r["appVersion"] as! String, appBuild: r["appBuild"] as! String)
                #expect(try canon(out) == canon(r))
            }
        }
        for s in try results("honk.gateway.get") {
            let r = s["result"] as! JSON
            #expect(try canon(HostJSON.gatewayGet(url: r["url"] as! String, defaultURL: r["defaultURL"] as! String, custom: r["custom"] as! Bool, registerKey: r["registerKey"] as! String)) == canon(r))
        }
        for s in try results("honk.gateway.test") {
            let r = s["result"] as! JSON
            let out = r["ok"] as! Bool
                ? HostJSON.gatewayTest(url: r["url"] as! String, version: r["version"] as! String, registerKeyRequired: r["registerKeyRequired"] as! Bool,
                                      push: (r["push"] as? JSON).map { APIClient.PushRoutes(ios: $0["ios"] as! String, android: $0["android"] as! String) })
                : HostJSON.gatewayTest(error: r["error"] as! String)
            #expect(try canon(out) == canon(r))
        }
        for s in try results("honk.gateway.set") {
            let r = s["result"] as! JSON
            #expect(try canon(HostJSON.gatewaySet(url: r["url"] as! String, registered: r["registered"] as! Bool)) == canon(r))
        }
    }

    @Test func eventsEncodeAsTheSamples() throws {
        let events = try #require(try contract()["events"] as? JSON)
        #expect(Set(events.keys) == ["honk.changed", "honk.open", "honk.incoming", "honk.card.changed"])
        let open = (events["honk.open"] as! JSON)["samples"] as! [JSON]
        #expect(try canon(HostJSON.openEvent(botID: open[0]["botId"] as! String)) == canon(open[0]))
        let incoming = (events["honk.incoming"] as! JSON)["samples"] as! [JSON]
        #expect(try canon(HostJSON.incomingEvent(botID: incoming[0]["botId"] as! String, messageID: (incoming[0]["messageId"] as! NSNumber).int64Value)) == canon(incoming[0]))
        let card = (events["honk.card.changed"] as! JSON)["samples"] as! [JSON]
        #expect(try canon(HostJSON.cardChangedEvent(key: card[0]["key"] as! String, result: card[0]["result"] as! String)) == canon(card[0]))
    }
}
