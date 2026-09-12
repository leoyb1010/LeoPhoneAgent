import XCTest

final class OffloadPermissionPolicyTests: XCTestCase {
    func testPrivacyDefaultsToAskWhenUnset() {
        XCTAssertEqual(OffloadPermissionPolicy.resolvedLevel(stored: nil, isPrivacy: true), 1)
        XCTAssertEqual(OffloadPermissionPolicy.resolvedLevel(stored: 0, isPrivacy: true), 0)
        XCTAssertEqual(OffloadPermissionPolicy.resolvedLevel(stored: 1, isPrivacy: true), 1)
        XCTAssertEqual(OffloadPermissionPolicy.resolvedLevel(stored: nil, isPrivacy: false), 0)
    }

    func testExtractFindsOffloadAfterPathOrChain() {
        let known = ["apple-files", "apple-camera"]
        XCTAssertEqual(
            OffloadPermissionPolicy.extractOffloadCommand(from: "apple-files request", known: known),
            "apple-files"
        )
        XCTAssertEqual(
            OffloadPermissionPolicy.extractOffloadCommand(from: "/usr/local/bin/apple-files request", known: known),
            "apple-files"
        )
        XCTAssertEqual(
            OffloadPermissionPolicy.extractOffloadCommand(from: "cd /tmp && apple-camera photo", known: known),
            "apple-camera"
        )
        XCTAssertNil(OffloadPermissionPolicy.extractOffloadCommand(from: "ls /tmp", known: known))
    }

    func testDenialStringsAreChinese() {
        XCTAssertTrue(OffloadPermissionPolicy.disabledDenial(command: "apple-files").contains("已拒绝"))
        XCTAssertFalse(OffloadPermissionPolicy.disabledDenial(command: "apple-files").hasPrefix("Permission denied"))
    }
}

extension OffloadPermissionPolicyTests {
    func testNativeActionsDoNotTrustExecutableNameOrShellSyntax() {
        let invocation = OffloadPermissionInvocation(command: "apple-contacts", arguments: ["delete", "--id", "a b; apple-device"])
        XCTAssertEqual(invocation.command, "apple-contacts")
        XCTAssertEqual(invocation.action, "delete")
        XCTAssertTrue(invocation.isMutation)
        XCTAssertNotEqual(invocation.grantScope,
                          OffloadPermissionInvocation(command: "apple-contacts", arguments: ["list"]).grantScope)
    }

    func testChangingWriteArgumentsRequiresAnotherGrant() {
        let first = OffloadPermissionInvocation(command: "apple-reminders", arguments: ["create", "--title", "a"])
        let other = OffloadPermissionInvocation(command: "apple-reminders", arguments: ["create", "--title", "b"])
        XCTAssertNotEqual(first.grantScope, other.grantScope)
        XCTAssertFalse(first.grantScope.contains("--title"))
        XCTAssertEqual(first.grantScope, first.grantScope)
    }

    func testCalendarReminderAliasesUseReminderPermission() {
        let invocation = OffloadPermissionInvocation(command: "apple-calendar", arguments: ["delete-reminder", "--id", "r"])
        XCTAssertEqual(invocation.registeredCommand, "apple-calendar")
        XCTAssertEqual(invocation.command, "apple-reminders")
        XCTAssertEqual(invocation.action, "delete")
        XCTAssertTrue(invocation.isMutation)
    }

    func testNativeDefaultsAndMetadataAreClassifiedWithoutPromptingForStatus() {
        XCTAssertEqual(OffloadPermissionInvocation(command: "apple-clipboard", arguments: []).action, "get")
        XCTAssertEqual(OffloadPermissionInvocation(command: "apple-device", arguments: []).action, "info")
        XCTAssertTrue(OffloadPermissionInvocation(command: "apple-camera", arguments: ["status"]).isStatusOnly)
        XCTAssertFalse(OffloadPermissionInvocation(command: "apple-camera", arguments: ["photo"]).isStatusOnly)
        XCTAssertTrue(OffloadPermissionInvocation(command: "apple-contacts", arguments: ["--help"]).isStatusOnly)
    }

    func testDeviceStatusAndSetUseTheSameCanonicalNativeArguments() {
        let read = OffloadPermissionInvocation(command: "apple-device", arguments: ["torch", "--status"])
        let write = OffloadPermissionInvocation(command: "apple-device", arguments: ["torch", "--set", "on", "--level", "0.5"])
        let brightness = OffloadPermissionInvocation(command: "apple-device", arguments: ["brightness", "--set", "0.6"])
        XCTAssertTrue(read.isStatusOnly)
        XCTAssertFalse(write.isStatusOnly)
        XCTAssertTrue(write.isMutation)
        XCTAssertTrue(brightness.isMutation)
        let flagsFirst = OffloadPermissionInvocation(command: "apple-device", arguments: ["--compact", "torch", "--set", "on"])
        XCTAssertEqual(flagsFirst.action, "torch")
        XCTAssertTrue(flagsFirst.isMutation)
        XCTAssertNotEqual(read.grantScope, write.grantScope)
    }

