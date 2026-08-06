import XCTest

final class AgentActivityModelsTests: XCTestCase {
    func testSafeReasonCodesContainNoFreeText() throws {
        let event = AgentActivityEvent(
            runId: "run",
            sessionId: "session",
            kind: .phaseChanged,
            phase: .waitingForPermission,
            reason: .permissionApproval
        )

        let data = try JSONEncoder().encode(event)
        let encoded = try XCTUnwrap(String(data: data, encoding: .utf8))
        XCTAssertTrue(encoded.contains("permission_approval"))
        XCTAssertFalse(encoded.contains("prompt"))
    }

    func testActionableStateOutranksToolState() {
        let snapshot = AgentActivitySnapshot(
            isProcessing: true,
            isSuspended: true,
            canResume: true,
            toolName: "browser_use"
        )
        XCTAssertEqual(snapshot.phase, .waitingForUser)
    }

    func testSuspensionOutranksProcessing() {
        let snapshot = AgentActivitySnapshot(
            isProcessing: true,
            isSuspended: true,
            canResume: false,
            toolName: "browser_use"
        )
        XCTAssertEqual(snapshot.phase, .suspended)
    }

    func testToolAliasesSharePresentation() {
        XCTAssertEqual(
            AgentToolPresentation.symbol(for: "browser"),
            AgentToolPresentation.symbol(for: "browser_use")
        )
        XCTAssertEqual(
            AgentToolPresentation.displayName(for: "shell"),
            AgentToolPresentation.displayName(for: "shell_execute")
        )
    }

    func testTerminalPhaseContract() {
        XCTAssertTrue(AgentActivityPhase.completed.isTerminal)
        XCTAssertTrue(AgentActivityPhase.failed.isTerminal)
        XCTAssertTrue(AgentActivityPhase.cancelled.isTerminal)
        XCTAssertFalse(AgentActivityPhase.waitingForUser.isTerminal)
    }

    func testStopPolicyMakesQueueBehaviorExplicit() {
        XCTAssertTrue(AgentQueueStopPolicy.continueQueuedPrompts.shouldResumeQueue)
        XCTAssertFalse(AgentQueueStopPolicy.discardQueuedPrompts.shouldResumeQueue)
        XCTAssertNotEqual(
            AgentQueueStopPolicy.continueQueuedPrompts.rawValue,
            AgentQueueStopPolicy.discardQueuedPrompts.rawValue
        )
    }

    func testProcessingTransitionOnlyFiresOnBooleanEdges() {
        XCTAssertEqual(
            AgentProcessingTransition(previous: false, current: true),
            .started
        )
        XCTAssertEqual(
            AgentProcessingTransition(previous: true, current: false),
            .stopped
        )
        XCTAssertEqual(
            AgentProcessingTransition(previous: false, current: false),
            .unchanged
        )
        XCTAssertEqual(
            AgentProcessingTransition(previous: true, current: true),
            .unchanged
        )
    }

    func testFailureClassifierProducesStableSafeReasons() {
        XCTAssertEqual(
            AgentActivityFailureClassifier.reason(for: "401 invalid API key sk-secret-value"),
            .authenticationRequired
        )
        XCTAssertEqual(
            AgentActivityFailureClassifier.reason(for: "HTTP 429 rate limit exceeded"),
            .rateLimited
        )
        XCTAssertEqual(
            AgentActivityFailureClassifier.reason(for: "network connection timed out"),
            .connectionDropped
        )
        XCTAssertEqual(
            AgentActivityFailureClassifier.reason(for: "Kernel boot failed"),
            .kernelUnavailable
        )
    }

    func testRecoveryActionMatchesFailureReason() {
        XCTAssertEqual(
            AgentActivityFailureClassifier.recoveryAction(for: .authenticationRequired),
            .reviewProvider
        )
        XCTAssertEqual(
            AgentActivityFailureClassifier.recoveryAction(for: .kernelUnavailable),
            .retryKernel
        )
        XCTAssertEqual(
            AgentActivityFailureClassifier.recoveryAction(for: .connectionDropped),
            .retry
        )
        XCTAssertEqual(
            AgentActivityFailureClassifier.recoveryAction(for: .userInterruption),
            .resume
        )
        XCTAssertEqual(
            AgentActivityFailureClassifier.recoveryAction(for: .unexpectedTermination),
            .resume
        )
    }

    func testUnexpectedTerminationMakesNonterminalRunResumable() {
        let started = Date(timeIntervalSince1970: 100)
        let recoveredAt = Date(timeIntervalSince1970: 200)
        let running = AgentRunState(
            runId: "run",
            sessionId: "session",
            startedAt: started,
            updatedAt: started,
            phase: .thinking,
            toolName: "thinking",
            reason: nil
        )

        let recovered = running.recoveringAfterUnexpectedTermination(at: recoveredAt)

        XCTAssertEqual(recovered.phase, .waitingForUser)
        XCTAssertEqual(recovered.reason, .unexpectedTermination)
        XCTAssertEqual(recovered.startedAt, started)
        XCTAssertEqual(recovered.updatedAt, recoveredAt)
        XCTAssertTrue(recovered.isResumable)
    }

    func testTerminalRunIsNotReopenedByRecovery() {
        let completed = AgentRunState(
            runId: "run",
            sessionId: "session",
            startedAt: Date(timeIntervalSince1970: 100),
            updatedAt: Date(timeIntervalSince1970: 200),
            phase: .completed,
            toolName: nil,
            reason: nil
        )

        XCTAssertEqual(
            completed.recoveringAfterUnexpectedTermination(at: Date(timeIntervalSince1970: 300)),
            completed
        )
    }
}
