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
        // The system zlib, to measure a card the way the gateway does (zlib level 9).
        .systemLibrary(name: "CZlib"),
        .target(name: "HonkKit", dependencies: ["CZlib"], linkerSettings: [.linkedLibrary("sqlite3")]),
        .testTarget(name: "HonkKitTests", dependencies: ["HonkKit"]),
    ]
)
