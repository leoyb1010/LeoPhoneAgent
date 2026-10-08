import XCTest

/// [T-ios-shellring-counter-leak] didStart must be balanced on every exit path,
/// exactly once, even after the entry was evicted from the 10-slot ring.
final class ShellCommandRingBufferTests: XCTestCase {
    func testAbortBalancesTheRunningCounter() async {
        let ring = ShellCommandRingBuffer()
        let idx = await ring.didStart(command: "sleep 100", sessionId: "s")
        XCTAssertTrue(ShellCommandRingBuffer.hasRunningCommand)
        await ring.didAbort(index: idx)
        XCTAssertFalse(ShellCommandRingBuffer.hasRunningCommand)
        let entry = await ring.snapshot().first { $0.index == idx }
        XCTAssertNil(entry?.exitCode, "an abort is not a fake exit status")
        XCTAssertNotNil(entry?.exitedAt)
    }

    func testDuplicateTerminalCallsDecrementOnlyOnce() async {
        let ring = ShellCommandRingBuffer()
        let a = await ring.didStart(command: "a", sessionId: "s")
        let b = await ring.didStart(command: "b", sessionId: "s")
        await ring.didExit(index: a, exitCode: 0)
        await ring.didAbort(index: a)
        await ring.didExit(index: a, exitCode: 1)
        XCTAssertTrue(ShellCommandRingBuffer.hasRunningCommand, "b is still running")
        await ring.didExit(index: b, exitCode: 0)
        XCTAssertFalse(ShellCommandRingBuffer.hasRunningCommand)
    }

    func testEvictedEntryStillReleasesTheCounter() async {
        let ring = ShellCommandRingBuffer()
        let longRunning = await ring.didStart(command: "long", sessionId: "s")
        for i in 0..<15 {
            let idx = await ring.didStart(command: "c\(i)", sessionId: "s")
            await ring.didExit(index: idx, exitCode: 0)
        }
        let retained = await ring.snapshot().contains { $0.index == longRunning }
        XCTAssertFalse(retained, "evicted from the ring")
        XCTAssertTrue(ShellCommandRingBuffer.hasRunningCommand)
        await ring.didAbort(index: longRunning)
        XCTAssertFalse(ShellCommandRingBuffer.hasRunningCommand)
    }

    func testCommandTextIsNotRetained() async {
        let ring = ShellCommandRingBuffer()
        let idx = await ring.didStart(command: "curl -H 'Authorization: secret'", sessionId: "s")
        let entry = await ring.snapshot().first { $0.index == idx }
        XCTAssertEqual(entry?.commandLength, 31)
        XCTAssertFalse(String(describing: entry as Any).contains("secret"))
        await ring.didExit(index: idx, exitCode: 0)
    }
}
