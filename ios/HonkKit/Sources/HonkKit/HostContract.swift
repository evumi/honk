import Foundation

// The contract with the nsh app (app/src/host.ts), on the HonkKit side: how a
// host call's JSON arguments are read and how its results and events are
// written. ios/App/NshBridge.swift only wires these to the app's services.
// The samples in app/src/host.contract.json are tested against all of this
// here, in android/core's HostContract.kt and in app/src/host.contract.test.ts.

/// Reads the JSON object a host call passes.
public struct CallArgs {
    public let dict: [String: Any]

    public init(_ data: Any?) { dict = data as? [String: Any] ?? [:] }

    public func string(_ k: String) -> String? {
        switch dict[k] {
        case let s as String: return s
        case let n as NSNumber where CFGetTypeID(n) != CFBooleanGetTypeID(): return n.stringValue
        default: return nil
        }
    }

    public func bool(_ k: String) -> Bool? { (dict[k] as? NSNumber)?.boolValue }

    public func int(_ k: String) -> Int64? {
        switch dict[k] {
        case let n as NSNumber: return n.int64Value
        case let s as String: return Int64(s)
        default: return nil
        }
    }

    public func require(_ k: String) throws -> Int64 {
        guard let v = int(k) else { throw HostError.missing(k) }
        return v
    }

    public func require(_ k: String) throws -> String {
        guard let v = string(k), !v.isEmpty else { throw HostError.missing(k) }
        return v
    }
}

public enum HostError: Error, LocalizedError, Equatable {
    case missing(String)
    case unknownCall(String)

    public var errorDescription: String? {
        switch self {
        case let .missing(k): return "missing argument \(k)"
        case let .unknownCall(n): return "unknown host call \(n)"
        }
    }
}

/// The arguments of the host calls that take more than one.
public enum HostArgs {
    public struct Messages: Equatable {
        public let botID: String
        public let before: Int64?
        public let limit: Int

        public init(_ a: CallArgs) throws {
            botID = try a.require("botId")
            before = a.int("before")
            limit = a.int("limit").map { Int($0) } ?? 50
        }
    }

    public struct BotCreate: Equatable {
        public let name: String
        public let avatar: String
        public let defaultLevel: String

        public init(_ a: CallArgs) throws {
            name = try a.require("name")
            avatar = a.string("avatar") ?? ""
            defaultLevel = a.string("defaultLevel") ?? "active"
        }
    }

    public struct BotUpdate: Equatable {
        public let botID: String
        public let name: String?
        public let avatar: String?
        public let defaultLevel: String?

        public init(_ a: CallArgs) throws {
            botID = try a.require("botId")
            name = a.string("name")
            avatar = a.string("avatar")
            defaultLevel = a.string("defaultLevel")
        }
    }

    public struct GatewaySet: Equatable {
        /// `nil`: back to the build's default gateway.
        public let url: String?
        /// The gateway's register key; `nil` (or empty) when it has none.
        public let registerKey: String?

        public init(_ a: CallArgs) throws {
            url = a.string("url")
            registerKey = a.string("registerKey").flatMap { $0.isEmpty ? nil : $0 }
        }
    }

    public struct CardCall: Equatable {
        public let key: String
        /// `load` (open), `path` (click) or `state` (set); empty for close.
        public let payload: String

        public init(_ a: CallArgs, payload: String?) throws {
            key = try a.require("key")
            self.payload = try payload.map { try a.require($0) } ?? ""
        }
    }

    /// Checks that `args` has what the named call needs; throws like the
    /// bridge would. The contract test runs it over every sample.
    public static func validate(_ name: String, _ args: Any?) throws {
        let a = CallArgs(args)
        switch name {
        case "honk.status", "honk.chats", "honk.refresh", "honk.register.retry", "honk.notifications.open",
             "honk.incoming.listen", "honk.gateway.get", "honk.device.delete", "honk.devices.list", "honk.link.create":
            break
        case "honk.devices.remove":
            let _: String = try a.require("deviceId")
        case "honk.link.claim":
            let _: String = try a.require("code")
        case "honk.messages": _ = try Messages(a)
        case "honk.markRead", "honk.bot.token", "honk.bot.resetToken", "honk.bot.delete", "honk.chat.clear":
            let _: String = try a.require("botId")
        case "honk.focus": break // a missing botId means no chat is open
        case "honk.bot.create": _ = try BotCreate(a)
        case "honk.bot.update": _ = try BotUpdate(a)
        case "honk.bot.setMuted", "honk.bot.setPinned":
            let _: String = try a.require("botId")
        case "honk.message.delete":
            let _: Int64 = try a.require("messageId")
        case "honk.gateway.test":
            let _: String = try a.require("url")
        case "honk.gateway.set": _ = try GatewaySet(a) // a missing url means the default gateway
        case "honk.avatar.save":
            let _: String = try a.require("data")
        case "honk.avatar.image":
            let _: String = try a.require("avatar")
        case "honk.card.open": _ = try CardCall(a, payload: "load")
        case "honk.card.click": _ = try CardCall(a, payload: "path")
        case "honk.card.set": _ = try CardCall(a, payload: "state")
        case "honk.card.close": _ = try CardCall(a, payload: nil)
        default: throw HostError.unknownCall(name)
        }
    }
}

