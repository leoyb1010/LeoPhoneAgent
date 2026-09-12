import Foundation

struct TorchState: Codable, Equatable, Sendable {
    let supported: Bool
    let available: Bool
    let enabled: Bool
    let level: Float
    let configuredOn: Bool
    let busy: Bool

    var metadata: [String: Any] {
        ["supported": supported, "available": available, "enabled": enabled,
         "level": level, "configured_on": configuredOn, "busy": busy]
    }
}

struct BrightnessState: Codable, Equatable, Sendable {
    let level: Double
    let canSet: Bool
    var metadata: [String: Any] { ["level": level, "can_set": canSet, "scope": "main_display"] }
}

struct DeviceActionError: Error, LocalizedError, Sendable {
    let code: String
    let message: String
    var torchState: TorchState? = nil
    var brightnessState: BrightnessState? = nil
    var errorDescription: String? { message }
    var metadata: [String: Any] {
        var result: [String: Any] = ["code": code, "message": message]
        if let torchState { result["observed_state"] = torchState.metadata }
        if let brightnessState { result["observed_state"] = brightnessState.metadata }
        return result
    }
}

// These boundaries allow real state/locking behavior to be tested without
// operating a physical device. Permissions belong to the shared entry gate.
@MainActor
protocol DeviceTorchHardware: AnyObject {
    var hasTorch: Bool { get }
    var available: Bool { get }
    var active: Bool { get }
    var level: Float { get }
    var configuredOn: Bool { get }
    func supports(enabled: Bool) -> Bool
    func lock() throws
    func unlock()
    func set(enabled: Bool, level: Float?) throws
}

@MainActor
protocol DeviceBrightnessHardware: AnyObject {
    var level: Double { get }
    var canSet: Bool { get }
    func set(level: Double)
}

/// The one hardware implementation used by CLI, native routes and home UI.
/// Callers authorize at W01's shared entry gate; this service never asks for
/// camera capture access just to change a torch or screen brightness.
@MainActor
final class DeviceActions {
    private let torchDevice: () -> (any DeviceTorchHardware)?
    private let brightnessDevice: any DeviceBrightnessHardware
    private let captureIsActive: () -> Bool
    private let onTorchState: (TorchState) -> Void
    private let verificationAttempts: Int
    private let verificationDelayNanoseconds: UInt64
    private var changingTorch = false
    private var changingBrightness = false

    init(torchDevice: @escaping () -> (any DeviceTorchHardware)?,
         brightnessDevice: any DeviceBrightnessHardware,
         captureIsActive: @escaping () -> Bool = { false },
         onTorchState: @escaping (TorchState) -> Void = { _ in },
         verificationAttempts: Int = 11,
         verificationDelayNanoseconds: UInt64 = 25_000_000) {
        self.torchDevice = torchDevice
        self.brightnessDevice = brightnessDevice
        self.captureIsActive = captureIsActive
        self.onTorchState = onTorchState
        self.verificationAttempts = max(1, verificationAttempts)
        self.verificationDelayNanoseconds = verificationDelayNanoseconds
    }

    func statusTorch() -> TorchState {
        publish(snapshot(torchDevice()))
    }

    func statusBrightness() -> BrightnessState {
        BrightnessState(level: brightnessDevice.level, canSet: brightnessDevice.canSet)
    }

