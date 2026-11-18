import HonkCard
import HonkKit
import NativeShell
import UIKit

/// The host calls the nsh app makes (`host.call("honk.…")`) and the events it
/// receives (`host.on("honk.…")`). The TSX side of this contract is
/// app/src/host.ts; keep the two in step.
///
/// Calls: honk.status, honk.chats, honk.messages, honk.search, honk.markRead, honk.focus,
/// honk.refresh, honk.retention.get, honk.retention.set, honk.export, honk.import, honk.bot.create, honk.bot.update, honk.bot.token,
/// honk.bot.resetToken, honk.bot.delete, honk.bot.setMuted, honk.bot.setPinned,
/// honk.message.delete, honk.chat.clear, honk.device.delete, honk.devices.list, honk.devices.remove,
/// honk.link.create, honk.link.claim, honk.notifications.open, honk.avatar.save, honk.avatar.image,
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
            let c = try HostArgs.CardCall(CallArgs(args), payload: "load")
            return await cards.open(key: c.key, load: c.payload)
        }
        handle("honk.card.click") { args in
            let c = try HostArgs.CardCall(CallArgs(args), payload: "path")
            return await cards.click(key: c.key, path: c.payload)
        }
        handle("honk.card.set") { args in
            let c = try HostArgs.CardCall(CallArgs(args), payload: "state")
            return await cards.set(key: c.key, state: c.payload)
        }
        handle("honk.card.close") { args in
            await cards.close(key: try HostArgs.CardCall(CallArgs(args), payload: nil).key)
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
            let m = try HostArgs.Messages(CallArgs(args))
            // `around`: a window around that message (a search result opened in its chat).
            if let around = m.around {
                return try service.store.messages(botID: m.botID, around: around, limit: m.limit).map(HostJSON.message)
            }
            return try service.store.messages(botID: m.botID, before: m.before, limit: m.limit).map(HostJSON.message)
        }
        handle("honk.search") { [service] args in
            let s = try HostArgs.Search(CallArgs(args))
            return try service.store.search(s.query, before: s.before).map(HostJSON.message)
        }

        // MARK: retention, export and import

        handle("honk.retention.get") { [service] _ in service.store.retentionDays }
        handle("honk.retention.set") { [service] args in
            try service.store.setRetentionDays(try HostArgs.RetentionSet(CallArgs(args)).days)
            service.pruneExpired()
            service.changed()
            return service.store.retentionDays
        }
        handle("honk.export") { [service] args in
            // One chat, or every chat when `botId` is missing. Resolves once the share sheet is gone.
            let botID = HostArgs.Export(CallArgs(args)).botID
            let messages = try service.store.exportMessages(botID: botID)
            guard !messages.isEmpty else { return HostJSON.exportResult(count: 0, shared: false) }
            let name = MessageArchive.fileName(botName: try botID.flatMap { try service.store.bot(id: $0)?.name })
            let shared = try await FileExchange.share(try MessageArchive.encode(messages), name: name)
            return HostJSON.exportResult(count: messages.count, shared: shared)
        }
        handle("honk.import") { [service] _ in
            // Picks a file and adds its messages; `null` when the user cancels.
            guard let data = try await FileExchange.pickFile() else { return NSNull() }
            // Off the main thread: a large archive takes a moment to read.
            let store = service.store
            let (r, invalid) = try await Task.detached {
                let archive = MessageArchive.decode(data)
                return (try store.importMessages(archive.messages), archive.invalid)
            }.value
            service.changed()
            return HostJSON.importResult(r, invalid: invalid)
        }
        handle("honk.markRead") { [service] args in
            service.markRead(botID: try CallArgs(args).require("botId"))
            return true
        }
        handle("honk.focus") { [service] args in
            service.focusedBotID = CallArgs(args).string("botId")
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
                                custom: service.config.isCustomGateway,
                                registerKey: service.registerKeys.load() ?? "")
        }
        handle("honk.gateway.test") { [service] args in
            do {
                let (url, info) = try await service.testGateway(try CallArgs(args).require("url"))
                return HostJSON.gatewayTest(url: url.absoluteString, version: info.version, registerKeyRequired: info.registerKeyRequired, push: info.push)
            } catch {
                return HostJSON.gatewayTest(error: error.localizedDescription)
            }
        }
        handle("honk.gateway.set") { [service] args in
            // `url` null or missing: back to the default gateway. `registerKey` missing or empty: none.
            let g = try HostArgs.GatewaySet(CallArgs(args))
            try await service.switchGateway(to: g.url, registerKey: g.registerKey)
            return HostJSON.gatewaySet(url: service.config.gatewayURL.absoluteString, registered: service.isRegistered)
        }

        // MARK: bots

        handle("honk.bot.create") { [service] args in
            let a = try HostArgs.BotCreate(CallArgs(args))
            // After the device's data was deleted, the first bot registers it again.
            if !service.isRegistered { await service.retryRegistration() }
            let created = try await service.api.createBot(name: a.name, avatar: a.avatar, defaultLevel: a.defaultLevel)
            try service.store.saveBot(created.bot)
            service.botTokens.save(created.token, botID: created.bot.id)
            service.changed()
            return HostJSON.botCreated(created.bot, token: created.token)
        }
        handle("honk.bot.update") { [service] args in
            let a = try HostArgs.BotUpdate(CallArgs(args))
            let bot = try await service.api.updateBot(id: a.botID, name: a.name, avatar: a.avatar, defaultLevel: a.defaultLevel)
            try service.store.saveBot(bot)
            service.changed()
            return HostJSON.bot(bot)
        }
        handle("honk.bot.token") { [service] args in
            if let token = service.botTokens.token(botID: try CallArgs(args).require("botId")) { return token }
            return NSNull()
        }
        handle("honk.bot.resetToken") { [service] args in
            let id: String = try CallArgs(args).require("botId")
            let token = try await service.api.resetToken(botID: id)
            service.botTokens.save(token, botID: id)
            return token
        }
        handle("honk.bot.delete") { [service] args in
            let id: String = try CallArgs(args).require("botId")
            try await service.api.deleteBot(id: id)
            service.removeNotifications((try? service.store.clearMessages(botID: id)) ?? [])
            try service.store.deleteBot(id: id)
            service.botTokens.remove(botID: id)
            service.changed()
            return true
        }
        handle("honk.bot.setMuted") { [service] args in
            let a = CallArgs(args)
            try service.store.setMuted(botID: try a.require("botId"), a.bool("muted") ?? false)
            service.changed()
            return true
        }
        handle("honk.bot.setPinned") { [service] args in
            let a = CallArgs(args)
            try service.store.setPinned(botID: try a.require("botId"), a.bool("pinned") ?? false)
            service.changed()
            return true
        }

        // MARK: avatars (kept on this phone only)

        handle("honk.avatar.save") { [service] args in
            let base64: String = try CallArgs(args).require("data")
            guard let data = Data(base64Encoded: base64) else { throw LocalAvatars.SaveError.notAnImage }
            return try LocalAvatars(appGroup: service.config.appGroup).save(data)
        }
        handle("honk.avatar.image") { [service] args in
            let avatar: String = try CallArgs(args).require("avatar")
            if let url = LocalAvatars(appGroup: service.config.appGroup).dataURL(for: avatar) { return url }
            return NSNull()
        }

        // MARK: messages

        handle("honk.message.delete") { [service] args in
            if let n = try service.store.deleteMessage(id: try CallArgs(args).require("messageId")) {
                service.removeNotifications([n])
            }
            service.changed()
            return true
        }
        handle("honk.chat.clear") { [service] args in
            service.removeNotifications(try service.store.clearMessages(botID: try CallArgs(args).require("botId")))
            service.changed()
            return true
        }
        handle("honk.device.delete") { [service] _ in
            try await service.deleteDeviceData()
            return true
        }
        handle("honk.devices.list") { [service] _ in
            try await service.listDevices().map(HostJSON.device)
        }
        handle("honk.devices.remove") { [service] args in
            try await service.removeDevice(id: try CallArgs(args).require("deviceId"))
            return true
        }
        handle("honk.link.create") { [service] _ in
            let c = try await service.createLink()
            return HostJSON.linkCreated(code: c.code, expiresAt: c.expiresAt)
        }
        handle("honk.link.claim") { [service] args in
            try await service.claimLink(code: try CallArgs(args).require("code"))
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
