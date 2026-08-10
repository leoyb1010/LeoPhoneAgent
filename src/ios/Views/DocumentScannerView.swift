//
//  DocumentScannerView.swift
//  MinisApp
//
//  [T-attachments] 系统文档扫描。
//
//  VNDocumentCameraViewController 是 iOS 内置的那套:自动找纸张边缘、
//  透视校正、去阴影、连拍多页。自己用 AVFoundation 造一个要几百行,
//  效果还不如它 —— 拍纸质文档就该用系统的。
//
//  扫出来的每一页都是 UIImage,交给 AttachmentImporter 存盘 + OCR。
//

import SwiftUI
import VisionKit

struct DocumentScannerView: UIViewControllerRepresentable {
    /// 扫描完成,回调每一页。取消时回调空数组。
    var onFinish: ([UIImage]) -> Void

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let controller = VNDocumentCameraViewController()
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: VNDocumentCameraViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let onFinish: ([UIImage]) -> Void
        init(onFinish: @escaping ([UIImage]) -> Void) { self.onFinish = onFinish }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController,
                                          didFinishWith scan: VNDocumentCameraScan) {
            let pages = (0..<scan.pageCount).map { scan.imageOfPage(at: $0) }
            controller.dismiss(animated: true) { self.onFinish(pages) }
        }

        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            controller.dismiss(animated: true) { self.onFinish([]) }
        }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController,
                                          didFailWithError error: Error) {
            controller.dismiss(animated: true) { self.onFinish([]) }
        }
    }
}
