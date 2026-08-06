// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "LeoAgentMac",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "LeoAgentMac", path: "Sources/LeoAgentMac")
    ]
)