    func testOldPermissionCannotRestoreActivityAfterStopOrIntoAnotherRun() {
        XCTAssertTrue(OffloadPermissionPolicy.isSameActiveRun(requestedRunID: "one", currentRunID: "one", isActive: true))
        XCTAssertFalse(OffloadPermissionPolicy.isSameActiveRun(requestedRunID: "one", currentRunID: nil, isActive: false))
        XCTAssertFalse(OffloadPermissionPolicy.isSameActiveRun(requestedRunID: "one", currentRunID: "two", isActive: true))
        XCTAssertFalse(OffloadPermissionPolicy.isSameActiveRun(requestedRunID: nil, currentRunID: "two", isActive: true))
    }

    func testHelpLookingFieldValueCannotTurnNativeWriteIntoReadOnlyHelp() {
        for command in ["apple-contacts", "apple-calendar", "apple-reminders", "apple-photos"] {
            let write = OffloadPermissionInvocation(command: command, arguments: ["create", "--name", "--help"])
            XCTAssertEqual(write.action, "create")
            XCTAssertFalse(write.isStatusOnly)
            XCTAssertTrue(write.isMutation)
        }
        XCTAssertTrue(OffloadPermissionInvocation(command: "apple-contacts", arguments: ["--help"]).isStatusOnly)
        XCTAssertTrue(OffloadPermissionInvocation(command: "apple-contacts", arguments: ["--compact", "-h"]).isStatusOnly)
    }

    func testFamilyAndActionRevocationsOverrideExistingGrants() {
        XCTAssertEqual(OffloadPermissionPolicy.resolvedNativeLevel(family: 2, actionOverride: 0), 2)
        XCTAssertEqual(OffloadPermissionPolicy.resolvedNativeLevel(family: 1, actionOverride: 2), 2)
        XCTAssertEqual(OffloadPermissionPolicy.resolvedNativeLevel(family: 0, actionOverride: 1), 1)
    }
}

@MainActor
final class OffloadPermissionQueueTests: XCTestCase {
    private func request(_ id: String, session: String) -> OffloadPermissionQueue.Pending {
        .init(id: id, invocation: .init(command: "apple-contacts", arguments: ["list"]), sessionID: session)
    }

    private func waitUntil(_ condition: @escaping () -> Bool) async {
        for _ in 0..<200 {
            if condition() { return }
            await Task.yield()
        }
        XCTFail("Permission queue did not reach the expected state")
    }

    func testConcurrentRequestsKeepFIFOAndResolveExactlyOnce() async {
        let queue = OffloadPermissionQueue()
        let first = Task { await queue.enqueue(request("one", session: "s1")) }
        await waitUntil { queue.current?.id == "one" }
        let second = Task { await queue.enqueue(request("two", session: "s2")) }
        await waitUntil { queue.count == 2 }
        queue.respond(id: "two", decision: .allowed) // A queued, hidden request cannot be approved.
        XCTAssertEqual(queue.current?.id, "one")
        queue.respond(id: "one", decision: .allowed)
        queue.respond(id: "one", decision: .denied) // Late duplicate is harmless.
        XCTAssertEqual(queue.current?.id, "two")
        queue.respond(id: "two", decision: .denied)
        let firstResult = await first.value
        let secondResult = await second.value
        XCTAssertEqual(firstResult, .allowed)
        XCTAssertEqual(secondResult, .denied)
        XCTAssertEqual(queue.count, 0)
    }

    func testCancellingOneSessionDoesNotCancelAnother() async {
        let queue = OffloadPermissionQueue()
        let first = Task { await queue.enqueue(request("one", session: "s1")) }
        await waitUntil { queue.current?.id == "one" }
        let second = Task { await queue.enqueue(request("two", session: "s2")) }
        await waitUntil { queue.count == 2 }
        queue.cancel(where: { $0.sessionID == "s1" }, decision: .cancelled)
        XCTAssertEqual(queue.current?.id, "two")
        queue.respond(id: "two", decision: .allowed)
        let firstResult = await first.value
        let secondResult = await second.value
        XCTAssertEqual(firstResult, .cancelled)
        XCTAssertEqual(secondResult, .allowed)
    }

    func testLosingPresenterResolvesAllWaitersWithoutLeakingContinuation() async {
        let queue = OffloadPermissionQueue()
        let first = Task { await queue.enqueue(request("one", session: "s1")) }
        await waitUntil { queue.current?.id == "one" }
        let second = Task { await queue.enqueue(request("two", session: "s2")) }
        await waitUntil { queue.count == 2 }
        queue.cancel(where: { _ in true }, decision: .needsForeground)
        let firstResult = await first.value
        let secondResult = await second.value
        XCTAssertEqual(firstResult, .needsForeground)
        XCTAssertEqual(secondResult, .needsForeground)
        XCTAssertNil(queue.current)
    }

    func testCancellingTheAwaitingTaskDismissesItsRequest() async {
        let queue = OffloadPermissionQueue()
        let task = Task { await queue.enqueue(request("one", session: "s1")) }
        await waitUntil { queue.current?.id == "one" }
        task.cancel()
        let result = await task.value
        XCTAssertEqual(result, .cancelled)
        XCTAssertNil(queue.current)
    }

    func testTimeoutAndLateApprovalCannotGrantAccess() async {
        let queue = OffloadPermissionQueue(timeoutNanoseconds: 1_000_000)
        let task = Task { await queue.enqueue(request("one", session: "s1")) }
        let result = await task.value
        queue.respond(id: "one", decision: .allowed)
        XCTAssertEqual(result, .timedOut)
        XCTAssertNil(queue.current)
    }
}
