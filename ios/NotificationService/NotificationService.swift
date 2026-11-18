import HonkKit
import UserNotifications

/// Runs for every message push (`mutable-content: 1`): fetches the full
/// message, stores it in the App Group, and turns the banner into a
/// communication notification with the bot's avatar. The banner text comes
/// from the fetched message and the local bot (`BannerText`): a push without
/// content (HONK_PUSH_CONTENT=none) has none of its own. Whatever fails, the
/// banner from the push itself, or "New notification", is still shown.
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var best: UNMutableNotificationContent?
    private let lock = NSLock()

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        best = content
        guard let info = PushInfo(userInfo: content.userInfo), info.kind == .message else {
            deliver(content)
            return
        }
        Task {
            let result = await Self.process(request: request, content: content, info: info)
            self.deliver(result)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        if let best { deliver(best) }
    }

    /// Calls the content handler once.
    private func deliver(_ content: UNNotificationContent) {
        lock.lock()
        let handler = contentHandler
        contentHandler = nil
        lock.unlock()
        handler?(content)
    }

    private static func process(request: UNNotificationRequest, content: UNMutableNotificationContent,
                                info: PushInfo) async -> UNNotificationContent {
        let config = HonkConfig.fromBundle()
        guard let store = try? LocalStore(appGroup: config.appGroup) else { return content }
        let creds = CredentialStore(accessGroup: config.keychainGroup).load()

        var message: StoredMessage?
        if let creds {
            let api = APIClient(baseURL: config.gatewayURL, secret: creds.secret)
            // The app may not have run since the gateway gave this bot a short
            // id: rename it first so its name, avatar and mute flag apply.
            await LegacyBotIDs.renameBeforePush(store: store, tokens: BotTokenStore(accessGroup: config.keychainGroup),
                                                api: APIClient(baseURL: config.gatewayURL, secret: creds.secret, timeout: 5))
            // A sealed message is decrypted here (the key is in the shared keychain
            // group); one that cannot be opened is stored as a placeholder and
            // the banner says so.
            let opener = MessageOpener(keys: BotKeyStore(accessGroup: config.keychainGroup))
            if let item = try? await api.message(id: info.messageID), let m = opener.open(item),
               let r = try? store.apply(m, notificationID: request.identifier) {
                message = r.message
                if !r.staleNotificationIDs.isEmpty {
                    UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: r.staleNotificationIDs)
                }
            }
        }

        let bot = (try? store.bot(id: info.botID)) ?? nil
        if (try? store.isMuted(botID: info.botID)) == true {
            content.sound = nil
            if #available(iOS 15.0, *) { content.interruptionLevel = .passive }
        }
        content.badge = NSNumber(value: (try? store.unreadTotal()) ?? 0)
        // One thread per bot, and per message group when the message has one.
        // The group comes from the fetched message; the push's own thread id
        // (b<bot>:<group>) says it when the fetch failed. Read it before replacing it.
        let group = message?.group ?? NotificationThread.group(fromAPNsThread: content.threadIdentifier, botID: info.botID)
        content.threadIdentifier = NotificationThread.identifier(botID: info.botID, group: group)
        if let message {
            // Buttons (copy, open link, mark read) and the picture, from the message.
            content.categoryIdentifier = NotificationPlan.categoryID(for: message)
            if !message.image.isEmpty, let file = await NotificationImage().download(message.image),
               let attachment = try? UNNotificationAttachment(identifier: "image", url: file) {
                content.attachments = [attachment]
            }
        }
        ChangeSignal.post()

        // The avatar: the message's own icon, else the bot's.
        let avatar = Avatar(message?.icon.isEmpty == false ? message!.icon : bot?.avatar ?? "")
        var imageData: Data?
        switch avatar {
        case let .image(url):
            imageData = await ImageCache(appGroup: config.appGroup).data(for: url, timeout: 5)
        case .local:
            imageData = LocalAvatars(appGroup: config.appGroup).data(for: avatar.stringValue)
        case .preset:
            break
        }
        let png = CommunicationNotification.render(avatar, imageData: imageData)
        let text = BannerText.choose(
            message: message, botName: bot?.name,
            pushTitle: content.title, pushSubtitle: content.subtitle, pushBody: content.body,
            fallback: NSLocalizedString("New notification", comment: "Banner when the message could not be fetched"))
        return CommunicationNotification.content(content, botID: info.botID, botName: text.botName,
                                                 title: text.title, body: text.body, avatarPNG: png)
    }
}
