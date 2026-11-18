import HonkKit
import UIKit
import UserNotifications

/// A failure whose reason the app shows as it is.
struct Failure: Error, LocalizedError {
    let reason: String
    var errorDescription: String? { reason }
}

/// The app's single owner of credentials, the local store and the gateway client.
@MainActor
final class HonkService {
    static let shared = HonkService()

    private(set) var config = HonkConfig.fromBundle()
    let credentials: CredentialStore
    let botTokens: BotTokenStore
    /// Each bot's end-to-end key; with `opener` it decrypts what the queue delivers.
    let botKeys: BotKeyStore
    /// The group key, which wraps each bot's key for the gateway so the group's other devices can unwrap it.
    let groupKey: GroupKeyStore
    let keyRing: KeyRing
    let opener: MessageOpener
    /// The register key of the gateway, when it asks for one.
    let registerKeys: RegisterKeyStore
    let store: LocalStore
    let images: ImageCache

    /// Where registration with the gateway stands; the settings page shows it.
    enum Registration: Equatable {
        /// The device's data was deleted; it registers again when a bot is created or the app starts.
        case notRegistered
        case waitingForPushToken
        case registering
        case registered
        case failed(String)

        var name: String {
            switch self {
            case .notRegistered: return "notRegistered"
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
    /// A message arrived while the app is open (not for the open chat): the
    /// app shows its own banner. Nil until the UI listens.
    var onIncoming: ((_ botID: String, _ messageID: Int64) -> Void)?
    /// The bot whose chat is on screen; its foreground banners are not shown.
    var focusedBotID: String?

    private var changeObserver: AnyObject?
    private var syncing = false

    private init() {
        credentials = CredentialStore(accessGroup: config.keychainGroup)
        botTokens = BotTokenStore(accessGroup: config.keychainGroup)
        botKeys = BotKeyStore(accessGroup: config.keychainGroup)
        groupKey = GroupKeyStore(accessGroup: config.keychainGroup)
        keyRing = KeyRing(keys: botKeys, group: groupKey)
        opener = MessageOpener(keys: botKeys)
        registerKeys = RegisterKeyStore(accessGroup: config.keychainGroup)
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
        pruneExpired()
    }

    /// Deletes the messages older than the retention period the user chose in Settings (default: keep forever).
    /// At start and on every refresh. Returns whether anything went.
    @discardableResult
    func pruneExpired() -> Bool {
        guard let ids = try? store.pruneExpired() else { return false }
        removeNotifications(ids)
        return !ids.isEmpty
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
                        forgetDevice()
                    } catch {
                        // Offline or a gateway error: the device is still registered.
                        // The stored token stays the old one, so the next launch
                        // (which reports the token again) retries the update.
                        NSLog("honk: push token update failed, will retry: \(error)")
                        setRegistration(.registered)
                        return
                    }
                }
                if credentials.load() != nil {
                    setRegistration(.registered)
                    return
                }
            }
            let reg = try await APIClient(baseURL: config.gatewayURL, secret: nil).registerDevice(pushToken: pushToken, registerKey: registerKeys.load(), name: UIDevice.current.name)
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
                forgetDevice()
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

