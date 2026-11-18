import HonkKit
import UIKit
import UserNotifications

@main
final class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    /// Set by the scene once the nsh view is up; a tapped notification opens its chat.
    var openChat: ((String) -> Void)?
    private var pendingOpen: String?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        BackgroundRefresh.register()
        UNUserNotificationCenter.current().setNotificationCategories(Self.notificationCategories())
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { _, _ in
            DispatchQueue.main.async { application.registerForRemoteNotifications() }
        }
        #if DEBUG && targetEnvironment(simulator)
        // A simulator build that is unsigned (or whose APNs registration never
        // answers) gets no token: fall back to the simulator identity.
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            if HonkService.shared.registration == .waitingForPushToken {
                await HonkService.shared.useSimulatorIdentity()
            }
        }
        #endif
        return true
    }

    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default", sessionRole: session.role)
    }

    // MARK: push token

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { await HonkService.shared.register(pushToken: token) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NSLog("honk: no push token: \(error)")
        Task { await HonkService.shared.pushTokenUnavailable(error) }
    }

    /// The four categories of `NotificationPlan` with their buttons.
    private static func notificationCategories() -> Set<UNNotificationCategory> {
        let chinese = Locale.preferredLanguages.first?.hasPrefix("zh") == true
        return Set(NotificationPlan.categories.map { category in
            let actions = category.actions.map { a in
                UNNotificationAction(identifier: a.rawValue, title: NotificationPlan.title(a, chinese: chinese),
                                     options: a == .openURL ? [.foreground] : [])
            }
            return UNNotificationCategory(identifier: category.id, actions: actions, intentIdentifiers: [], options: [])
        })
    }

    // MARK: background pushes (edits, deletes and silent messages)

    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        guard let info = PushInfo(userInfo: userInfo) else {
            completionHandler(.noData)
            return
        }
        Task {
            // A silent message has no extension run: apply it here (a message the
            // extension already stored applies again without change). It posts
            // no notification, but counts in the badge.
            let ok = await HonkService.shared.handleSilentPush(info)
            completionHandler(ok ? .newData : .failed)
        }
    }

    // MARK: notification center

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let info = PushInfo(userInfo: notification.request.content.userInfo)
        Task { @MainActor in
            let service = HonkService.shared
            service.changed()
            if let info, info.botID == service.focusedBotID {
                // The chat is open: the message appears there, no banner.
                completionHandler([])
                service.markRead(botID: info.botID)
            } else if let info, let incoming = service.onIncoming {
                // The app is open: it shows its own banner; the notification
                // still goes to Notification Center, quietly.
                completionHandler([.list, .badge])
                incoming(info.botID, info.messageID)
            } else {
                completionHandler([.banner, .list, .sound, .badge])
            }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        guard let info = PushInfo(userInfo: response.notification.request.content.userInfo) else {
            completionHandler()
            return
        }
        Task { @MainActor in
            // The system may suspend the app once this is called: only after the action ran.
            defer { completionHandler() }
            let service = HonkService.shared
            // A notification from before the bot got its short id names the old one.
            let botID = service.store.currentBotID(info.botID)
            let message = (try? service.store.message(id: info.messageID)) ?? nil
            let outcome: NotificationPlan.Outcome
            if let action = NotificationPlan.Action(rawValue: response.actionIdentifier) {
                outcome = NotificationPlan.outcome(of: action, on: message, botID: botID)
            } else if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
                switch NotificationPlan.tap(message, botID: botID) {
                case let .url(url): outcome = .open(url)
                case let .chat(id): outcome = .nothing; self.show(chat: id)
                }
            } else {
                outcome = .nothing
            }
            switch outcome {
            case let .copy(text): UIPasteboard.general.string = text
            case let .open(url): UIApplication.shared.open(url)
            case let .markRead(id): service.markRead(botID: id)
            case .nothing: break
            }
        }
    }

    private func show(chat botID: String) {
        if let open = openChat {
            open(botID)
        } else {
            pendingOpen = botID
        }
    }

    /// The scene calls this once it can open chats.
    func takePendingOpen() -> String? {
        defer { pendingOpen = nil }
        return pendingOpen
    }
}
