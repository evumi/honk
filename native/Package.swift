// swift-tools-version:5.10
// Card scripts for the iOS app: quickjs-ng and the card sandbox (C, shared
// with Android), and HonkCard, which runs cards on a background queue and
// drives their timers. Builds on macOS too, so `swift test` runs without Xcode.
import PackageDescription

let package = Package(
    name: "HonkCard",
    platforms: [.iOS(.v15), .macOS(.v13)],
    products: [
        .library(name: "HonkCard", targets: ["HonkCard"]),
    ],
    targets: [
        .target(
            name: "HonkCardC",
            path: ".",
            exclude: ["card/test", "card/runtime.js", "card/gen_runtime.py", "Makefile", "build", "swift", "jni", ".gitignore", "quickjs/LICENSE", "quickjs/VERSION"],
            sources: ["quickjs/quickjs.c", "quickjs/libregexp.c", "quickjs/libunicode.c", "quickjs/dtoa.c", "card/honk_card.c"],
            publicHeadersPath: "card/include",
            cSettings: [
                .define("NDEBUG"),
                .define("_GNU_SOURCE"),
                .headerSearchPath("quickjs"),
                .headerSearchPath("card"),
            ]
        ),
        .target(name: "HonkCard", dependencies: ["HonkCardC"], path: "swift/HonkCard"),
        .testTarget(name: "HonkCardTests", dependencies: ["HonkCard"], path: "swift/Tests"),
    ]
)