    /// The gateway no longer knows this device: drop its credentials and the group key, so a new, unrelated group
    /// the device registers into does not reuse the old group's key. (The old bots' tokens and keys are pruned
    /// when the next refresh no longer lists them.)
    private func forgetDevice() {
        credentials.clear()
        groupKey.remove()
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
    /// registers again; the bots on the old gateway stay there. `registerKey`
    /// is the key that gateway asks for when registering, if any; it replaces
    /// the saved one. With the same gateway only the key changes.
    func switchGateway(to address: String?, registerKey: String? = nil) async throws {
        var target = config.defaultGatewayURL
        if let address {
            target = try await testGateway(address).url
        }
        // Only after the address checked out, so a typo never changes the key.
        registerKeys.save(registerKey)
        guard target != config.gatewayURL else {
            // Only the key may have changed: a device that could not register may now.
            if !isRegistered { await retryRegistration() }
            return
        }
        let pushToken = credentials.load()?.pushToken
        HonkConfig.setGatewayOverride(target == config.defaultGatewayURL ? nil : target, appGroup: config.appGroup)
        config = HonkConfig.fromBundle()
        clearAccountData()
        changed()
        setRegistration(.waitingForPushToken)
        if let pushToken {
            await register(pushToken: pushToken)
        } else {
            await retryRegistration()
        }
    }

    /// Forgets everything this phone keeps for the account: the device
    /// credentials, the bot tokens, the messages, and the notifications shown for them.
    private func clearAccountData() {
        credentials.clear()
        botTokens.removeAll()
        botKeys.removeAll()
        groupKey.remove()
        removeNotifications((try? store.reset()) ?? [])
    }

    // MARK: deleting this device's data

    enum DeleteError: Error, LocalizedError {
        case failed(String)
        var errorDescription: String? {
            switch self {
            case let .failed(reason): return reason
            }
        }
    }

    /// Deletes everything: on the gateway this device's whole group (every
    /// device, the bots and the queued messages), then the phone: account data
    /// as when switching gateway, plus the avatars and every delivered
    /// notification. When the gateway cannot be reached nothing local is
    /// touched and this throws. It does not register again: that happens when
    /// a bot is created next (`honk.bot.create`) or the app starts again (the
    /// push token arrives).
    func deleteDeviceData() async throws {
        try await leave(all: true)
    }

    /// Takes this phone out of its device group: the gateway forgets this device
    /// (the group's bots stay for the others; with no other device it is the
    /// same as deleting everything), then the phone is cleared as above.
    func leaveGroup() async throws {
        try await leave(all: false)
    }

    private func leave(all: Bool) async throws {
        if credentials.load() != nil {
            do {
                try await api.deleteDevice(all: all)
            } catch let e as APIError where e.isUnauthorized {
                // The gateway had forgotten this device already.
            } catch {
                throw DeleteError.failed(Self.describe(error))
            }
        }
        clearAccountData()
        LocalAvatars(appGroup: config.appGroup).removeAll()
        images.removeAll()
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        setRegistration(.notRegistered)
    }

    // MARK: device group

    /// The devices of this phone's group; none when it is not registered.
    func listDevices() async throws -> [APIClient.GroupDevice] {
        guard isRegistered else { return [] }
        return try await api.listDevices()
    }

    /// Removes a device from the group. This phone's own id leaves the group.
    func removeDevice(id: String) async throws {
        if let own = credentials.load()?.deviceID, own == id {
            try await leaveGroup()
        } else {
            try await api.removeDevice(id: id)
        }
        changed()
    }

    /// A pairing code for another phone, with this phone's bot tokens sealed in it.
    func createLink() async throws -> DeviceLinking.Created {
        // The bundle carries the group key (made now if this is the first pairing) and the bot keys.
        try await DeviceLinking.create(api: api, store: store, tokens: botTokens,
                                       keys: keyRing.bundleKeys(botIDs: try store.botIDs()),
                                       groupKey: Seal.encode(keyRing.ensureGroupKey()))
    }

    /// Joins the group that made `code`: stores the tokens it holds, then
    /// refreshes (the merged bot list and queue). The gateway merges this
    /// phone's own bots into that group.
    func claimLink(code: String) async throws {
        if !isRegistered { await retryRegistration() }
        do {
            // Adopt the creator's group key and bot keys; the refresh below re-wraps
            // this phone's own encrypted bots with it (KeyRing.reconcile).
            let bundle = try await DeviceLinking.claim(code, api: api, store: store, tokens: botTokens)
            keyRing.adopt(bundle)
        } catch let e as APIError {
            throw Failure(reason: Self.describe(e))
        }
        await refresh()
    }

    /// Fetches the bot list and reconciles the keys: another device of the group
    /// may have turned encryption on or reset a key since the last refresh.
    func refreshKeys() async {
        let api = self.api
        guard let bots = try? await api.listBots() else { return }
        await keyRing.reconcile(bots: bots) { id, wrapped in _ = try await api.updateBot(id: id, keyWrapped: wrapped) }
    }

    // MARK: sync

    /// Fetches the bot list and anything queued, then refreshes the UI.
    func refresh() async {
        guard isRegistered, !syncing else { return }
        syncing = true
        defer { syncing = false }
        do {
            pruneExpired()
            let api = self.api
            let bots = try await api.listBots()
            // Bots still stored by integer id move to their short id; one whose
            // rename failed for now (offline, 5xx) is kept for the next refresh.
            let renamed = await LegacyBotIDs.rename(store: store, tokens: botTokens, serverBots: bots) {
                try await api.getMe(token: $0)
            }
            try store.replaceBots(bots, keeping: renamed.pending)
            // Tokens and keys of bots the gateway no longer lists (deleted elsewhere, another group).
            try SecretPruning.prune(store: store, tokens: botTokens, keys: botKeys)
            // Keys other devices turned on or reset arrive here; ours are published.
            await keyRing.reconcile(bots: bots) { id, wrapped in _ = try await api.updateBot(id: id, keyWrapped: wrapped) }
            let out = try await SyncEngine(api: api, store: store, opener: opener).run()
            removeNotifications(out.staleNotificationIDs)
            pruneExpired()
            LocalAvatars(appGroup: config.appGroup).prune(keeping: Set(bots.map(\.avatar)))
        } catch let e as APIError where e.isUnauthorized {
            // The gateway forgot this device (another device of the group removed it,
            // or its data was deleted): register again, as a device of its own.
            NSLog("honk: the gateway no longer knows this device; registering again")
            forgetDevice()
            setRegistration(.waitingForPushToken)
            if let token = UserDefaults.standard.string(forKey: Self.lastPushTokenKey) {
                Task { await register(pushToken: token) }
            }
        } catch {
            NSLog("honk: refresh failed: \(error)")
        }
        changed()
    }

    /// Handles a background push (an edit or delete): fetch it, apply it.
    func handleSilentPush(_ info: PushInfo) async -> Bool {
        guard isRegistered else { return false }
        await LegacyBotIDs.renameBeforePush(store: store, tokens: botTokens,
                                            api: APIClient(baseURL: config.gatewayURL, secret: credentials.load()?.secret, timeout: 5))
        do {
            let item = try await api.message(id: info.messageID)
            // At most every few minutes: a message that stays unopenable must not cost a bot list each time.
            if !opener.opens(item), (try? store.claimSlot("key-refresh", interval: 5 * 60 * 1000)) == true { await refreshKeys() }
            guard let m = opener.open(item) else { return true }
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

    /// Marks a bot's messages read. Announces a change only when something was
    /// unread: the chat page reloads on changes and marks read on load, so an
    /// unconditional announcement would loop.
    func markRead(botID: String) {
        guard ((try? store.unreadCount(botID: botID)) ?? 0) > 0 else { return }
        removeNotifications((try? store.markRead(botID: botID)) ?? [])
        changed()
    }
}
