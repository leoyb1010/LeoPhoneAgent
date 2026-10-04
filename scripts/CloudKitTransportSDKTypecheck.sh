#!/usr/bin/env bash
# SDK API/signature compile check, not a runtime test or full app build.
# Requires macOS with Xcode and an iOS Simulator SDK. It does not sign, link,
# launch, connect to CloudKit, or use the app's iSH/FFmpeg dependencies.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: CloudKit SDK typecheck requires macOS/Xcode; no check performed" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYNC="$ROOT/src/ios/Agent/Sync/V2"
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
SWIFTC="$(xcrun --sdk iphonesimulator --find swiftc)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/cloudkit-sdk-typecheck.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "Checking actual CloudKit transport with SDK: $SDK"
"$SWIFTC" --version
# App target uses SWIFT_VERSION=5.0 and IPHONEOS_DEPLOYMENT_TARGET=26.0.
# Cross-typechecking arm64 works on both Intel and Apple Silicon CI hosts.
"$SWIFTC" -typecheck -parse-as-library -swift-version 5 -D DEBUG \
  -sdk "$SDK" -target arm64-apple-ios26.0-simulator \
  -module-name CloudKitTransportSDKCheck -module-cache-path "$WORK/modules" \
  "$SYNC/PortableRecord.swift" \
  "$SYNC/SyncTransport.swift" \
  "$SYNC/Syncable.swift" \
  "$SYNC/SyncableTypeRegistry.swift" \
  "$SYNC/SyncHealth.swift" \
  "$SYNC/SyncRetryPolicy.swift" \
  "$SYNC/SyncDeliveryLedger.swift" \
  "$SYNC/UploadPolicy.swift" \
  "$SYNC/CloudKitInboundJournal.swift" \
  "$ROOT/src/ios/Shared/DeviceIdentity.swift" \
  "$ROOT/scripts/CloudKitTransportSDKStubs.swift" \
  "$SYNC/ICloudSharedZoneTransport.swift"
echo "CloudKit transport SDK typecheck passed (not runtime or full-app validation)."
