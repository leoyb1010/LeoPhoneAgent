import XCTest

@MainActor
private final class FakeTorchHardware: DeviceTorchHardware {
    var hasTorch = true
    var available = true
    var active = false
    var level: Float = 0
    var configuredOn = false
    var failLock = false
    var failSet = false
    var ignoreWrite = false
    var lockCount = 0
    var unlockCount = 0
    var writeCount = 0
    func supports(enabled: Bool) -> Bool { hasTorch }
    func lock() throws {
        if failLock { throw NSError(domain: "lock", code: 1) }
        lockCount += 1
    }
    func unlock() { unlockCount += 1 }
    func set(enabled: Bool, level: Float?) throws {
        writeCount += 1
        if failSet { throw NSError(domain: "set", code: 1) }
        guard !ignoreWrite else { return }
        active = enabled; configuredOn = enabled; self.level = enabled ? (level ?? 1) : 0
    }
}

@MainActor
private final class FakeBrightnessHardware: DeviceBrightnessHardware {
    var level: Double = 0.5
    var canSet = true
    var ignoreWrite = false
    var writes = 0
    func set(level: Double) { writes += 1; if !ignoreWrite { self.level = level } }
}

@MainActor
final class DeviceActionsTests: XCTestCase {
    private func service(torch: FakeTorchHardware?, brightness: FakeBrightnessHardware? = nil,
                         capturing: Bool = false) -> DeviceActions {
        DeviceActions(torchDevice: { torch }, brightnessDevice: brightness ?? FakeBrightnessHardware(),
                      captureIsActive: { capturing }, verificationAttempts: 2, verificationDelayNanoseconds: 0)
    }

    func testTorchConfigurationLockIsReleasedWhenSettingThrows() async {
        let torch = FakeTorchHardware(); torch.failSet = true
        do { _ = try await service(torch: torch).setTorch(enabled: true); XCTFail("Expected failure") }
        catch { XCTAssertEqual((error as? DeviceActionError)?.code, "device_error") }
        XCTAssertEqual(torch.lockCount, 1)
        XCTAssertEqual(torch.unlockCount, 1)
    }

    func testFailedLockIsNeverUnlocked() async {
        let torch = FakeTorchHardware(); torch.failLock = true
        do { _ = try await service(torch: torch).setTorch(enabled: true); XCTFail("Expected failure") } catch {}
        XCTAssertEqual(torch.writeCount, 0)
        XCTAssertEqual(torch.unlockCount, 0)
    }

    func testRepeatedSetIsIdempotentAndPreservesExistingLevel() async throws {
        let torch = FakeTorchHardware()
        let actions = service(torch: torch)
        let initial = try await actions.setTorch(enabled: true, level: 0.4)
        let repeated = try await actions.setTorch(enabled: true)
        XCTAssertTrue(initial.enabled)
        XCTAssertEqual(repeated.level, 0.4)
        XCTAssertEqual(torch.writeCount, 1)
        _ = try await actions.setTorch(enabled: false)
        _ = try await actions.setTorch(enabled: false)
        XCTAssertEqual(torch.writeCount, 2)
        XCTAssertEqual(torch.lockCount, torch.unlockCount)
    }

    func testUnsupportedTorchIsReportedWithoutHardwareCall() async {
        let actions = service(torch: nil)
        XCTAssertFalse(actions.statusTorch().supported)
        do { _ = try await actions.setTorch(enabled: true); XCTFail("Expected unsupported") }
        catch { XCTAssertEqual((error as? DeviceActionError)?.code, "not_supported") }
    }

    func testHotOrCapturingDeviceCannotTurnOnButCanTurnOff() async throws {
        let torch = FakeTorchHardware(); torch.available = false
        let actions = service(torch: torch)
        do { _ = try await actions.setTorch(enabled: true); XCTFail("Expected unavailable") }
        catch { XCTAssertEqual((error as? DeviceActionError)?.code, "temporarily_unavailable") }
        XCTAssertEqual(torch.writeCount, 0)
        torch.active = true; torch.configuredOn = true; torch.level = 0.5
        let off = try await service(torch: torch, capturing: true).setTorch(enabled: false)
        XCTAssertFalse(off.enabled)
    }

