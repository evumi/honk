import Foundation

/// Settings shared by the app and the extension, read from Info.plist so both
/// targets agree: `HonkGatewayURL`, `HonkAppGroup`, `HonkKeychainGroup`. The
/// user can point the app at another gateway; that choice lives in the App
/// Group's defaults so the extension follows it too.
public struct HonkConfig: Sendable {
    /// The gateway in use: the user's choice, else the build's default.
    public var gatewayURL: URL
    /// The gateway the build was configured with.
    public var defaultGatewayURL: URL
    public var appGroup: String
    /// Full keychain access group, team prefix included (`ABCDE12345.dev.evumi.honk.shared`).
    public var keychainGroup: String?

    public var isCustomGateway: Bool { gatewayURL != defaultGatewayURL }

    static let overrideKey = "gatewayURL"

    public init(gatewayURL: URL, defaultGatewayURL: URL? = nil, appGroup: String, keychainGroup: String?) {
        self.gatewayURL = gatewayURL
        self.defaultGatewayURL = defaultGatewayURL ?? gatewayURL
        self.appGroup = appGroup
        self.keychainGroup = keychainGroup
    }

    public static func fromBundle(_ bundle: Bundle = .main) -> HonkConfig {
        let info = bundle.infoDictionary ?? [:]
        let def = (info["HonkGatewayURL"] as? String).flatMap(normalizeGateway) ?? URL(string: "http://127.0.0.1:8080/")!
        let group = info["HonkAppGroup"] as? String ?? "group.dev.evumi.honk"
        let keychain = (info["HonkKeychainGroup"] as? String).flatMap { $0.isEmpty || $0.hasPrefix("$(") ? nil : $0 }
        let custom = UserDefaults(suiteName: group)?.string(forKey: overrideKey).flatMap(normalizeGateway)
        return HonkConfig(gatewayURL: custom ?? def, defaultGatewayURL: def, appGroup: group, keychainGroup: keychain)
    }

    /// Saves the user's gateway (`nil`: back to the build's default).
    public static func setGatewayOverride(_ url: URL?, appGroup: String) {
        let d = UserDefaults(suiteName: appGroup)
        if let url { d?.set(url.absoluteString, forKey: overrideKey) } else { d?.removeObject(forKey: overrideKey) }
    }

    /// An http(s) URL with a host, ending in `/` so API paths resolve under it;
    /// a bare host gets `https://`. `nil` for anything else.
    public static func normalizeGateway(_ s: String) -> URL? {
        var t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return nil }
        if !t.contains("://") { t = "https://" + t }
        guard var c = URLComponents(string: t), let scheme = c.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = c.host, !host.isEmpty, c.query == nil, c.fragment == nil else { return nil }
        c.scheme = scheme
        if !c.path.hasSuffix("/") { c.path += "/" }
        return c.url
    }
}

/// Cross-process change signal: the extension posts it after writing to the
/// store, and the running app refreshes its UI.
public enum ChangeSignal {
    public static let name = "dev.evumi.honk.store-changed"

    public static func post() {
        CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(),
                                             CFNotificationName(name as CFString), nil, nil, true)
    }

    /// Calls `handler` on the main queue whenever another process posts the signal.
    public static func observe(_ handler: @escaping () -> Void) -> AnyObject {
        let box = Observer(handler)
        CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(),
                                        Unmanaged.passUnretained(box).toOpaque(),
                                        { _, observer, _, _, _ in
                                            guard let observer else { return }
                                            let box = Unmanaged<Observer>.fromOpaque(observer).takeUnretainedValue()
                                            DispatchQueue.main.async { box.handler() }
                                        },
                                        name as CFString, nil, .deliverImmediately)
        return box
    }

    final class Observer {
        let handler: () -> Void
        init(_ handler: @escaping () -> Void) { self.handler = handler }
        deinit {
            CFNotificationCenterRemoveObserver(CFNotificationCenterGetDarwinNotifyCenter(),
                                               Unmanaged.passUnretained(self).toOpaque(), nil, nil)
        }
    }
}

/// Pulls everything queued since the stored cursor, applies it and acks it.
public struct SyncEngine: Sendable {
    let api: APIClient
    let store: LocalStore
    let opener: MessageOpener

    /// `opener` decrypts end-to-end sealed items before they are stored; it is
    /// required so no path applies a ciphertext as it is.
    public init(api: APIClient, store: LocalStore, opener: MessageOpener) {
        self.api = api
        self.store = store
        self.opener = opener
    }

    public struct Outcome: Sendable {
        public var applied = 0
        public var staleNotificationIDs: [String] = []
    }

    public func run() async throws -> Outcome {
        var out = Outcome()
        var cursor = store.syncCursor
        while true {
            let page = try await api.sync(cursor: cursor)
            for item in page.messages {
                guard let m = opener.open(item) else { continue }
                let r = try store.apply(m)
                out.staleNotificationIDs += r.staleNotificationIDs
                out.applied += 1
            }
            if page.cursor > cursor {
                cursor = page.cursor
                try store.setSyncCursor(cursor)
                try await api.ack(upTo: cursor)
            }
            if !page.hasMore { break }
        }
        return out
    }
}
