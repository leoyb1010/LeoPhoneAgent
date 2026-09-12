import XCTest

final class CameraCaptureOperationTests: XCTestCase {
    func testCancellationBeforePresentationRejectsLaterResults() {
        let operation = CameraCaptureOperation()
        operation.requestCancellation(timedOut: false)
        XCTAssertFalse(operation.acceptsResults)
        XCTAssertEqual(operation.takeCompletion()?.cancellationCode, "cancelled")
        XCTAssertNil(operation.takeCompletion())
    }

    func testTimeoutKeepsItsReasonWhenCleanupAlsoRequestsCancellation() {
        let operation = CameraCaptureOperation()
        operation.requestCancellation(timedOut: true)
        operation.requestCancellation(timedOut: false)
        XCTAssertEqual(operation.takeCompletion()?.cancellationCode, "timed_out")
    }

    func testDuplicateAndLateCallbacksCannotClaimAnotherCompletion() {
        let operation = CameraCaptureOperation()
        XCTAssertTrue(operation.acceptsResults)
        let claim = operation.takeCompletion()
        XCTAssertNotNil(claim)
        XCTAssertNil(claim?.cancellationCode)
        operation.requestCancellation(timedOut: true)
        XCTAssertFalse(operation.acceptsResults)
        XCTAssertNil(operation.takeCompletion())
    }

    func testCancellationOfOldOperationDoesNotChangeNewOperation() {
        let old = CameraCaptureOperation()
        let current = CameraCaptureOperation()
        XCTAssertNotEqual(old.operationID, current.operationID)
        old.requestCancellation(timedOut: false)
        XCTAssertTrue(current.acceptsResults)
        XCTAssertNil(current.takeCompletion()?.cancellationCode)
    }

    func testConcurrentTerminationHasExactlyOneWinner() {
        let operation = CameraCaptureOperation()
        let lock = NSLock()
        var completions = 0
        DispatchQueue.concurrentPerform(iterations: 100) { index in
            if index.isMultiple(of: 2) { operation.requestCancellation(timedOut: false) }
            if operation.takeCompletion() != nil {
                lock.lock(); completions += 1; lock.unlock()
            }
        }
        XCTAssertEqual(completions, 1)
        XCTAssertFalse(operation.acceptsResults)
    }
}
