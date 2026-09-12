import XCTest

final class SystemSpeechPolicyTests: XCTestCase {
    private let missing = SystemSpeechAvailability(requestedLocale: "xx", resolvedLocale: "xx", state: .notInstalled)
    private let installed = SystemSpeechAvailability(requestedLocale: "en", resolvedLocale: "en-US", state: .installed)

    func testExplicitOfflineNeverDegradesToNetworkWhenLocalUnsupported() {
        XCTAssertThrowsError(try SystemSpeechPolicy.choose(mode: .offline, automaticNetworkAllowed: true,
            assets: missing, legacyAvailable: true, legacySupportsOnDevice: false, legacyAuthorized: true)) { error in
                XCTAssertEqual(error as? SystemSpeechError, .assetsMissing("xx"))
            }
    }

    func testOfflineModelCannotBeWeakenedByConflictingFlag() {
        XCTAssertEqual(SystemSpeechPolicy.mode(onDevice: false, modelID: "system-asr-offline"), .offline)
        XCTAssertEqual(SystemSpeechPolicy.mode(onDevice: true, modelID: "system-asr-online"), .offline)
    }

    func testAutomaticNetworkRequiresExplicitPreference() throws {
        XCTAssertThrowsError(try SystemSpeechPolicy.choose(mode: .automatic, automaticNetworkAllowed: false,
            assets: missing, legacyAvailable: true, legacySupportsOnDevice: false, legacyAuthorized: true))
        XCTAssertEqual(try SystemSpeechPolicy.choose(mode: .automatic, automaticNetworkAllowed: true,
            assets: missing, legacyAvailable: true, legacySupportsOnDevice: false, legacyAuthorized: true), .legacy(requiresOnDevice: false))
    }

    func testInstalledAnalyzerWinsEvenWhenNetworkIsAllowedAndLegacyAuthorizationDenied() throws {
        XCTAssertEqual(try SystemSpeechPolicy.choose(mode: .networkAllowed, automaticNetworkAllowed: true,
            assets: installed, legacyAvailable: false, legacySupportsOnDevice: false, legacyAuthorized: false), .analyzer(locale: "en-US"))
    }

    func testLegacyLocalRouteAlwaysRequiresOnDevice() throws {
        for mode in [SystemSpeechMode.offline, .automatic, .networkAllowed] {
            XCTAssertEqual(try SystemSpeechPolicy.choose(mode: mode, automaticNetworkAllowed: true,
                assets: missing, legacyAvailable: true, legacySupportsOnDevice: true, legacyAuthorized: true), .legacy(requiresOnDevice: true))
        }
    }

    func testLegacyPermissionAndMissingAssetReasonsStayDistinct() {
        XCTAssertThrowsError(try SystemSpeechPolicy.choose(mode: .offline, automaticNetworkAllowed: false,
            assets: missing, legacyAvailable: true, legacySupportsOnDevice: true, legacyAuthorized: false)) { error in
                XCTAssertEqual(error as? SystemSpeechError, .legacyPermissionRequired)
            }
        let downloading = SystemSpeechAvailability(requestedLocale: "en", resolvedLocale: "en-US", state: .downloading)
        XCTAssertThrowsError(try SystemSpeechPolicy.choose(mode: .offline, automaticNetworkAllowed: false,
            assets: downloading, legacyAvailable: true, legacySupportsOnDevice: false, legacyAuthorized: true)) { error in
                XCTAssertEqual(error as? SystemSpeechError, .assetsDownloading("en-US"))
            }
    }

    func testResourceInstallRequiresUserActionAndTimeoutIsBounded() {
        XCTAssertThrowsError(try SystemSpeechPolicy.requireExplicitInstallation(false))
        XCTAssertNoThrow(try SystemSpeechPolicy.requireExplicitInstallation(true))
        XCTAssertEqual(SystemSpeechPolicy.timeout(audioDuration: 0.1), 8)
        XCTAssertEqual(SystemSpeechPolicy.timeout(audioDuration: 1000), 90)
        XCTAssertEqual(SystemSpeechPolicy.timeout(audioDuration: .nan), 15)
    }
}

final class SpeechRequestLifetimeTests: XCTestCase {
    func testTimeoutResolvesEvenIfFrameworkNeverCallsBack() async {
        let lifetime = SpeechRequestLifetime<String>()
        do { _ = try await lifetime.value(timeoutSeconds: 0.001) { _ in }; XCTFail("Expected timeout") }
        catch { XCTAssertEqual(error as? SystemSpeechError, .timedOut) }
        XCTAssertTrue(lifetime.isFinished)
        XCTAssertFalse(lifetime.finish(.success("late")))
    }

    func testCancellationRequestsCleanupAndRejectsLateResult() async {
        let lifetime = SpeechRequestLifetime<String>()
        let cleanup = expectation(description: "cleanup")
        let started = expectation(description: "started")
        let task = Task {
            try await lifetime.value(timeoutSeconds: 30) { request in
                request.onFinish { cleanup.fulfill() }
                started.fulfill()
            }
        }
        await fulfillment(of: [started], timeout: 1)
        task.cancel()
        do { _ = try await task.value; XCTFail("Expected cancellation") }
        catch { XCTAssertTrue(error is CancellationError) }
        await fulfillment(of: [cleanup], timeout: 1)
        XCTAssertFalse(lifetime.finish(.success("late")))
    }

    func testCleanupRegisteredAfterSynchronousResultStillRuns() async throws {
        let lifetime = SpeechRequestLifetime<String>()
        let cleanup = expectation(description: "late attachment cancelled")
        let text = try await lifetime.value(timeoutSeconds: 1) { request in
            request.finish(.success("done"))
            request.onFinish { cleanup.fulfill() }
        }
        XCTAssertEqual(text, "done")
        await fulfillment(of: [cleanup], timeout: 1)
    }

    func testTimeoutCanPreservePartialTextWithoutMarkingItFinal() async throws {
        let lifetime = SpeechRequestLifetime<SystemSpeechTranscript>()
        let partial = SystemSpeechTranscript(text: "partial", duration: nil,
            execution: .init(engine: .legacyOnDevice, location: .onDevice, locale: "en", isFinal: false, note: "timeout"))
        let result = try await lifetime.value(timeoutSeconds: 0.001, onTimeout: { .success(partial) }) { _ in }
        XCTAssertEqual(result.text, "partial")
        XCTAssertFalse(result.execution.isFinal)
    }
}
