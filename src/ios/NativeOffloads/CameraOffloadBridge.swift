//
//  CameraOffloadBridge.swift
//  MinisApp
//
//  Swift bridge for apple-camera — photo capture, barcode scanning,
//  document scanning. All three present a system/VisionKit UI the user
//  operates; nothing is captured silently (规格书 X 级红线:禁止静默采集).
//

import Foundation
import AVFoundation
import UIKit
import VisionKit

private let logger = AppLogger(category: "CameraOffloadBridge")

@MainActor @objc public class CameraOffloadBridge: NSObject {

    // Strong refs while a capture UI is up.
    private static var activePhotoDelegate: PhotoCaptureDelegate?
    private static var activeScanDelegate: CodeScanDelegate?
    private static var activeDocDelegate: DocScanDelegate?
    private static var activeScanner: DataScannerViewController?

    private static var busy: Bool {
        activePhotoDelegate != nil || activeScanDelegate != nil || activeDocDelegate != nil
    }

    // MARK: - Authorization

    /// Ensure camera permission, prompting once if undetermined.
    /// Calls `completion(nil)` when authorized, or an error message.
    private static func ensureCameraAuth(_ completion: @escaping (String?) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            completion(nil)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                Task { @MainActor in
                    completion(granted ? nil :
                        "Camera access was denied. Enable it in 设置 → 隐私与安全性 → 相机 → LeoPhoneAgent.")
                }
            }
        default:
            completion("Camera access is not granted. Enable it in 设置 → 隐私与安全性 → 相机 → LeoPhoneAgent.")
        }
    }

    private static func precheck() -> String? {
        if UIApplication.shared.applicationState != .active {
            return "LeoPhoneAgent is not in the foreground. Ask the user to open the app, then retry."
        }
        if busy {
            return "Another camera UI is already open. Finish or cancel it first."
        }
        return nil
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

    // MARK: - photo

    @objc(takePhotoWithCamera:hostDir:guestDir:completion:)
    public static func takePhoto(
        camera: String,
        hostDir: String,
        guestDir: String,
        completion: @escaping (NSDictionary?, NSString?) -> Void
    ) {
        if let msg = precheck() { completion(nil, msg as NSString); return }
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            completion(nil, "No camera available on this device.")
            return
        }
        ensureCameraAuth { authError in
            if let authError { completion(nil, authError as NSString); return }
            guard let topVC = topViewController() else {
                completion(nil, "No view controller available to present the camera.")
                return
            }
            let delegate = PhotoCaptureDelegate(hostDir: hostDir, guestDir: guestDir) { data, error in
                activePhotoDelegate = nil
                completion(data, error)
            }
            activePhotoDelegate = delegate

            let picker = UIImagePickerController()
            picker.sourceType = .camera
            picker.cameraDevice = (camera == "front") ? .front : .rear
            picker.delegate = delegate
            topVC.present(picker, animated: true)
            logger.info("[apple-camera] photo UI presented (camera=\(camera))")
        }
    }

    @MainActor
    private final class PhotoCaptureDelegate: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let hostDir: String
        let guestDir: String
        let completion: (NSDictionary?, NSString?) -> Void

        init(hostDir: String, guestDir: String, completion: @escaping (NSDictionary?, NSString?) -> Void) {
            self.hostDir = hostDir
            self.guestDir = guestDir
            self.completion = completion
        }

        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            picker.dismiss(animated: true)
            guard let image = info[.originalImage] as? UIImage,
                  let jpeg = image.jpegData(compressionQuality: 0.9) else {
                completion(nil, "Failed to read the captured photo.")
                return
            }
            let fm = FileManager.default
            try? fm.createDirectory(atPath: hostDir, withIntermediateDirectories: true)
            let name = "camera-\(Self.timestamp()).jpg"
            let hostPath = (hostDir as NSString).appendingPathComponent(name)
            do {
                try jpeg.write(to: URL(fileURLWithPath: hostPath), options: .atomic)
            } catch {
                completion(nil, "Failed to save photo: \(error.localizedDescription)" as NSString)
                return
            }
            completion([
                "guest_path": "\(guestDir)/\(name)",
                "width": Int(image.size.width * image.scale),
                "height": Int(image.size.height * image.scale),
                "bytes": jpeg.count,
            ] as NSDictionary, nil)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            picker.dismiss(animated: true)
            completion(nil, "The user cancelled the camera.")
        }

        static func timestamp() -> String {
            let df = DateFormatter()
            df.dateFormat = "yyyyMMdd-HHmmss"
            return df.string(from: Date())
        }
    }

    // MARK: - scan-code (VisionKit DataScanner)

    @objc(scanCodeWithCompletion:)
    public static func scanCode(completion: @escaping (NSDictionary?, NSString?) -> Void) {
        if let msg = precheck() { completion(nil, msg as NSString); return }
        guard DataScannerViewController.isSupported else {
            completion(nil, "Barcode scanning is not supported on this device.")
            return
        }
        guard DataScannerViewController.isAvailable else {
            completion(nil, "Barcode scanner unavailable — camera access may be denied.")
            return
        }
        ensureCameraAuth { authError in
            if let authError { completion(nil, authError as NSString); return }
            guard let topVC = topViewController() else {
                completion(nil, "No view controller available to present the scanner.")
                return
            }
            let scanner = DataScannerViewController(
                recognizedDataTypes: [.barcode()],
                qualityLevel: .balanced,
                recognizesMultipleItems: false,
                isHighFrameRateTrackingEnabled: false,
                isPinchToZoomEnabled: true,
                isGuidanceEnabled: true,
                isHighlightingEnabled: true
            )
            let delegate = CodeScanDelegate { data, error in
                activeScanDelegate = nil
                activeScanner = nil
                completion(data, error)
            }
            activeScanDelegate = delegate
            activeScanner = scanner
            scanner.delegate = delegate

            scanner.navigationItem.title = String(localized: "Scan Code")
            scanner.navigationItem.leftBarButtonItem = UIBarButtonItem(
                barButtonSystemItem: .cancel, target: delegate, action: #selector(CodeScanDelegate.cancelTapped))
            let nav = UINavigationController(rootViewController: scanner)
            nav.modalPresentationStyle = .fullScreen
            topVC.present(nav, animated: true) {
                do {
                    try scanner.startScanning()
                } catch {
                    nav.dismiss(animated: true)
                    delegate.finish(nil, "Failed to start scanning: \(error.localizedDescription)")
                }
            }
            logger.info("[apple-camera] barcode scanner presented")
        }
    }

    @MainActor
    private final class CodeScanDelegate: NSObject, DataScannerViewControllerDelegate {
        private var completion: ((NSDictionary?, NSString?) -> Void)?

        init(completion: @escaping (NSDictionary?, NSString?) -> Void) {
            self.completion = completion
        }

        func finish(_ data: NSDictionary?, _ error: String?) {
            guard let cb = completion else { return }
            completion = nil
            cb(data, error as NSString?)
        }

        @objc func cancelTapped() {
            activeScanner?.stopScanning()
            activeScanner?.navigationController?.dismiss(animated: true)
            finish(nil, "The user cancelled the scanner.")
        }

        func dataScanner(_ dataScanner: DataScannerViewController,
                         didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard let first = addedItems.first else { return }
            if case .barcode(let barcode) = first {
                dataScanner.stopScanning()
                dataScanner.navigationController?.dismiss(animated: true)
                finish([
                    "payload": barcode.payloadStringValue ?? "",
                    "symbology": barcode.observation.symbology.rawValue,
                ] as NSDictionary, nil)
            }
        }

        func dataScanner(_ dataScanner: DataScannerViewController,
                         becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
            dataScanner.navigationController?.dismiss(animated: true)
            finish(nil, "Scanner became unavailable: \(error)")
        }
    }

    // MARK: - scan-document (VNDocumentCamera)

    @objc(scanDocumentWithHostDir:guestDir:completion:)
    public static func scanDocument(
        hostDir: String,
        guestDir: String,
        completion: @escaping (NSDictionary?, NSString?) -> Void
    ) {
        if let msg = precheck() { completion(nil, msg as NSString); return }
        guard VNDocumentCameraViewController.isSupported else {
            completion(nil, "Document scanning is not supported on this device.")
            return
        }
        ensureCameraAuth { authError in
            if let authError { completion(nil, authError as NSString); return }
            guard let topVC = topViewController() else {
                completion(nil, "No view controller available to present the document camera.")
                return
            }
            let delegate = DocScanDelegate(hostDir: hostDir, guestDir: guestDir) { data, error in
                activeDocDelegate = nil
                completion(data, error)
            }
            activeDocDelegate = delegate

            let docCam = VNDocumentCameraViewController()
            docCam.delegate = delegate
            topVC.present(docCam, animated: true)
            logger.info("[apple-camera] document camera presented")
        }
    }

    @MainActor
    private final class DocScanDelegate: NSObject, VNDocumentCameraViewControllerDelegate {
        let hostDir: String
        let guestDir: String
        let completion: (NSDictionary?, NSString?) -> Void

        init(hostDir: String, guestDir: String, completion: @escaping (NSDictionary?, NSString?) -> Void) {
            self.hostDir = hostDir
            self.guestDir = guestDir
            self.completion = completion
        }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController,
                                          didFinishWith scan: VNDocumentCameraScan) {
            controller.dismiss(animated: true)
            let fm = FileManager.default
            try? fm.createDirectory(atPath: hostDir, withIntermediateDirectories: true)
            let stamp = PhotoCaptureDelegate.timestamp()
            var pages: [[String: Any]] = []
            for i in 0..<scan.pageCount {
                let image = scan.imageOfPage(at: i)
                guard let jpeg = image.jpegData(compressionQuality: 0.9) else { continue }
                let name = "scan-\(stamp)-p\(i + 1).jpg"
                let hostPath = (hostDir as NSString).appendingPathComponent(name)
                do {
                    try jpeg.write(to: URL(fileURLWithPath: hostPath), options: .atomic)
                    pages.append(["guest_path": "\(guestDir)/\(name)", "bytes": jpeg.count])
                } catch {
                    logger.warning("[apple-camera] failed to save page \(i + 1): \(error.localizedDescription)")
                }
            }
            if pages.isEmpty {
                completion(nil, "No pages could be saved.")
            } else {
                completion([
                    "pages": pages,
                    "count": pages.count,
                    "hint": "Run `apple-vision ocr <guest_path>` to extract text from each page.",
                ] as NSDictionary, nil)
            }
        }

        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            controller.dismiss(animated: true)
            completion(nil, "The user cancelled the document scanner.")
        }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController,
                                          didFailWithError error: Error) {
            controller.dismiss(animated: true)
            completion(nil, "Document scan failed: \(error.localizedDescription)" as NSString)
        }
    }

    // MARK: - Helpers

    private static func topViewController() -> UIViewController? {
        guard let windowScene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene }).activeFirst,
              let rootVC = windowScene.windows.first(where: { $0.isKeyWindow })?.rootViewController else {
            return nil
        }
        var topVC = rootVC
        while let presented = topVC.presentedViewController {
            topVC = presented
        }
        return topVC
    }
}
