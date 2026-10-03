#!/usr/bin/env bash
# Compile and execute the exact production helpers/test files using SwiftPM's
# platform-native XCTest discovery and runner. No package dependencies or hosts.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/Tests"
# Keep compiler and manifest caches inside the disposable workspace too.
export CLANG_MODULE_CACHE_PATH="$work/module-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$work/module-cache"
cat > "$work/Package.swift" <<'SWIFT'
// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "CoreSecurityChecks",
    platforms: [.macOS(.v13)],
    targets: [.testTarget(name: "CoreSecurityChecks", path: "Tests")],
    swiftLanguageModes: [.v6]
)
SWIFT
# SwiftPM locates Xcode's XCTest framework and native test launcher on macOS.
# A bare swiftc + Linux XCTMain runner cannot supply that Apple test context.
# Compiling in Swift 6 retains the stricter MinisTests target's concurrency gate.
for file in \
    src/ios/MinisTests/TestSupport_AppLogger.swift \
    src/ios/Shared/CommandRisk.swift \
    src/ios/MinisTests/CommandRiskTests.swift \
    src/ios/Agent/Gateway/HarnessOutbox.swift \
    src/ios/MinisTests/HarnessOutboxTests.swift \
    src/ios/Agent/Session/RemoteSSHTrust.swift \
    src/ios/MinisTests/RemoteSSHTrustTests.swift; do
    cp "$root/$file" "$work/Tests/"
done
swift test --package-path "$work" --scratch-path "$work/build" \
    --cache-path "$work/cache" --config-path "$work/config" --security-path "$work/security"