    func setTorch(enabled: Bool, level: Float? = nil,
                  isCancelled: @escaping () -> Bool = { false }) async throws -> TorchState {
        if let level, !enabled || !level.isFinite || level <= 0 || level > 1 {
            throw DeviceActionError(code: "invalid_args", message: "手电筒强度必须在 0 到 1 之间且大于 0；关闭时不应传入强度。")
        }
        let device = torchDevice()
        var state = snapshot(device)
        try checkCancellation(isCancelled, torch: state)
        guard let device, state.supported, device.supports(enabled: enabled) else {
            throw DeviceActionError(code: "not_supported", message: "此设备没有可用的手电筒。", torchState: state)
        }
        if matches(state, enabled: enabled, level: level) { return publish(state) }
        // Turning off remains possible while a camera is active or the device
        // is hot; that is a release operation, not a new resource acquisition.
        guard !changingTorch, !enabled || !captureIsActive() else {
            throw DeviceActionError(code: "resource_busy", message: "相机或另一项手电筒操作正在使用此设备，请稍后重试。", torchState: state)
        }
        guard !enabled || state.available else {
            throw DeviceActionError(code: "temporarily_unavailable", message: "手电筒暂时不可用，设备可能需要降温。", torchState: state)
        }
        changingTorch = true
        defer { changingTorch = false }
        do {
            try device.lock()
            defer { device.unlock() }
            try device.set(enabled: enabled, level: level)
        } catch {
            state = publish(snapshot(device, includeCurrentOperation: false))
            throw DeviceActionError(code: "device_error", message: "系统未能设置手电筒：\(error.localizedDescription)", torchState: state)
        }
        // No configuration lock is held across suspension. Hardware can report
        // its state a moment after accepting the write; verify without blocking UI.
        for attempt in 0..<verificationAttempts {
            state = snapshot(device, includeCurrentOperation: false)
            try checkCancellation(isCancelled, torch: state)
            if matches(state, enabled: enabled, level: level) { return publish(state) }
            if attempt + 1 < verificationAttempts { try await pause(torch: state) }
        }
        state = publish(snapshot(device, includeCurrentOperation: false))
        throw DeviceActionError(code: "state_unconfirmed", message: "系统已收到手电筒请求，但当前状态尚未确认，请刷新查看。", torchState: state)
    }

    func setBrightness(_ level: Double,
                       isCancelled: @escaping () -> Bool = { false }) async throws -> BrightnessState {
        guard level.isFinite, (0...1).contains(level) else {
            throw DeviceActionError(code: "invalid_args", message: "屏幕亮度必须是 0 到 1 之间的有限数值。")
        }
        var state = statusBrightness()
        try checkCancellation(isCancelled, brightness: state)
        if abs(state.level - level) <= 0.005 { return state }
        guard !changingBrightness else {
            throw DeviceActionError(code: "resource_busy", message: "另一项亮度操作正在执行，请稍后重试。", brightnessState: state)
        }
        guard state.canSet else {
            throw DeviceActionError(code: "needs_foreground", message: "请在前台打开应用后调整屏幕亮度。", brightnessState: state)
        }
        changingBrightness = true
        defer { changingBrightness = false }
        brightnessDevice.set(level: level)
        for attempt in 0..<verificationAttempts {
            state = statusBrightness()
            try checkCancellation(isCancelled, brightness: state)
            if abs(state.level - level) <= 0.005 { return state }
            if attempt + 1 < verificationAttempts { try await pause(brightness: state) }
        }
        throw DeviceActionError(code: "state_unconfirmed", message: "系统已收到亮度请求，但当前亮度尚未确认，请刷新查看。", brightnessState: state)
    }

    private func snapshot(_ device: (any DeviceTorchHardware)?, includeCurrentOperation: Bool = true) -> TorchState {
        guard let device, device.hasTorch else {
            return .init(supported: false, available: false, enabled: false, level: 0, configuredOn: false, busy: captureIsActive())
        }
        return .init(supported: true, available: device.available, enabled: device.active,
                     level: device.level, configuredOn: device.configuredOn, busy: captureIsActive() || (includeCurrentOperation && changingTorch))
    }

    private func matches(_ state: TorchState, enabled: Bool, level: Float?) -> Bool {
        if !enabled { return !state.enabled && !state.configuredOn }
        return state.enabled && state.configuredOn && (level.map { abs(state.level - $0) <= 0.02 } ?? true)
    }

    @discardableResult
    private func publish(_ state: TorchState) -> TorchState { onTorchState(state); return state }

    private func checkCancellation(_ cancelled: () -> Bool,
                                   torch: TorchState? = nil, brightness: BrightnessState? = nil) throws {
        if Task.isCancelled || cancelled() {
            throw DeviceActionError(code: "cancelled", message: "设备操作的等待已取消；当前设备状态见回读结果。",
                                    torchState: torch, brightnessState: brightness)
        }
    }

    private func pause(torch: TorchState? = nil, brightness: BrightnessState? = nil) async throws {
        do { try await Task.sleep(nanoseconds: verificationDelayNanoseconds) }
        catch { throw DeviceActionError(code: "cancelled", message: "设备操作的等待已取消；请刷新当前设备状态。", torchState: torch, brightnessState: brightness) }
    }
}
