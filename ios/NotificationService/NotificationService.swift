import HonkKit
import UserNotifications

/// Runs for every message push (`mutable-content: 1`): fetches the full
/// message, stores it in the App Group, and turns the banner into a
/// communication notification with the bot's avatar. The banner text comes
/// from the fetched message and the local bot (`BannerText`): a push without
/// content (HONK_PUSH_CONTENT=none) has none of its own. Whatever fails, the
/// banner from the push itself, or "New notification", is still shown.
///
/// The system gives the extension about 30 seconds. The whole handling has its
/// own deadline (`budget`): at it the work is cancelled and the best content so
/// far is delivered. Each request has a short timeout, and the image and the
/// avatar download at the same time.
final class NotificationService: UNNotificationServiceExtension {
    /// The deadline for the whole handling, in seconds.
    private static let budget: TimeInterval = 20
    /// The timeout of the message fetch and of the key refresh.
    private static let fetchTimeout: TimeInterval = 8
    /// The key refresh runs at most this often (milliseconds), however many messages cannot be opened.
    private static let keyRefreshInterval: Int64 = 5 * 60 * 1000

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
        let work = Task { await Self.process(request: request, content: content, info: info) }
        // At the deadline: stop the work and deliver what there is.
        let timer = Task {
            try? await Task.sleep(nanoseconds: UInt64(Self.budget * 1_000_000_000))
            guard !Task.isCancelled else { return }
            work.cancel()
            self.deliver(self.best ?? content)
        }
        Task {
            let result = await work.value
            timer.cancel()
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
            let api = APIClient(baseURL: config.gatewayURL, secret: creds.secret, timeout: fetchTimeout)
            // The app may not have run since the gateway gave this bot a short
            // id: rename it first so its name, avatar and mute flag apply. It
            // asks only while legacy ids are stored.
            await LegacyBotIDs.renameBeforePush(store: store, tokens: BotTokenStore(accessGroup: config.keychainGroup),
                                                api: APIClient(baseURL: config.gatewayURL, secret: creds.secret, timeout: 5))
            // A sealed message is decrypted here (the key is in the shared keychain
            // group); one that cannot be opened is stored as a placeholder and
            // the banner says so.
            let keys = BotKeyStore(accessGroup: config.keychainGroup)
            let opener = MessageOpener(keys: keys)
            let item = try? await api.message(id: info.messageID)
            if let item, !opener.opens(item), (try? store.claimSlot("key-refresh", interval: keyRefreshInterval)) == true {
                // The message is sealed and its key is missing or wrong (or it is plaintext for a bot
                // that has a key): another device of the group may have turned encryption on, reset
                // the key or turned it off. Unwrap what the gateway holds, then try again. Once per
                // few minutes at most; a placeholder is repaired when the app syncs the message again.
                let ring = KeyRing(keys: keys, group: GroupKeyStore(accessGroup: config.keychainGroup))
                if let bots = try? await api.listBots() { await ring.reconcile(bots: bots) { _, _ in } }
            }
            if let item, let m = opener.open(item),
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
            // Buttons (copy, open link, mark read), from the message.
            content.categoryIdentifier = NotificationPlan.categoryID(for: message)
        }
        ChangeSignal.post()

        // The picture and the avatar (the message's own icon, else the bot's) download at the same time.
        let avatar = Avatar(message?.icon.isEmpty == false ? message!.icon : bot?.avatar ?? "")
        let imageURL = message?.image ?? ""
        async let imageFile: URL? = downloadImage(imageURL)
        async let imageData: Data? = avatarData(avatar, appGroup: config.appGroup)
        if let file = await imageFile, let attachment = try? UNNotificationAttachment(identifier: "image", url: file) {
            content.attachments = [attachment]
        }
        let png = CommunicationNotification.render(avatar, imageData: await imageData)
        let text = BannerText.choose(
            message: message, botName: bot?.name,
            pushTitle: content.title, pushSubtitle: content.subtitle, pushBody: content.body,
            fallback: NSLocalizedString("New notification", comment: "Banner when the message could not be fetched"))
        return CommunicationNotification.content(content, botID: info.botID, botName: text.botName,
                                                 title: text.title, body: text.body, avatarPNG: png)
    }

    private static func downloadImage(_ url: String) async -> URL? {
        guard !url.isEmpty else { return nil }
        return await NotificationImage().download(url, timeout: fetchTimeout)
    }

    private static func avatarData(_ avatar: Avatar, appGroup: String) async -> Data? {
        switch avatar {
        case let .image(url): return await ImageCache(appGroup: appGroup).data(for: url, timeout: 5)
        case .local: return LocalAvatars(appGroup: appGroup).data(for: avatar.stringValue)
        case .preset: return nil
        }
    }
}
