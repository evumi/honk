import HonkKit
import NativeShell
import UIKit

/// Hosts the nsh app (built from ../app) full screen and wires the bridge.
final class RootViewController: UIViewController {
    private let nsh = NshAppView()
    private var bridge: NshBridge?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        nsh.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(nsh)
        NSLayoutConstraint.activate([
            nsh.topAnchor.constraint(equalTo: view.topAnchor),
            nsh.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            nsh.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            nsh.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        let service = HonkService.shared
        let bridge = NshBridge(app: nsh, service: service)
        self.bridge = bridge
        bridge.install()
        nsh.onError = { NSLog("honk: nsh error: \($0)") }
        nsh.params = ["gatewayURL": service.config.gatewayURL.absoluteString, "platform": "ios"]

        do {
            try load()
        } catch {
            NSLog("honk: nsh load failed: \(error)")
        }

        if let app = UIApplication.shared.delegate as? AppDelegate {
            app.openChat = { [weak bridge] id in bridge?.openChat(botID: id) }
            if let id = app.takePendingOpen() { bridge.openChat(botID: id) }
        }
        Task { await service.refresh() }
    }

    private func load() throws {
        // `NSH_DEV_URL=ws://127.0.0.1:8790/ws` (Xcode scheme environment) connects to `nsh dev ../app/App.tsx`
        // for hot reload; it needs NativeShellDev.xcframework linked in place of NativeShell.
        if let dev = ProcessInfo.processInfo.environment["NSH_DEV_URL"], let url = URL(string: dev) {
            try nsh.connectDevServer(url)
            return
        }
        let dir = Bundle.main.url(forResource: "nsh", withExtension: nil)
        if let caps = dir?.appendingPathComponent("capabilities.json"), let json = try? String(contentsOf: caps) {
            try nsh.grantCapabilities(json)
        }
        guard let bundle = Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh") else {
            throw NSError(domain: "honk", code: 1, userInfo: [NSLocalizedDescriptionKey: "nsh/bundle.nshc is missing: run scripts/build-nsh-bundle.sh"])
        }
        try nsh.loadBundle(at: bundle)
    }
}