    func testCameraOwnershipRejectsNewTorchAcquisition() async {
        let torch = FakeTorchHardware()
        do { _ = try await service(torch: torch, capturing: true).setTorch(enabled: true); XCTFail("Expected busy") }
        catch { XCTAssertEqual((error as? DeviceActionError)?.code, "resource_busy") }
        XCTAssertEqual(torch.writeCount, 0)
    }

    func testInvalidTorchLevelNeverReachesDriver() async {
        let torch = FakeTorchHardware()
        let actions = service(torch: torch)
        for level: Float in [.nan, .infinity, -.infinity, -1, 0, 1.1] {
            do { _ = try await actions.setTorch(enabled: true, level: level); XCTFail("Expected invalid input") }
            catch { XCTAssertEqual((error as? DeviceActionError)?.code, "invalid_args") }
        }
        XCTAssertEqual(torch.lockCount, 0)
        XCTAssertEqual(torch.writeCount, 0)
    }

    func testMissingReadbackReturnsUnknownStateInsteadOfSuccess() async {
        let torch = FakeTorchHardware(); torch.ignoreWrite = true
        do { _ = try await service(torch: torch).setTorch(enabled: true); XCTFail("Expected unconfirmed") }
        catch {
            let failure = error as? DeviceActionError
            XCTAssertEqual(failure?.code, "state_unconfirmed")
            XCTAssertEqual(failure?.torchState?.enabled, false)
        }
        XCTAssertEqual(torch.unlockCount, 1)
    }

    func testCancellationBeforeApplyCannotChangeHardware() async {
        let torch = FakeTorchHardware()
        do { _ = try await service(torch: torch).setTorch(enabled: true, isCancelled: { true }); XCTFail("Expected cancelled") }
        catch { XCTAssertEqual((error as? DeviceActionError)?.code, "cancelled") }
        XCTAssertEqual(torch.writeCount, 0)
    }

    func testCancellationAfterApplyKeepsObservedStateAndUnlocks() async {
        let torch = FakeTorchHardware()
        do {
            _ = try await service(torch: torch).setTorch(enabled: true, isCancelled: { torch.writeCount > 0 })
            XCTFail("Expected cancelled")
        } catch {
            XCTAssertEqual((error as? DeviceActionError)?.code, "cancelled")
            XCTAssertEqual((error as? DeviceActionError)?.torchState?.enabled, true)
        }
        XCTAssertEqual(torch.unlockCount, 1)
    }

    func testBrightnessSetReadbackAndIdempotence() async throws {
        let brightness = FakeBrightnessHardware()
        let actions = service(torch: nil, brightness: brightness)
        let state = try await actions.setBrightness(0.7)
        _ = try await actions.setBrightness(0.7)
        XCTAssertEqual(state.level, 0.7)
        XCTAssertEqual(brightness.writes, 1)
    }

    func testBrightnessRejectsInvalidAndUnavailableWrites() async {
        let brightness = FakeBrightnessHardware()
        let actions = service(torch: nil, brightness: brightness)
        for level in [Double.nan, .infinity, -0.1, 1.1] {
            do { _ = try await actions.setBrightness(level); XCTFail("Expected invalid") }
            catch { XCTAssertEqual((error as? DeviceActionError)?.code, "invalid_args") }
        }
        brightness.canSet = false
        do { _ = try await actions.setBrightness(0.7); XCTFail("Expected foreground requirement") }
        catch { XCTAssertEqual((error as? DeviceActionError)?.code, "needs_foreground") }
        XCTAssertEqual(brightness.writes, 0)
    }

    func testBrightnessReadbackMismatchIsNotSuccess() async {
        let brightness = FakeBrightnessHardware(); brightness.ignoreWrite = true
        do { _ = try await service(torch: nil, brightness: brightness).setBrightness(0.8); XCTFail("Expected unconfirmed") }
        catch {
            XCTAssertEqual((error as? DeviceActionError)?.code, "state_unconfirmed")
            XCTAssertEqual((error as? DeviceActionError)?.brightnessState?.level, 0.5)
        }
    }
}
