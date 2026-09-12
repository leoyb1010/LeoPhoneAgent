// Native camera operations always present a user-operated system UI.
import Foundation
import AVFoundation
import UIKit
import VisionKit

private let logger = AppLogger(category: "CameraOffloadBridge")

@MainActor @objc public class CameraOffloadBridge: NSObject {
    private final class CaptureSession {
        let operation: CameraCaptureOperation
        let completion: (NSDictionary?, NSError?) -> Void
        var controller: UIViewController?
        var scanner: DataScannerViewController?
        var delegate: NSObject?
        var backgroundObserver: NSObjectProtocol?
        var timeout: Task<Void, Never>?
        var writtenFiles: [URL] = []

        init(operation: CameraCaptureOperation, completion: @escaping (NSDictionary?, NSError?) -> Void) {
            self.operation = operation
            self.completion = completion
        }
    }
    private static var active: CaptureSession?
    static var hasActiveCapture: Bool { active != nil }

    private static func failure(_ code: String, _ message: String) -> NSError {
        NSError(domain: "LeoPhoneAgent.Camera", code: 1,
                userInfo: [NSLocalizedDescriptionKey: message, "code": code])
    }

    private static func cancellationError(_ code: String) -> NSError {
        failure(code, code == "timed_out" ? "Camera capture timed out." : "The camera operation was cancelled.")
    }

    private static func begin(_ operation: CameraCaptureOperation,
                              completion: @escaping (NSDictionary?, NSError?) -> Void) -> Bool {
        let error: NSError?
        if !operation.acceptsResults { error = cancellationError("cancelled") }
        else if UIApplication.shared.applicationState != .active {
            error = failure("needs_foreground", "Open LeoPhoneAgent in the foreground, then retry the camera.")
        } else if active != nil {
            error = failure("camera_busy", "Another camera operation is open. Finish or cancel it first.")
        } else { error = nil }
        if let error {
            if let claim = operation.takeCompletion() {
                completion(nil, claim.cancellationCode.map(cancellationError) ?? error)
            }
            return false
        }
        // Reserve while waiting for TCC too: concurrent first-use requests
        // must not both present a camera after the same permission callback.
        let session = CaptureSession(operation: operation, completion: completion)
        active = session
        session.backgroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { _ in
            MainActor.assumeIsolated { cancelOperation(operation) }
        }
        session.timeout = Task { @MainActor in
            do { try await Task.sleep(nanoseconds: 300_000_000_000) }
            catch { return }
            operation.requestCancellation(timedOut: true)
            cancelOperation(operation)
        }
        return true
    }

    private static func isCurrent(_ operation: CameraCaptureOperation) -> Bool {
        active?.operation.operationID == operation.operationID && operation.acceptsResults
    }

    /// Cancels only this operation. A late cancellation from an old tool can
    /// never dismiss a newer camera or clear its busy state.
    @objc(cancelOperation:)
    public static func cancelOperation(_ operation: CameraCaptureOperation) {
        operation.requestCancellation(timedOut: false)
        finish(operation, data: nil, error: cancellationError("cancelled"))
    }

    private static func finish(_ operation: CameraCaptureOperation,
                               data: NSDictionary?, error: NSError?) {
        guard let session = active, session.operation.operationID == operation.operationID,
              let claim = operation.takeCompletion() else { return }
        let finalError = claim.cancellationCode.map(cancellationError) ?? error
        active = nil
        session.timeout?.cancel()
        if let observer = session.backgroundObserver { NotificationCenter.default.removeObserver(observer) }
        session.scanner?.stopScanning()
        session.scanner?.delegate = nil
        (session.controller as? UIImagePickerController)?.delegate = nil
        (session.controller as? VNDocumentCameraViewController)?.delegate = nil
        session.controller?.dismiss(animated: false)
        session.delegate = nil
        if finalError != nil {
            // Every path was produced under this operation's UUID. Never
            // delete a previous capture or unrelated files on cancellation.
            for file in session.writtenFiles { try? FileManager.default.removeItem(at: file) }
            session.completion(nil, finalError)
        } else {
            let result = (data?.mutableCopy() as? NSMutableDictionary) ?? NSMutableDictionary()
            result["operation_id"] = operation.operationID
            session.completion(result, nil)
        }
    }

