#!/usr/bin/env bash
# Compile and execute the production authorization/trust helpers, including their
# existing XCTest cases. This does not require Apple SDKs or contact SSH hosts.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat > "$work/main.swift" <<'SWIFT'
import XCTest
XCTMain([
    testCase([
        ("testReadOnlyCommandsAreLow", CommandRiskTests.testReadOnlyCommandsAreLow),
        ("testChangesAreMedium", CommandRiskTests.testChangesAreMedium),
        ("testDestructiveOrExfiltratingCommandsAreHigh", CommandRiskTests.testDestructiveOrExfiltratingCommandsAreHigh),
        ("testScriptsAndHiddenWritesAreNotLow", CommandRiskTests.testScriptsAndHiddenWritesAreNotLow),
        ("testCompoundCommandTakesTheHighestSegment", CommandRiskTests.testCompoundCommandTakesTheHighestSegment),
    ]),
    testCase([
        ("testOnlyNarrowInspectionCommandsAutoApprove", SmartShellApprovalTests.testOnlyNarrowInspectionCommandsAutoApprove),
        ("testExecutableFormsAndWritesAlwaysAsk", SmartShellApprovalTests.testExecutableFormsAndWritesAlwaysAsk),
        ("testGitAutoApprovalRequiresTheSafeExecutedForm", SmartShellApprovalTests.testGitAutoApprovalRequiresTheSafeExecutedForm),
        ("testGitWorktreeCommandsRequireApprovalEvenWithDefensivePrefix", SmartShellApprovalTests.testGitWorktreeCommandsRequireApprovalEvenWithDefensivePrefix),
    ]),
    testCase([
        ("testRestartRetainsOriginalIntentAndIsolatesHostAndSession", HarnessOutboxTests.testRestartRetainsOriginalIntentAndIsolatesHostAndSession),
        ("testUnknownAndExpiredResultsRequireReceiptAndNeverAuthorizeReplay", HarnessOutboxTests.testUnknownAndExpiredResultsRequireReceiptAndNeverAuthorizeReplay),
        ("testPersistenceFailureAndCorruptionAreNotSuccess", HarnessOutboxTests.testPersistenceFailureAndCorruptionAreNotSuccess),
    ]),
    testCase([
        ("testLearningDeviceIdentityPreservesPendingOwner", HarnessOutboxIdentityTests.testLearningDeviceIdentityPreservesPendingOwner),
        ("testExplicitRetargetSeparatesPendingOwner", HarnessOutboxIdentityTests.testExplicitRetargetSeparatesPendingOwner),
    ]),
    testCase([
        ("testTrustRequiresExactEndpointAndExplicitKey", RemoteSSHTrustTests.testTrustRequiresExactEndpointAndExplicitKey),
        ("testOnlySinglePublicKeyLinesAreAccepted", RemoteSSHTrustTests.testOnlySinglePublicKeyLinesAreAccepted),
        ("testGatewayUsesOnlyPinnedHostKeyAndQuotesInputs", RemoteSSHTrustTests.testGatewayUsesOnlyPinnedHostKeyAndQuotesInputs),
    ])
])
SWIFT
# MinisTests uses Swift 6 even though the app currently uses Swift 5. Catch
# strict concurrency/type errors in the actual test-target inputs as well.
swiftc -swift-version 6 -typecheck -module-cache-path "$work/module-cache" \
    "$root/src/ios/Shared/CommandRisk.swift" \
    "$root/src/ios/MinisTests/CommandRiskTests.swift" \
    "$root/src/ios/Agent/Gateway/HarnessOutbox.swift" \
    "$root/src/ios/MinisTests/HarnessOutboxTests.swift" \
    "$root/src/ios/Agent/Session/RemoteSSHTrust.swift" \
    "$root/src/ios/MinisTests/RemoteSSHTrustTests.swift"
swiftc -swift-version 5 -module-cache-path "$work/module-cache" \
    "$root/src/ios/Shared/CommandRisk.swift" \
    "$root/src/ios/Agent/Gateway/HarnessOutbox.swift" \
    "$root/src/ios/MinisTests/HarnessOutboxTests.swift" \
    "$root/src/ios/MinisTests/CommandRiskTests.swift" \
    "$root/src/ios/Agent/Session/RemoteSSHTrust.swift" \
    "$root/src/ios/MinisTests/RemoteSSHTrustTests.swift" \
    "$work/main.swift" -o "$work/run"
"$work/run"
