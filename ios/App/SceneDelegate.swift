import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = RootViewController()
        window.makeKeyAndVisible()
        self.window = window
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        Task { await HonkService.shared.refresh() }
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        HonkService.shared.updateBadge()
        HonkService.shared.startPolling()
    }

    func sceneWillResignActive(_ scene: UIScene) {
        HonkService.shared.stopPolling()
    }
}
