import HonkKit
import NativeShell
import UIKit

/// The host calls the nsh app makes (`host.call("honk.…")`) and the events it
/// receives (`host.on("honk.…")`). The TSX side of this contract is
/// app/src/host.ts; keep the two in step.
///
/// Calls: honk.status, honk.chats, honk.messages, honk.markRead, honk.focus,
/// honk.refresh, honk.bot.create, honk.bot.update, honk.bot.token,
/// honk.bot.resetToken, honk.bot.delete, honk.bot.setMuted, honk.bot.setPinned,
/// honk.message.delete, honk.chat.clear, honk.notifications.open, honk.avatar.save, honk.avatar.image,
/// honk.gateway.get, honk.gateway.test, honk.gateway.set, honk.register.retry.
/// Events: honk.changed (the store changed), honk.open { botId } (open a chat).
@MainActor
final class NshBridge {
    private unowned let app: NshAppView
    private let service: HonkService

    init(app: NshAppView, service: HonkService) {
        self.app = app
        self.service = service
    }

    func install() {
        service.onChange = { [weak self] in self?.app.send("honk.changed") }

        handle("honk.status") { [service] _ in await Self.status(service) }
        handle("honk.register.retry") { [service] _ in
            await service.retryRegistration()
            return await Self.status(service)
        }
        handle("honk.chats") { [service] _ in
            try service.store.chats().map(Self.chat)
        }
        handle("honk.messages") { [service] args in
            let a = Args(args)
            let limit = a.int("limit").map { Int($0) } ?? 50
            return try service.store.messages(botID: try a.require("botId"), before: a.int("before"), limit: limit)
                .map(Self.message)
        }
        handle("honk.markRead") { [service] args in
            service.markRead(botID: try Args(args).require("botId"))
            return true
        }
        handle("honk.focus") { [service] args in
            service.focusedBotID = Args(args).string("botId")
            return true
        }
        handle("honk.refresh") { [service] _ in
            await service.refresh()
            return true
        }

        // MARK: gateway

        handle("honk.gateway.get") { [service] _ in
            ["url": service.config.gatewayURL.absoluteString,
             "defaultURL": service.config.defaultGatewayURL.absoluteString,
             "custom": service.config.isCustomGateway]
        }
        handle("honk.gateway.test") { [service] args in
            do {
                let (url, info) = try await service.testGateway(try Args(args).require("url"))
                return ["ok": true, "url": url.absoluteString, "version": info.version]
            } catch {
                return ["ok": false, "error": error.localizedDescription]
            }
        }
        handle("honk.gateway.set") { [service] args in
            // `url` null or missing: back to the default gateway.
            try await service.switchGateway(to: Args(args).string("url"))
            return ["url": service.config.gatewayURL.absoluteString, "registered": service.isRegistered]
        }

        // MARK: bots

        handle("honk.bot.create") { [service] args in
            let a = Args(args)
            let created = try await service.api.createBot(name: try a.require("name"), avatar: a.string("avatar") ?? "",
                                                          defaultLevel: a.string("defaultLevel") ?? "active")
            try service.store.saveBot(created.bot)
            service.botTokens.save(created.token, botID: created.bot.id)
            service.changed()
            return ["bot": Self.bot(created.bot), "token": created.token]
        }
        handle("honk.bot.update") { [service] args in
            let a = Args(args)
            let bot = try await service.api.updateBot(id: try a.require("botId"), name: a.string("name"),
                                                      avatar: a.string("avatar"), defaultLevel: a.string("defaultLevel"))
            try service.store.saveBot(bot)
            service.changed()
            return Self.bot(bot)
        }
        handle("honk.bot.token") { [service] args in
            if let token = service.botTokens.token(botID: try Args(args).require("botId")) { return token }
            return NSNull()
        }
        handle("honk.bot.resetToken") { [service] args in
            let id: String = try Args(args).require("botId")
            let token = try await service.api.resetToken(botID: id)
            service.botTokens.save(token, botID: id)
            return token
        }
        handle("honk.bot.delete") { [service] args in
            let id: String = try Args(args).require("botId")
            try await service.api.deleteBot(id: id)
            service.removeNotifications((try? service.store.clearMessages(botID: id)) ?? [])
            try service.store.deleteBot(id: id)
            service.botTokens.remove(botID: id)
            service.changed()
            return true
        }
        handle("honk.bot.setMuted") { [service] args in
            let a = Args(args)
            try service.store.setMuted(botID: try a.require("botId"), a.bool("muted") ?? false)
            service.changed()
            return true
        }
        handle("honk.bot.setPinned") { [service] args in
            let a = Args(args)
            try service.store.setPinned(botID: try a.require("botId"), a.bool("pinned") ?? false)
            service.changed()
            return true
        }

        // MARK: avatars (kept on this phone only)

        handle("honk.avatar.save") { [service] args in
            let base64: String = try Args(args).require("data")
            guard let data = Data(base64Encoded: base64) else { throw LocalAvatars.SaveError.notAnImage }
            return try LocalAvatars(appGroup: service.config.appGroup).save(data)
        }
        handle("honk.avatar.image") { [service] args in
            let avatar: String = try Args(args).require("avatar")
            if let url = LocalAvatars(appGroup: service.config.appGroup).dataURL(for: avatar) { return url }
            return NSNull()
        }

        // MARK: messages

        handle("honk.message.delete") { [service] args in
            if let n = try service.store.deleteMessage(id: try Args(args).require("messageId")) {
                service.removeNotifications([n])
            }
            service.changed()
            return true
        }
        handle("honk.chat.clear") { [service] args in
            service.removeNotifications(try service.store.clearMessages(botID: try Args(args).require("botId")))
            service.changed()
            return true
        }
        handle("honk.notifications.open") { _ in
            if let url = URL(string: UIApplication.openSettingsURLString) {
                await UIApplication.shared.open(url)
            }
            return true
        }
    }

