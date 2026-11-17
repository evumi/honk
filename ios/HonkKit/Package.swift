// swift-tools-version:5.10
// HonkKit is shared by the app and its Notification Service Extension: the
// gateway client, credentials in the shared keychain, the local SQLite store in
// the App Group, sync, and (iOS only) building communication notifications.
// It also builds on macOS so its tests run without Xcode.
import PackageDescription

let package = Package(
    name: "HonkKit",
    platforms: [.iOS(.v15), .macOS(.v13)],
    products: [
        .library(name: "HonkKit", targets: ["HonkKit"]),
    ],
    targets: [
        .target(name: "HonkKit", linkerSettings: [.linkedLibrary("sqlite3")]),
        .testTarget(name: "HonkKitTests", dependencies: ["HonkKit"]),
    ]
)
