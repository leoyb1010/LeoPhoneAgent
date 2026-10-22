import XCTest

/// [G2] 首启新手引导的出现条件:没模型、没完成过、不跟「本次更新」抢。
final class OnboardingGateTests: XCTestCase {

    private func defaults() -> UserDefaults {
        UserDefaults(suiteName: "OnboardingGateTests-\(UUID().uuidString)")!
    }

    func testPresentsOnlyOnFreshInstallWithoutModel() {
        XCTAssertTrue(OnboardingGate.shouldPresent(hasModel: false, completed: false, releaseNotesPending: false))
        XCTAssertFalse(OnboardingGate.shouldPresent(hasModel: true, completed: false, releaseNotesPending: false))
        XCTAssertFalse(OnboardingGate.shouldPresent(hasModel: false, completed: true, releaseNotesPending: false))
        XCTAssertFalse(OnboardingGate.shouldPresent(hasModel: false, completed: false, releaseNotesPending: true))
    }

    func testModelConfiguredMarksCompleted() {
        XCTAssertTrue(OnboardingGate.shouldMarkCompleted(hasModel: true))
        XCTAssertFalse(OnboardingGate.shouldMarkCompleted(hasModel: false))
    }

    func testCompletionPersists() {
        let d = defaults()
        XCTAssertFalse(OnboardingGate.isCompleted(d))
        OnboardingGate.markCompleted(d)
        XCTAssertTrue(OnboardingGate.isCompleted(d))
    }

    func testStepsAndDebugStart() {
        XCTAssertEqual(OnboardingGate.Step.allCases.count, 3)
        XCTAssertEqual(OnboardingGate.next(after: .model), .mac)
        XCTAssertEqual(OnboardingGate.next(after: .mac), .firstTask)
        XCTAssertNil(OnboardingGate.next(after: .firstTask))

        let d = defaults()
        XCTAssertEqual(OnboardingGate.initialStep(d), .model)
        d.set(2, forKey: OnboardingGate.debugStepKey)
        XCTAssertEqual(OnboardingGate.initialStep(d), .firstTask)
        d.set(9, forKey: OnboardingGate.debugStepKey)
        XCTAssertEqual(OnboardingGate.initialStep(d), .model)
        XCTAssertFalse(OnboardingGate.isForced(d))
        d.set(true, forKey: OnboardingGate.forceKey)
        XCTAssertTrue(OnboardingGate.isForced(d))
    }
}
