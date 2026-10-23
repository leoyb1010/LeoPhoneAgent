// Native camera operations always present a user-operated system UI.
import Foundation
import AVFoundation
import UIKit
import VisionKit

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
            error = failure("needs_foreground", "Open LeoBot in the foreground, then retry the camera.")
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
                    "Camera access is not granted. Enable it in 设置 → 隐私与安全性 → 相机 → LeoBot."))
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
                    finish(operation, data: nil, error: failure("needs_foreground", "Open LeoBot to use the camera."))
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
        guard let request = CameraFacingRequest(argument: camera) else {
            finish(operation, data: nil, error: failure("invalid_args",
                "Camera must be one of: \(CameraFacingRequest.accepted).")); return
        }
        // [duo-cap] iPhone Duo: "outer" / "inner" pick one of its two front cameras.
        if request.needsSpecificFrontCamera {
            takeSpecificFrontPhoto(operation: operation, request: request, hostDir: hostDir, guestDir: guestDir)
            return
        }
        // "front" / "user_facing": the system camera UI picks the front camera of the
        // display in use (on iPhone Duo: outer when closed, under-display when open).
        let cameraDevice: UIImagePickerController.CameraDevice = request == .back ? .rear : .front
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

    /// The outer / inner front camera, when this device has both (iPhone Duo, iOS 27.1+).
    private static func specificFrontCamera(_ request: CameraFacingRequest) -> AVCaptureDevice? {
        guard #available(iOS 27.1, *) else { return nil }
        let types: [AVCaptureDevice.DeviceType] = [.builtInOuterUltraWideCamera, .builtInInnerUltraWideCamera]
        let devices = AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .video,
                                                       position: .unspecified).devices
        let outer = devices.first { $0.deviceType == .builtInOuterUltraWideCamera }
        let inner = devices.first { $0.deviceType == .builtInInnerUltraWideCamera }
        guard let outer, let inner else { return nil }
        return request == .inner ? inner : outer
    }

    /// Minimal user-operated capture (preview + shutter + cancel) for a camera the
    /// system picker can't be told to use. Never captures without the user's tap.
    private static func takeSpecificFrontPhoto(operation: CameraCaptureOperation, request: CameraFacingRequest,
                                               hostDir: String, guestDir: String) {
        guard let device = specificFrontCamera(request) else {
            finish(operation, data: nil, error: failure("not_available",
                "This device has no separate outer and inner front cameras. Use --camera user_facing (or front)."))
            return
        }
        ensureCameraAuth(operation) {
            withPresenter(operation) { top, session in
                let controller = SpecificCameraController(operation: operation, device: device,
                                                          hostDir: hostDir, guestDir: guestDir)
                controller.modalPresentationStyle = .fullScreen
                session.controller = controller
                top.present(controller, animated: true)
            }
        }
    }

    @MainActor
    private final class SpecificCameraController: UIViewController, AVCapturePhotoCaptureDelegate {
        let operation: CameraCaptureOperation
        let hostDir: String
        let guestDir: String
        private let device: AVCaptureDevice
        private let capture = AVCaptureSession()
        private let output = AVCapturePhotoOutput()
        private let preview: AVCaptureVideoPreviewLayer
        private let shutter = UIButton(type: .system)

        init(operation: CameraCaptureOperation, device: AVCaptureDevice, hostDir: String, guestDir: String) {
            self.operation = operation; self.device = device; self.hostDir = hostDir; self.guestDir = guestDir
            preview = AVCaptureVideoPreviewLayer(session: capture)
            super.init(nibName: nil, bundle: nil)
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            preview.videoGravity = .resizeAspect
            view.layer.addSublayer(preview)
            shutter.setImage(UIImage(systemName: "circle.inset.filled",
                                     withConfiguration: UIImage.SymbolConfiguration(pointSize: 64)), for: .normal)
            shutter.tintColor = .white
            shutter.accessibilityLabel = AppLocalized("Take Photo")
            shutter.addTarget(self, action: #selector(shoot), for: .touchUpInside)
            let cancel = UIButton(type: .system)
            cancel.setTitle(AppLocalized("Cancel"), for: .normal)
            cancel.tintColor = .white
            cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
            for button in [shutter, cancel] {
                button.translatesAutoresizingMaskIntoConstraints = false
                view.addSubview(button)
            }
            let guide = view.safeAreaLayoutGuide
            NSLayoutConstraint.activate([
                shutter.centerXAnchor.constraint(equalTo: guide.centerXAnchor),
                shutter.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -16),
                cancel.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 20),
                cancel.centerYAnchor.constraint(equalTo: shutter.centerYAnchor),
            ])
            do {
                let input = try AVCaptureDeviceInput(device: device)
                capture.beginConfiguration()
                capture.sessionPreset = .photo
                guard capture.canAddInput(input), capture.canAddOutput(output) else {
                    capture.commitConfiguration()
                    throw failure("not_available", "The requested camera cannot be opened.")
                }
                capture.addInput(input)
                capture.addOutput(output)
                capture.commitConfiguration()
            } catch {
                finish(operation, data: nil, error: (error as NSError).domain == "LeoPhoneAgent.Camera"
                    ? error as NSError
                    : failure("not_available", "The requested camera cannot be opened: \(error.localizedDescription)"))
                return
            }
            let session = capture
            DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview.frame = view.bounds
        }

        override func viewDidDisappear(_ animated: Bool) {
            super.viewDidDisappear(animated)
            let session = capture
            DispatchQueue.global(qos: .userInitiated).async { session.stopRunning() }
        }

        @objc private func cancelTapped() { cancelOperation(operation) }

        @objc private func shoot() {
            guard isCurrent(operation), capture.isRunning else { return }
            shutter.isEnabled = false
            output.capturePhoto(with: AVCapturePhotoSettings(), delegate: self)
        }

        nonisolated func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto,
                                     error: Error?) {
            let data = photo.fileDataRepresentation()
            let message = error?.localizedDescription
            Task { @MainActor in self.save(data, error: message) }
        }

        private func save(_ data: Data?, error: String?) {
            guard isCurrent(operation) else { cancelOperation(operation); return }
            guard let data, let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.9) else {
                finish(operation, data: nil, error: failure("capture_failed",
                    "Failed to read the captured photo\(error.map { ": \($0)" } ?? ".")")); return
            }
            do {
                let name = "camera-\(operation.operationID).jpg"
                let file = URL(fileURLWithPath: hostDir).appendingPathComponent(name)
                try FileManager.default.createDirectory(atPath: hostDir, withIntermediateDirectories: true)
                try jpeg.write(to: file, options: .atomic)
                active?.writtenFiles.append(file)
                finish(operation, data: ["guest_path": "\(guestDir)/\(name)",
                                        "width": Int(image.size.width * image.scale),
                                        "height": Int(image.size.height * image.scale), "bytes": jpeg.count], error: nil)
            } catch {
                finish(operation, data: nil, error: failure("capture_failed", "Failed to save photo: \(error.localizedDescription)"))
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
                scanner.navigationItem.title = AppLocalized("Scan Code")
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
