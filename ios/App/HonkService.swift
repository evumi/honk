import HonkKit
import UIKit
import UserNotifications

/// The app's single owner of credentials, the local store and the gateway client.
@MainActor
final class HonkService {
    static let shared = HonkService()

    let config = HonkConfig.fromBundle()
    let credentials: CredentialStore
    let botTokens: BotTokenStore
    let store: LocalStore
    let images: ImageCache

    /// Called after the store changed: a push arrived, a sync ran, the extension wrote.
    var onChange: (() -> Void)?
    /// The bot whose chat is on screen; its foreground banners are not shown.
    var focusedBotID: Int64?

    private var changeObserver: AnyObject?
    private var syncing = false

    private init() {
        credentials = CredentialStore(accessGroup: config.keychainGroup)
        botTokens = BotTokenStore(accessGroup: config.keychainGroup)
        do {
            store = try LocalStore(appGroup: config.appGroup)
        } catch {
            // Without the App Group (a misconfigured build) keep working from a private file.
            let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            store = try! LocalStore(path: url.appendingPathComponent("honk.sqlite").path)
        }
        images = ImageCache(appGroup: config.appGroup)
        changeObserver = ChangeSignal.observe { [weak self] in self?.changed() }
    }

    var api: APIClient { APIClient(baseURL: config.gatewayURL, secret: credentials.load()?.secret) }
    var isRegistered: Bool { credentials.load() != nil }

    func changed() {
        updateBadge()
        onChange?()
    }

    // MARK: registration

    /// Registers the device, or sends the new push token if it changed.
    func register(pushToken: String) async {
        do {
            if let c = credentials.load() {
                guard c.pushToken != pushToken else { return }
                do {
                    try await api.updatePushToken(pushToken)
                    try credentials.save(Credentials(deviceID: c.deviceID, secret: c.secret, pushToken: pushToken))
                    return
                } catch let e as APIError where e.isUnauthorized {
                    // The gateway forgot this device: register again below.
                    credentials.clear()
                }
            }
            let reg = try await APIClient(baseURL: config.gatewayURL, secret: nil).registerDevice(pushToken: pushToken)
            try credentials.save(Credentials(deviceID: reg.device.id, secret: reg.deviceSecret, pushToken: pushToken))
            await refresh()
        } catch {
            NSLog("honk: register failed: \(error)")
        }
    }

    // MARK: sync

    /// Fetches the bot list and anything queued, then refreshes the UI.
    func refresh() async {
        guard isRegistered, !syncing else { return }
        syncing = true
        defer { syncing = false }
        do {
            try store.replaceBots(try await api.listBots())
            let out = try await SyncEngine(api: api, store: store).run()
            removeNotifications(out.staleNotificationIDs)
        } catch {
            NSLog("honk: refresh failed: \(error)")
        }
        changed()
    }

    /// Handles a background push (an edit or delete): fetch it, apply it.
    func handleSilentPush(_ info: PushInfo) async -> Bool {
        guard isRegistered else { return false }
        do {
            let m = try await api.message(id: info.messageID)
            let r = try store.apply(m)
            removeNotifications(r.staleNotificationIDs)
            changed()
            return true
        } catch {
            // Gone from the queue already (a sync applied it) or offline: sync later.
            await refresh()
            return false
        }
    }

    // MARK: notifications

    func removeNotifications(_ ids: [String]) {
        guard !ids.isEmpty else { return }
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
    }

    func updateBadge() {
        let n = (try? store.unreadTotal()) ?? 0
        if #available(iOS 16.0, *) {
            UNUserNotificationCenter.current().setBadgeCount(n)
        } else {
            UIApplication.shared.applicationIconBadgeNumber = n
        }
    }

    func markRead(botID: Int64) {
        removeNotifications((try? store.markRead(botID: botID)) ?? [])
        changed()
    }
}