    func openChat(botID: String) {
        app.send("honk.open", ["botId": botID])
    }

    private func handle(_ name: String, _ body: @escaping @MainActor (Any?) async throws -> Any) {
        app.handle(name) { data in try await body(data) }
    }

    // MARK: JSON shapes (camelCase; bot ids are strings, message ids numbers)

    static func bot(_ b: Bot) -> [String: Any] {
        ["id": b.id, "name": b.name, "avatar": b.avatar, "defaultLevel": b.defaultLevel, "createdAt": b.createdAt]
    }

    static func message(_ m: StoredMessage) -> [String: Any] {
        ["id": m.id, "botId": m.botID, "title": m.title, "body": m.body, "html": m.html, "data": m.data,
         "level": m.level, "group": m.group, "url": m.url, "copy": m.copy, "icon": m.icon, "collapseId": m.collapseID,
         "date": m.date, "read": m.read]
    }

    static func chat(_ c: ChatSummary) -> [String: Any] {
        ["bot": bot(c.bot), "muted": c.muted, "pinned": c.pinned, "unread": c.unread,
         "last": c.last.map(message) ?? NSNull()]
    }

    static func status(_ service: HonkService) async -> [String: Any] {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        var out: [String: Any] = [
            "registered": service.isRegistered,
            "registration": service.registration.name,
            "pushMode": service.pushMode.rawValue,
            "gatewayURL": service.config.gatewayURL.absoluteString,
            "notifications": Self.authorization(settings.authorizationStatus),
            "appVersion": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
            "appBuild": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "",
        ]
        if case let .failed(reason) = service.registration { out["registrationError"] = reason }
        return out
    }

    static func authorization(_ s: UNAuthorizationStatus) -> String {
        switch s {
        case .authorized, .provisional, .ephemeral: return "authorized"
        case .denied: return "denied"
        default: return "notDetermined"
        }
    }
}

/// Reads the JSON object a host call passes.
struct Args {
    let dict: [String: Any]

    init(_ data: Any?) { dict = data as? [String: Any] ?? [:] }

    func string(_ k: String) -> String? {
        switch dict[k] {
        case let s as String: return s
        case let n as NSNumber where CFGetTypeID(n) != CFBooleanGetTypeID(): return n.stringValue
        default: return nil
        }
    }
    func bool(_ k: String) -> Bool? { (dict[k] as? NSNumber)?.boolValue }
    func int(_ k: String) -> Int64? {
        switch dict[k] {
        case let n as NSNumber: return n.int64Value
        case let s as String: return Int64(s)
        default: return nil
        }
    }

    func require(_ k: String) throws -> Int64 {
        guard let v = int(k) else { throw BridgeError.missing(k) }
        return v
    }

    func require(_ k: String) throws -> String {
        guard let v = string(k), !v.isEmpty else { throw BridgeError.missing(k) }
        return v
    }
}

enum BridgeError: Error, LocalizedError {
    case missing(String)
    var errorDescription: String? {
        switch self {
        case let .missing(k): return "missing argument \(k)"
        }
    }
}
