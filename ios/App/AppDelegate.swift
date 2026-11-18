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

    // MARK: background pushes (edits and deletes)

    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        guard let info = PushInfo(userInfo: userInfo) else {
            completionHandler(.noData)
            return
        }
        Task {
            let ok: Bool
            if info.kind == .message {
                // The extension already stored it; just refresh what is on screen.
                HonkService.shared.changed()
                ok = true
            } else {
                ok = await HonkService.shared.handleSilentPush(info)
            }
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
        defer { completionHandler() }
        guard let info = PushInfo(userInfo: response.notification.request.content.userInfo) else { return }
        Task { @MainActor in
            // A tap opens the chat; the message's url is one tap away in there.
            // A notification from before the bot got its short id names the old one.
            let botID = HonkService.shared.store.currentBotID(info.botID)
            if let open = self.openChat {
                open(botID)
            } else {
                self.pendingOpen = botID
            }
        }
    }

    /// The scene calls this once it can open chats.
    func takePendingOpen() -> String? {
        defer { pendingOpen = nil }
        return pendingOpen
    }
}