    private static func ensureCameraAuth(_ operation: CameraCaptureOperation,
                                         completion: @escaping () -> Void) {
        let deliver: (Bool) -> Void = { granted in
            guard isCurrent(operation) else { cancelOperation(operation); return }
            if granted { completion() }
            else {
                finish(operation, data: nil, error: failure("authorization_denied",
                    "Camera access is not granted. Enable it in 设置 → 隐私与安全性 → 相机 → LeoPhoneAgent."))
            }
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: deliver(true)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                Task { @MainActor in deliver(granted) }
            }
        default: deliver(false)
        }
    }

    // The preceding application permission sheet may still be dismissing.
    // Wait briefly for a stable presenter, without blocking MainActor or
    // presenting on a sheet that is about to disappear.
    private static func withPresenter(_ operation: CameraCaptureOperation,
                                      perform: @escaping (UIViewController, CaptureSession) -> Void) {
        Task { @MainActor in
            for _ in 0..<30 {
                guard isCurrent(operation), let session = active else { cancelOperation(operation); return }
                guard UIApplication.shared.applicationState == .active else {
                    finish(operation, data: nil, error: failure("needs_foreground", "Open LeoPhoneAgent to use the camera."))
                    return
                }
                if let top = topViewController(), top.viewIfLoaded?.window != nil,
                   !top.isBeingDismissed, !top.isBeingPresented {
                    perform(top, session)
                    return
                }
                do { try await Task.sleep(nanoseconds: 50_000_000) }
                catch { cancelOperation(operation); return }
            }
            finish(operation, data: nil, error: failure("camera_busy", "The camera could not be presented. Finish the current sheet and retry."))
        }
    }

    @objc(authStatus)
    public static func authStatus() -> NSString {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not_determined"
        @unknown default: return "unknown"
        }
    }

    @objc(takePhotoWithOperation:camera:hostDir:guestDir:completion:)
    public static func takePhoto(operation: CameraCaptureOperation, camera: String,
                                 hostDir: String, guestDir: String,
                                 completion: @escaping (NSDictionary?, NSError?) -> Void) {
        guard begin(operation, completion: completion) else { return }
        guard camera == "front" || camera == "back" else {
            finish(operation, data: nil, error: failure("invalid_args", "Camera must be front or back.")); return
        }
        let cameraDevice: UIImagePickerController.CameraDevice = camera == "front" ? .front : .rear
        guard UIImagePickerController.isSourceTypeAvailable(.camera),
              UIImagePickerController.isCameraDeviceAvailable(cameraDevice) else {
            finish(operation, data: nil, error: failure("not_available", "The requested camera is unavailable.")); return
        }
        ensureCameraAuth(operation) {
            withPresenter(operation) { top, session in
                let delegate = PhotoCaptureDelegate(operation: operation, hostDir: hostDir, guestDir: guestDir)
                let picker = UIImagePickerController()
                picker.sourceType = .camera
                picker.cameraDevice = cameraDevice
                picker.delegate = delegate
                session.delegate = delegate
                session.controller = picker
                top.present(picker, animated: true)
            }
        }
    }

    @MainActor
    private final class PhotoCaptureDelegate: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let operation: CameraCaptureOperation
        let hostDir: String
        let guestDir: String
        init(operation: CameraCaptureOperation, hostDir: String, guestDir: String) {
            self.operation = operation; self.hostDir = hostDir; self.guestDir = guestDir
        }
        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            guard isCurrent(operation) else { cancelOperation(operation); return }
            guard let image = info[.originalImage] as? UIImage,
                  let jpeg = image.jpegData(compressionQuality: 0.9) else {
                finish(operation, data: nil, error: failure("capture_failed", "Failed to read the captured photo.")); return
            }
            do {
                let name = "camera-\(operation.operationID).jpg"
                let file = URL(fileURLWithPath: hostDir).appendingPathComponent(name)
                try FileManager.default.createDirectory(atPath: hostDir, withIntermediateDirectories: true)
                guard isCurrent(operation) else { cancelOperation(operation); return }
                try jpeg.write(to: file, options: .atomic)
                active?.writtenFiles.append(file)
                finish(operation, data: ["guest_path": "\(guestDir)/\(name)",
                                        "width": Int(image.size.width * image.scale),
                                        "height": Int(image.size.height * image.scale), "bytes": jpeg.count], error: nil)
            } catch {
                finish(operation, data: nil, error: failure("capture_failed", "Failed to save photo: \(error.localizedDescription)"))
            }
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { cancelOperation(operation) }
    }

    // Compatibility entry for the user-operated pairing scanner in Settings.
    @objc(scanCodeWithCompletion:)
    public static func scanCode(completion: @escaping (NSDictionary?, NSString?) -> Void) {
        scanCode(operation: CameraCaptureOperation()) { data, error in
            completion(data, error?.localizedDescription as NSString?)
        }
    }

    @objc(scanCodeWithOperation:completion:)
    public static func scanCode(operation: CameraCaptureOperation,
                                completion: @escaping (NSDictionary?, NSError?) -> Void) {
        guard begin(operation, completion: completion) else { return }
        // Hardware first, then TCC, then current availability. isAvailable is
        // false before first camera authorization, so checking it first would
        // prevent the permission request entirely.
        guard DataScannerViewController.isSupported else {
            finish(operation, data: nil, error: failure("not_available", "Barcode scanning is not supported on this device.")); return
        }
        ensureCameraAuth(operation) {
            guard DataScannerViewController.isAvailable else {
                finish(operation, data: nil, error: failure("not_available", "Barcode scanning is unavailable. Check camera restrictions or other camera use.")); return
            }
            withPresenter(operation) { top, session in
                let scanner = DataScannerViewController(recognizedDataTypes: [.barcode()], qualityLevel: .balanced,
                    recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false,
                    isPinchToZoomEnabled: true, isGuidanceEnabled: true, isHighlightingEnabled: true)
                let delegate = CodeScanDelegate(operation: operation)
                scanner.delegate = delegate
                scanner.navigationItem.title = String(localized: "Scan Code")
                scanner.navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .cancel,
                    target: delegate, action: #selector(CodeScanDelegate.cancelTapped))
                let nav = UINavigationController(rootViewController: scanner)
                nav.modalPresentationStyle = .fullScreen
                session.scanner = scanner; session.delegate = delegate; session.controller = nav
                top.present(nav, animated: true) {
                    guard isCurrent(operation) else { cancelOperation(operation); return }
                    do { try scanner.startScanning() }
                    catch { finish(operation, data: nil, error: failure("capture_failed", "Failed to start scanning: \(error.localizedDescription)")) }
                }
            }
        }
    }

    @MainActor
    private final class CodeScanDelegate: NSObject, DataScannerViewControllerDelegate {
        let operation: CameraCaptureOperation
        init(operation: CameraCaptureOperation) { self.operation = operation }
        @objc func cancelTapped() { cancelOperation(operation) }
        func dataScanner(_ dataScanner: DataScannerViewController,
                         didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard isCurrent(operation) else { cancelOperation(operation); return }
            guard let first = addedItems.first, case .barcode(let barcode) = first else { return }
            finish(operation, data: ["payload": barcode.payloadStringValue ?? "",
                                     "symbology": barcode.observation.symbology.rawValue], error: nil)
        }
        func dataScanner(_ dataScanner: DataScannerViewController,
                         becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
            finish(operation, data: nil, error: failure("not_available", "Scanner became unavailable: \(error)"))
        }
    }

    @objc(scanDocumentWithOperation:hostDir:guestDir:completion:)
    public static func scanDocument(operation: CameraCaptureOperation, hostDir: String, guestDir: String,
                                    completion: @escaping (NSDictionary?, NSError?) -> Void) {
        guard begin(operation, completion: completion) else { return }
        guard VNDocumentCameraViewController.isSupported else {
            finish(operation, data: nil, error: failure("not_available", "Document scanning is not supported on this device.")); return
        }
        ensureCameraAuth(operation) {
            withPresenter(operation) { top, session in
                let controller = VNDocumentCameraViewController()
                let delegate = DocScanDelegate(operation: operation, hostDir: hostDir, guestDir: guestDir)
                controller.delegate = delegate
                session.delegate = delegate; session.controller = controller
                top.present(controller, animated: true)
            }
        }
    }

    @MainActor
    private final class DocScanDelegate: NSObject, VNDocumentCameraViewControllerDelegate {
        let operation: CameraCaptureOperation
        let hostDir: String
        let guestDir: String
        init(operation: CameraCaptureOperation, hostDir: String, guestDir: String) {
            self.operation = operation; self.hostDir = hostDir; self.guestDir = guestDir
        }
        func documentCameraViewController(_ controller: VNDocumentCameraViewController,
                                          didFinishWith scan: VNDocumentCameraScan) {
            guard isCurrent(operation) else { cancelOperation(operation); return }
            do {
                try FileManager.default.createDirectory(atPath: hostDir, withIntermediateDirectories: true)
                var pages: [[String: Any]] = []
                for index in 0..<scan.pageCount {
                    guard isCurrent(operation) else { cancelOperation(operation); return }
                    let image = scan.imageOfPage(at: index)
                    guard let jpeg = image.jpegData(compressionQuality: 0.9) else {
                        throw failure("capture_failed", "Could not encode document page \(index + 1).")
                    }
                    let name = "scan-\(operation.operationID)-p\(index + 1).jpg"
                    let file = URL(fileURLWithPath: hostDir).appendingPathComponent(name)
                    try jpeg.write(to: file, options: .atomic)
                    active?.writtenFiles.append(file)
                    pages.append(["guest_path": "\(guestDir)/\(name)", "bytes": jpeg.count])
                }
                guard !pages.isEmpty else { throw failure("capture_failed", "No document pages were captured.") }
                finish(operation, data: ["pages": pages, "count": pages.count,
                    "hint": "Run `apple-vision ocr <guest_path>` to extract text from each page."], error: nil)
            } catch {
                finish(operation, data: nil, error: failure("capture_failed", "Failed to save document: \(error.localizedDescription)"))
            }
        }
        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) { cancelOperation(operation) }
        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
            finish(operation, data: nil, error: failure("capture_failed", "Document scan failed: \(error.localizedDescription)"))
        }
    }

    private static func topViewController() -> UIViewController? {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).activeFirst,
              let root = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController else { return nil }
        var top = root
        while let presented = top.presentedViewController { top = presented }
        return top
    }
}
