import HonkKit
import UserNotifications

/// Runs for every message push (`mutable-content: 1`): fetches the full
/// message, stores it in the App Group, and turns the banner into a
/// communication notification with the bot's avatar. Whatever fails, the
/// banner from the push itself is still shown.
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
            if let m = try? await api.message(id: info.messageID),
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
        content.threadIdentifier = "bot-\(info.botID)"
        ChangeSignal.post()

        // The avatar: the message's own icon, else the bot's.
        let avatar = Avatar(message?.icon.isEmpty == false ? message!.icon : bot?.avatar ?? "")
        var imageData: Data?
        if case let .image(url) = avatar {
            imageData = await ImageCache(appGroup: config.appGroup).data(for: url, timeout: 5)
        }
        let png = CommunicationNotification.render(avatar, imageData: imageData)
        let botName = bot?.name ?? (content.title.isEmpty ? "Honk" : content.title)
        return CommunicationNotification.content(content, botID: info.botID, botName: botName,
                                                 title: message?.title ?? content.subtitle,
                                                 body: content.body, avatarPNG: png)
    }
}