/// The JSON a host call answers with and the events the host sends: camelCase
/// keys, bot ids strings, message ids numbers.
public enum HostJSON {
    public static func bot(_ b: Bot) -> [String: Any] {
        ["id": b.id, "name": b.name, "avatar": b.avatar, "defaultLevel": b.defaultLevel, "createdAt": b.createdAt]
    }

    public static func message(_ m: StoredMessage) -> [String: Any] {
        ["id": m.id, "botId": m.botID, "title": m.title, "body": m.body, "html": m.html, "data": m.data,
         "level": m.level, "group": m.group, "url": m.url, "copy": m.copy, "icon": m.icon, "collapseId": m.collapseID,
         "date": m.date, "read": m.read]
    }

    public static func chat(_ c: ChatSummary) -> [String: Any] {
        ["bot": bot(c.bot), "muted": c.muted, "pinned": c.pinned, "unread": c.unread,
         "last": c.last.map(message) ?? NSNull()]
    }

    /// `honk.status` and `honk.register.retry`.
    public static func status(registered: Bool, registration: String, registrationError: String? = nil, pushMode: String,
                              gatewayURL: String, notifications: String, appVersion: String, appBuild: String) -> [String: Any] {
        var out: [String: Any] = [
            "registered": registered, "registration": registration, "pushMode": pushMode, "gatewayURL": gatewayURL,
            "notifications": notifications, "appVersion": appVersion, "appBuild": appBuild,
        ]
        if let registrationError { out["registrationError"] = registrationError }
        return out
    }

    /// `registerKey`: the one saved for the gateway, empty when none.
    public static func gatewayGet(url: String, defaultURL: String, custom: Bool, registerKey: String) -> [String: Any] {
        ["url": url, "defaultURL": defaultURL, "custom": custom, "registerKey": registerKey]
    }

    /// `push`: how the gateway sends pushes per platform; left out for a gateway that does not say.
    public static func gatewayTest(url: String, version: String, registerKeyRequired: Bool,
                                   push: APIClient.PushRoutes? = nil) -> [String: Any] {
        var out: [String: Any] = ["ok": true, "url": url, "version": version, "registerKeyRequired": registerKeyRequired]
        if let push { out["push"] = ["ios": push.ios, "android": push.android] }
        return out
    }

    public static func gatewayTest(error: String) -> [String: Any] {
        ["ok": false, "error": error]
    }

    public static func gatewaySet(url: String, registered: Bool) -> [String: Any] {
        ["url": url, "registered": registered]
    }

    /// An entry of `honk.devices.list`. `seenAt` is Unix milliseconds.
    public static func device(_ d: APIClient.GroupDevice) -> [String: Any] {
        ["id": d.id, "name": d.name, "platform": d.platform, "seenAt": d.seenAt, "current": d.current]
    }

    /// `honk.link.create`: the code in groups of four, and when it stops working (Unix milliseconds).
    public static func linkCreated(code: String, expiresAt: Int64) -> [String: Any] {
        ["code": code, "expiresAt": expiresAt]
    }

    public static func botCreated(_ b: Bot, token: String) -> [String: Any] {
        ["bot": bot(b), "token": token]
    }

    // Events (`host.on`).

    public static func openEvent(botID: String) -> [String: Any] { ["botId": botID] }

    public static func incomingEvent(botID: String, messageID: Int64) -> [String: Any] {
        ["botId": botID, "messageId": messageID]
    }

    public static func cardChangedEvent(key: String, result: String) -> [String: Any] {
        ["key": key, "result": result]
    }
}
