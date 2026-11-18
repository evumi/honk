import HonkCard
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
/// honk.gateway.get, honk.gateway.test, honk.gateway.set, honk.register.retry,
/// honk.card.open, honk.card.click, honk.card.set, honk.card.close.
/// Events: honk.changed (the store changed), honk.open { botId } (open a chat),
/// honk.incoming { botId, messageId } (a message arrived while the app is open; it shows its own banner),
/// honk.card.changed { key, result } (a card's timer changed it).
@MainActor
final class NshBridge {
    private unowned let app: NshAppView
    private let service: HonkService
    private var cards: CardHost?

    init(app: NshAppView, service: HonkService) {
        self.app = app
        self.service = service
    }

    func install() {
        service.onChange = { [weak self] in self?.app.send("honk.changed") }
        // Only once the app listens: until then pushes get the system banner.
        handle("honk.incoming.listen") { [weak self, service] _ in
            service.onIncoming = { botID, messageID in
                self?.app.send("honk.incoming", HostJSON.incomingEvent(botID: botID, messageID: messageID))
            }
            return true
        }

        // Card scripts run off the main thread in their own QuickJS runtimes
        // (native/card); the strings in and out are JSON the app reads.
        let cards = CardHost { [weak self] key, result in
            Task { @MainActor in self?.app.send("honk.card.changed", HostJSON.cardChangedEvent(key: key, result: result)) }
        }
        self.cards = cards
        handle("honk.card.open") { args in
            let c = try HostArgs.CardCall(Args(args), payload: "load")
            return await cards.open(key: c.key, load: c.payload)
        }
        handle("honk.card.click") { args in
            let c = try HostArgs.CardCall(Args(args), payload: "path")
            return await cards.click(key: c.key, path: c.payload)
        }
        handle("honk.card.set") { args in
            let c = try HostArgs.CardCall(Args(args), payload: "state")
            return await cards.set(key: c.key, state: c.payload)
        }
        handle("honk.card.close") { args in
            await cards.close(key: try HostArgs.CardCall(Args(args), payload: nil).key)
            return true
        }

        handle("honk.status") { [service] _ in await Self.status(service) }
        handle("honk.register.retry") { [service] _ in
            await service.retryRegistration()
            return await Self.status(service)
        }
        handle("honk.chats") { [service] _ in
            try service.store.chats().map(HostJSON.chat)
        }
        handle("honk.messages") { [service] args in
            let m = try HostArgs.Messages(Args(args))
            return try service.store.messages(botID: m.botID, before: m.before, limit: m.limit).map(HostJSON.message)
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
            HostJSON.gatewayGet(url: service.config.gatewayURL.absoluteString,
                                defaultURL: service.config.defaultGatewayURL.absoluteString,
                                custom: service.config.isCustomGateway)
        }
        handle("honk.gateway.test") { [service] args in
            do {
                let (url, info) = try await service.testGateway(try Args(args).require("url"))
                return HostJSON.gatewayTest(url: url.absoluteString, version: info.version)
            } catch {
                return HostJSON.gatewayTest(error: error.localizedDescription)
            }
        }
        handle("honk.gateway.set") { [service] args in
            // `url` null or missing: back to the default gateway.
            try await service.switchGateway(to: Args(args).string("url"))
            return HostJSON.gatewaySet(url: service.config.gatewayURL.absoluteString, registered: service.isRegistered)
        }

        // MARK: bots

        handle("honk.bot.create") { [service] args in
            let a = try HostArgs.BotCreate(Args(args))
            let created = try await service.api.createBot(name: a.name, avatar: a.avatar, defaultLevel: a.defaultLevel)
            try service.store.saveBot(created.bot)
            service.botTokens.save(created.token, botID: created.bot.id)
            service.changed()
            return HostJSON.botCreated(created.bot, token: created.token)
        }
        handle("honk.bot.update") { [service] args in
            let a = try HostArgs.BotUpdate(Args(args))
            let bot = try await service.api.updateBot(id: a.botID, name: a.name, avatar: a.avatar, defaultLevel: a.defaultLevel)
            try service.store.saveBot(bot)
            service.changed()
            return HostJSON.bot(bot)
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
        app.send("honk.open", HostJSON.openEvent(botID: botID))
    }

    private func handle(_ name: String, _ body: @escaping @MainActor (Any?) async throws -> Any) {
        app.handle(name) { data in try await body(data) }
    }

    // MARK: status

    static func status(_ service: HonkService) async -> [String: Any] {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        var failure: String?
        if case let .failed(reason) = service.registration { failure = reason }
        return HostJSON.status(
            registered: service.isRegistered, registration: service.registration.name, registrationError: failure,
            pushMode: service.pushMode.rawValue, gatewayURL: service.config.gatewayURL.absoluteString,
            notifications: Self.authorization(settings.authorizationStatus),
            appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
            appBuild: Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "")
    }

    static func authorization(_ s: UNAuthorizationStatus) -> String {
        switch s {
        case .authorized, .provisional, .ephemeral: return "authorized"
        case .denied: return "denied"
        default: return "notDetermined"
        }
    }
}
