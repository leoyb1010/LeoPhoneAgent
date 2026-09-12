// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "LeoWindowHelper",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "leo-window-helper", targets: ["LeoWindowHelper"]),
        .executable(name: "leo-window-fixture", targets: ["WindowFixture"]),
    ],
    targets: [
        .target(name: "WindowCore"),
        .executableTarget(name: "LeoWindowHelper", dependencies: ["WindowCore"]),
        .executableTarget(name: "WindowFixture"),
        .testTarget(name: "WindowCoreTests", dependencies: ["WindowCore"]),
    ]
)
