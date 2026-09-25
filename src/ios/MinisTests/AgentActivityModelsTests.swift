import XCTest

final class AgentActivityModelsTests: XCTestCase {
    func testCompactionHandoffKeepsTheOriginalRunOpenUntilQueuedPromptFinishes() {
        let handoff = AgentRunCompletion(userCancelled: false, canResume: false,
            backgroundSuspended: false, failureText: nil, continuesPendingWork: true)
        XCTAssertEqual(handoff.phase, .preparing)
        XCTAssertTrue(handoff.keepsRunActive)
        let cancelled = AgentRunCompletion(userCancelled: true, canResume: false,
            backgroundSuspended: false, failureText: nil, continuesPendingWork: true)
        XCTAssertEqual(cancelled.phase, .cancelled)
        XCTAssertFalse(cancelled.keepsRunActive)
    }

    func testUnverifiedNativeActionDoesNotPretendSuccessOrOfferAutomaticResume() {
        let completion = AgentRunCompletion(userCancelled: false, canResume: false,
            backgroundSuspended: false, failureText: nil, nativeOutcome: .unknown)
        XCTAssertEqual(completion.phase, .unverified)
        XCTAssertTrue(completion.phase.isTerminal)
        let state = AgentRunState(runId: "run", sessionId: "s", startedAt: .now,
            updatedAt: .now, phase: completion.phase, toolName: nil, reason: completion.reason)
        XCTAssertFalse(state.isResumable)
        XCTAssertFalse(state.needsUnexpectedTerminationRecovery)
        XCTAssertEqual(AgentRunOutcome(state: state, expectedRunId: "run"), .unknown)
    }

    func testRunOutcomeUsesDurablePhaseRatherThanReplyPresence() {
        for (phase, expected) in [
            (AgentActivityPhase.completed, AgentRunOutcome.succeeded),
            (.failed, .failed), (.cancelled, .cancelled),
            (.thinking, .running), (.suspended, .suspended),
            (.waitingForUser, .waitingForUser),
            (.waitingForPermission, .awaitingApproval),
        ] {
            let state = AgentRunState(runId: "run", sessionId: "session",
                                      startedAt: .distantPast, updatedAt: .now,
                                      phase: phase, toolName: nil, reason: nil)
            XCTAssertEqual(AgentRunOutcome(state: state, expectedRunId: "run"), expected)
        }
    }

    func testOldOrMissingRunCannotReportSuccess() {
        let old = AgentRunState(runId: "old", sessionId: "session",
                                startedAt: .distantPast, updatedAt: .now,
                                phase: .completed, toolName: nil, reason: nil)
        XCTAssertEqual(AgentRunOutcome(state: old, expectedRunId: "new"), .unknown)
        XCTAssertEqual(AgentRunOutcome(state: nil, expectedRunId: "new"), .unknown)
    }

    func testUserCancelWinsBeforeDelayedCleanupMarksResumable() {
        let completion = AgentRunCompletion(userCancelled: true, canResume: false,
                                             backgroundSuspended: false, failureText: nil)
        XCTAssertEqual(completion.phase, .cancelled)
        XCTAssertEqual(completion.reason, .userInterruption)
    }

    func testBackgroundExpirationAndErrorRemainDistinctFromSuccess() {
        XCTAssertEqual(AgentRunCompletion(userCancelled: false, canResume: false,
                                          backgroundSuspended: true, failureText: nil).phase,
                       .suspended)
        XCTAssertEqual(AgentRunCompletion(userCancelled: false, canResume: false,
                                          backgroundSuspended: false, failureText: "network timeout").phase,
                       .failed)
        XCTAssertFalse(AgentRunOutcome.running.isTerminal)
        XCTAssertFalse(AgentRunOutcome.unknown.canPublishBriefing)
        XCTAssertFalse(AgentRunOutcome.failed.canPublishBriefing)
        XCTAssertTrue(AgentRunOutcome.succeeded.canPublishBriefing)
    }

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

    // MARK: - Background run progress

    /// A stalled value lets the system expire the task and show "failed";
    /// reaching the end would claim the run finished.
    func testContinuedProcessingProgressAlwaysMovesAndNeverFinishes() {
        var value: Int64 = 0
        for event in 1...5_000 {
            let next = ContinuedProcessingProgress.next(after: value, events: event)
            XCTAssertGreaterThan(next, value, "event \(event)")
            XCTAssertLessThan(next, ContinuedProcessingProgress.scale, "event \(event)")
            value = next
        }
    }

    // MARK: - Live Activity resting outcome

    /// A Live Activity started by the previous build carries no `outcome`;
    /// it must still decode (as a plain completion), and the new field must
    /// round-trip.
    func testLiveSessionSnapshotDecodesPayloadWithoutOutcome() throws {
        let old = #"{"sessionId":"s1","title":"T","toolIcon":"terminal","toolStatus":"Running","loopIteration":2,"isCompleted":true,"lastMessage":"hi"}"#
        let snapshot = try JSONDecoder().decode(LiveSessionSnapshot.self, from: Data(old.utf8))
        XCTAssertEqual(snapshot.outcome, .done)
        XCTAssertEqual(snapshot.lastMessage, "hi")

        var attention = snapshot
        attention.outcome = .attention
        let decoded = try JSONDecoder().decode(LiveSessionSnapshot.self, from: JSONEncoder().encode(attention))
        XCTAssertEqual(decoded.outcome, .attention)
    }
}
