import XCTest

@MainActor
final class SpeechCaptureStartTests: XCTestCase {
    @MainActor private final class PermissionReply {
        var continuation: CheckedContinuation<Void, Error>?
        func wait() async throws { try await withCheckedThrowingContinuation { continuation = $0 } }
        func approve() { continuation?.resume(); continuation = nil }
    }
    private func settle(_ condition: () -> Bool) async {
        for _ in 0..<1000 { if condition() { return }; await Task.yield() }
        XCTFail("Capture-start request did not settle")
    }

    func testPermissionReplyAfterStopCannotStartMicrophone() async {
        let gate = SpeechCaptureStartGate()
        let reply = PermissionReply()
        var starts = 0, failures = 0
        XCTAssertTrue(gate.begin(prepare: { try await reply.wait() }, canStart: { true },
            start: { starts += 1 }, onFailure: { _ in failures += 1 }))
        await settle { reply.continuation != nil }
        gate.cancel()
        reply.approve()
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(starts, 0)
        XCTAssertEqual(failures, 0)
        XCTAssertFalse(gate.isPending)
    }

    func testOldCallbackCannotClearOrStartReplacementRequest() async {
        let gate = SpeechCaptureStartGate()
        let old = PermissionReply(), fresh = PermissionReply()
        var starts = 0
        _ = gate.begin(prepare: { try await old.wait() }, canStart: { true }, start: { starts += 100 }, onFailure: { _ in XCTFail() })
        await settle { old.continuation != nil }
        gate.cancel()
        _ = gate.begin(prepare: { try await fresh.wait() }, canStart: { true }, start: { starts += 1 }, onFailure: { _ in XCTFail() })
        await settle { fresh.continuation != nil }
        old.approve()
        for _ in 0..<10 { await Task.yield() }
        XCTAssertTrue(gate.isPending)
        XCTAssertEqual(starts, 0)
        fresh.approve()
        await settle { !gate.isPending }
        XCTAssertEqual(starts, 1)
    }

    func testDuplicateRequestIsCoalescedAndBackgroundCheckRunsAfterPermission() async {
        let gate = SpeechCaptureStartGate()
        let reply = PermissionReply()
        var foreground = true, starts = 0
        _ = gate.begin(prepare: { try await reply.wait() }, canStart: { foreground }, start: { starts += 1 }, onFailure: { _ in XCTFail() })
        XCTAssertFalse(gate.begin(prepare: { XCTFail("duplicate prompt") }, canStart: { true }, start: { XCTFail() }, onFailure: { _ in XCTFail() }))
        await settle { reply.continuation != nil }
        foreground = false
        reply.approve()
        await settle { !gate.isPending }
        XCTAssertEqual(starts, 0)
    }

    func testCurrentFailureIsVisibleAndPendingStateClears() async {
        let gate = SpeechCaptureStartGate()
        var transitions: [Bool] = [], failures = 0
        gate.onPendingChange = { transitions.append($0) }
        _ = gate.begin(prepare: { throw SystemSpeechError.legacyPermissionRequired }, canStart: { true }, start: { XCTFail() }, onFailure: { _ in failures += 1 })
        await settle { !gate.isPending }
        XCTAssertEqual(failures, 1)
        XCTAssertEqual(transitions, [true, false])
    }
}
