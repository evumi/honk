import HonkKit
import UIKit
import UserNotifications

/// The app's single owner of credentials, the local store and the gateway client.
@MainActor
final class HonkService {
    static let shared = HonkService()

    private(set) var config = HonkConfig.fromBundle()
    let credentials: CredentialStore
    let botTokens: BotTokenStore
    let store: LocalStore
    let images: ImageCache

    /// Where registration with the gateway stands; the settings page shows it.
    enum Registration: Equatable {
        case waitingForPushToken
        case registering
        case registered
        case failed(String)

        var name: String {
            switch self {
            case .waitingForPushToken: return "waitingForPushToken"
            case .registering: return "registering"
            case .registered: return "registered"
            case .failed: return "failed"
            }
        }
    }

    /// `apns`: the device has a real push token. `simulator`: a Debug simulator
    /// build registered without one; it polls while in the foreground instead.
    enum PushMode: String {
        case apns, simulator
    }

    private(set) var registration: Registration = .waitingForPushToken
    private(set) var pushMode: PushMode = .apns

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
        if let c = credentials.load() {
            registration = .registered
            pushMode = c.pushToken.hasPrefix(Self.simulatorTokenPrefix) ? .simulator : .apns
        }
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
        UserDefaults.standard.set(pushToken, forKey: Self.lastPushTokenKey)
        if !pushToken.hasPrefix(Self.simulatorTokenPrefix) { pushMode = .apns }
        if registration != .registered { setRegistration(.registering) }
        do {
            if let c = credentials.load() {
                if c.pushToken != pushToken {
                    do {
                        try await api.updatePushToken(pushToken)
                        try credentials.save(Credentials(deviceID: c.deviceID, secret: c.secret, pushToken: pushToken))
                    } catch let e as APIError where e.isUnauthorized {
                        // The gateway forgot this device: register again below.
                        credentials.clear()
                    }
                }
                if credentials.load() != nil {
                    setRegistration(.registered)
                    return
                }
            }
            let reg = try await APIClient(baseURL: config.gatewayURL, secret: nil).registerDevice(pushToken: pushToken)
            try credentials.save(Credentials(deviceID: reg.device.id, secret: reg.deviceSecret, pushToken: pushToken))
            setRegistration(.registered)
            await refresh()
        } catch {
            NSLog("honk: register failed: \(error)")
            setRegistration(.failed(Self.describe(error)))
        }
    }

    /// APNs gave no token: an unsigned build, missing entitlements, no network.
    func pushTokenUnavailable(_ error: Error?) async {
        #if DEBUG && targetEnvironment(simulator)
        await useSimulatorIdentity()
        #else
        if registration != .registered {
            setRegistration(.failed("无法取得推送 token：\(error.map(Self.describe) ?? "超时")。检查推送权限和网络后重试。"))
        }
        #endif
    }

    #if DEBUG && targetEnvironment(simulator)
    /// Debug simulator builds only: register with a stable `simulator-<uuid>`
    /// token so the app works against a real gateway without APNs. The gateway
    /// sends no pushes to such tokens; the app polls while in the foreground.
    func useSimulatorIdentity() async {
        guard pushMode == .simulator || credentials.load() == nil else { return }
        let key = "honk.simulatorToken"
        let token = UserDefaults.standard.string(forKey: key) ?? (Self.simulatorTokenPrefix + UUID().uuidString.lowercased())
        UserDefaults.standard.set(token, forKey: key)
        pushMode = .simulator
        NSLog("honk: no APNs token in this simulator build; registering as \(token)")
        await register(pushToken: token)
        startPolling()
    }
    #endif

    /// Tries registration again: checks the stored device, else registers with
    /// the last push token, else asks APNs for one. Returns once it settles.
    func retryRegistration() async {
        if credentials.load() != nil {
            do {
                _ = try await api.listBots()
                setRegistration(.registered)
                return
            } catch let e as APIError where e.isUnauthorized {
                credentials.clear()
            } catch {
                setRegistration(.failed(Self.describe(error)))
                return
            }
        }
        if let token = UserDefaults.standard.string(forKey: Self.lastPushTokenKey) {
            await register(pushToken: token)
            return
        }
        setRegistration(.waitingForPushToken)
        UIApplication.shared.registerForRemoteNotifications()
        #if DEBUG && targetEnvironment(simulator)
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        if registration == .waitingForPushToken { await useSimulatorIdentity() }
        #endif
        for _ in 0..<40 where registration == .waitingForPushToken || registration == .registering {
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
    }

    private func setRegistration(_ r: Registration) {
        registration = r
        changed()
    }

    static let simulatorTokenPrefix = "simulator-"
    static let lastPushTokenKey = "honk.lastPushToken"

    static func describe(_ error: Error) -> String {
        if let e = error as? APIError { return e.localizedDescription }
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain { return "连不上网关（\(ns.localizedDescription)）" }
        return ns.localizedDescription
    }

    // MARK: foreground polling (no push)

    private var pollTimer: Timer?

    /// Polls the gateway every 10 seconds while the app is active and has no
    /// push channel; pushes make this unnecessary otherwise.
    func startPolling() {
        guard pushMode == .simulator, pollTimer == nil, UIApplication.shared.applicationState == .active else { return }
        pollTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
    }

    func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    // MARK: gateway

    enum GatewayError: Error, LocalizedError {
        case invalidURL
        case notHonk
        var errorDescription: String? {
            switch self {
            case .invalidURL: return "地址无效：需要 http:// 或 https:// 开头的网址"
            case .notHonk: return "这个地址不是 Honk 网关"
            }
        }
    }

    /// Checks that `address` answers as a Honk gateway.
    func testGateway(_ address: String) async throws -> (url: URL, info: APIClient.GatewayInfo) {
        guard let url = HonkConfig.normalizeGateway(address) else { throw GatewayError.invalidURL }
        let info = try await APIClient(baseURL: url, secret: nil).info()
        guard info.name == "honk" else { throw GatewayError.notHonk }
        return (url, info)
    }

    /// Moves the device to another gateway (`nil`: the build's default). The
    /// new gateway knows nothing of this device, so its local data goes and it
    /// registers again; the bots on the old gateway stay there.
    func switchGateway(to address: String?) async throws {
        var target = config.defaultGatewayURL
        if let address {
            target = try await testGateway(address).url
        }
        guard target != config.gatewayURL else { return }
        let pushToken = credentials.load()?.pushToken
        HonkConfig.setGatewayOverride(target == config.defaultGatewayURL ? nil : target, appGroup: config.appGroup)
        config = HonkConfig.fromBundle()
        credentials.clear()
        botTokens.removeAll()
        removeNotifications((try? store.reset()) ?? [])
        changed()
        setRegistration(.waitingForPushToken)
        if let pushToken {
            await register(pushToken: pushToken)
        } else {
            await retryRegistration()
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
