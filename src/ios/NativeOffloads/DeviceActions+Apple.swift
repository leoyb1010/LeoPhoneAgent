import Foundation
import AVFoundation
import UIKit

@MainActor
private final class AppleTorchHardware: DeviceTorchHardware {
    private let device: AVCaptureDevice
    private static var retained: AppleTorchHardware?
    init(_ device: AVCaptureDevice) { self.device = device }
    static func current() -> AppleTorchHardware? {
        if let retained { return retained }
        let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
            ?? AVCaptureDevice.default(for: .video)
        retained = device.map(AppleTorchHardware.init)
        return retained
    }
    var hasTorch: Bool { device.hasTorch }
    var available: Bool { device.isTorchAvailable }
    var active: Bool { device.isTorchActive }
    var level: Float { device.torchLevel }
    var configuredOn: Bool { device.torchMode == .on }
    func supports(enabled: Bool) -> Bool { device.isTorchModeSupported(enabled ? .on : .off) }
    func lock() throws { try device.lockForConfiguration() }
    func unlock() { device.unlockForConfiguration() }
    func set(enabled: Bool, level: Float?) throws {
        if enabled { try device.setTorchModeOn(level: level ?? AVCaptureDevice.maxAvailableTorchLevel) }
        else { device.torchMode = .off }
    }
}

@MainActor
private final class AppleBrightnessHardware: DeviceBrightnessHardware {
    var level: Double { Double(UIScreen.main.brightness) }
    var canSet: Bool { UIApplication.shared.applicationState == .active }
    func set(level: Double) { UIScreen.main.brightness = CGFloat(level) }
}

extension DeviceActions {
    static let shared = DeviceActions(
        torchDevice: {
            // No capture input/session is created and no audio/video is read.
            // A flashlight must not proactively request camera recording access.
            return AppleTorchHardware.current()
        },
        brightnessDevice: AppleBrightnessHardware(),
        captureIsActive: { CameraOffloadBridge.hasActiveCapture },
        onTorchState: { UserDefaults.standard.set($0.enabled, forKey: "leo.torchOn") }
    )
}

@objc final class DeviceActionRequest: NSObject, @unchecked Sendable {
    @objc let operationID = UUID().uuidString
    private let lock = NSLock()
    private var cancelled = false
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
    @objc func cancel() { lock.lock(); cancelled = true; lock.unlock() }
}

/// The apple-device handler has passed W01's fixed-identity permission proxy.
/// Direct Swift routes authorize at that same gate before calling shared.
@objc final class DeviceActionsBridge: NSObject {
    @objc(performAction:enabled:level:completion:)
    static func perform(action: String, enabled: NSNumber?, level: NSNumber?,
                        completion: @escaping (NSDictionary?, NSError?) -> Void) -> DeviceActionRequest {
        let request = DeviceActionRequest()
        Task { @MainActor in
            do {
                guard !request.isCancelled else {
                    throw DeviceActionError(code: "cancelled", message: "设备操作已取消，未执行。")
                }
                var data: [String: Any]
                switch action {
                case "torch":
                    let state: TorchState
                    if let enabled {
                        state = try await DeviceActions.shared.setTorch(enabled: enabled.boolValue,
                            level: level?.floatValue, isCancelled: { request.isCancelled })
                    } else { state = DeviceActions.shared.statusTorch() }
                    data = state.metadata
                case "brightness":
                    let state: BrightnessState
                    if let level {
                        state = try await DeviceActions.shared.setBrightness(level.doubleValue,
                            isCancelled: { request.isCancelled })
                    } else { state = DeviceActions.shared.statusBrightness() }
                    data = state.metadata
                default: throw DeviceActionError(code: "invalid_args", message: "未知设备动作。")
                }
                data["operation_id"] = request.operationID
                completion(data as NSDictionary, nil)
            } catch {
                let failure = (error as? DeviceActionError)
                    ?? DeviceActionError(code: "device_error", message: error.localizedDescription)
                var details = failure.metadata
                details[NSLocalizedDescriptionKey] = failure.message
                details["operation_id"] = request.operationID
                completion(nil, NSError(domain: "LeoPhoneAgent.Device", code: 1, userInfo: details))
            }
        }
        return request
    }
}
