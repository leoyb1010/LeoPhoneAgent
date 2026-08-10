//
//  AttachmentImporter.swift
//  MinisApp
//
//  [T-attachments] 附件导入 + Vision OCR。
//
//  三条入口都用系统件,不自己造:
//    · 文件 app       → fileImporter(SwiftUI 内置)
//    · 相册           → PhotosPicker(系统选择器,不必申请相册权限)
//    · 拍纸质文档     → VisionKit 文档扫描(自动找边、透视校正、去阴影)
//
//  图片一进来就跑 Vision OCR,识别出的文字进全文索引 —— 拍一张会议白板
//  或一页书,回头能靠里面的字搜到它。OCR 在本机跑,不联网、不花钱,
//  中文识别用 zh-Hans + en-US 双语种(混排很常见)。
//
//  OCR 一律在后台跑:一张图几百毫秒,放主线程就是肉眼可见的卡顿。
//

import Foundation
import UIKit
import Vision

enum AttachmentImporter {
    /// 把一张图存进收藏附件目录,顺带 OCR 出文字。
    /// 返回新建的条目(调用方负责入库),失败返回 nil。
    static func importImage(_ image: UIImage, sourceLabel: String = "图片") async -> CollectedItem? {
        guard let dir = CollectionStore.filesDirectory else { return nil }
        let fileName = "img-\(UUID().uuidString).jpg"
        // 存盘前压一次:原图动辄十几 MB,而收藏只需要看得清
        let resized = image.leoDownscaled(maxDimension: 2400)
        guard let data = resized.jpegData(compressionQuality: 0.85) else { return nil }
        do {
            try data.write(to: dir.appendingPathComponent(fileName), options: .atomic)
        } catch {
            return nil
        }

        var item = CollectedItem(kind: .file, value: fileName, sourceLabel: sourceLabel)
        item.metadataFetched = true

        // OCR:识别出的文字既当标题也进全文索引
        let text = await recognizeText(in: resized)
        if !text.isEmpty {
            let firstLine = text.split(separator: "\n").first.map(String.init) ?? ""
            if !firstLine.isEmpty { item.title = String(firstLine.prefix(60)) }
            // OCR 文字存进笔记正文文件:value 必须保持文件名(图片渲染
            // 靠它),所以识别出的文字不能塞进 value —— 走 bodyFile,
            // 这样点开能读全文,也能被检索命中。
            let bodyFile = "ocr-\(item.id).md"
            await NoteBodyStore.save(text, to: bodyFile)
            item.bodyFile = bodyFile
            item.summary = String(text.prefix(120))
            await CollectionSearchIndex.shared.index(
                itemId: item.id, title: item.title ?? "", body: text)
        }
        return item
    }

    /// 把任意文件复制进附件目录。
    static func importFile(at url: URL) async -> CollectedItem? {
        guard let dir = CollectionStore.filesDirectory else { return nil }
        // 文件 app 给的是安全作用域 URL,不 start 就读不到
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }

        let fileName = "file-\(UUID().uuidString)-\(url.lastPathComponent)"
        let dest = dir.appendingPathComponent(fileName)
        do {
            try FileManager.default.copyItem(at: url, to: dest)
        } catch {
            return nil
        }

        var item = CollectedItem(kind: .file, value: fileName, sourceLabel: "文件")
        item.title = url.lastPathComponent
        item.metadataFetched = true

        // 图片类顺手 OCR;PDF 等交给系统预览,不在这里解析
        if let image = UIImage(contentsOfFile: dest.path) {
            let text = await recognizeText(in: image)
            if !text.isEmpty {
                let bodyFile = "ocr-\(item.id).md"
                await NoteBodyStore.save(text, to: bodyFile)
                item.bodyFile = bodyFile
                item.summary = String(text.prefix(120))
                await CollectionSearchIndex.shared.index(
                    itemId: item.id, title: item.title ?? "", body: text)
            }
        }
        return item
    }

    // MARK: - OCR

    /// 本机文字识别。识别不出返回空串 —— 附件本身照样成立,OCR 是加分项。
    static func recognizeText(in image: UIImage) async -> String {
        guard let cgImage = image.cgImage else { return "" }
        return await withCheckedContinuation { cont in
            // 后台跑:一张图几百毫秒,主线程碰不得
            DispatchQueue.global(qos: .userInitiated).async {
                let request = VNRecognizeTextRequest()
                request.recognitionLevel = .accurate
                // 中英混排是常态,两个语种都给上
                request.recognitionLanguages = ["zh-Hans", "en-US"]
                request.usesLanguageCorrection = true

                let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
                try? handler.perform([request])
                let lines = (request.results ?? []).compactMap {
                    $0.topCandidates(1).first?.string
                }
                cont.resume(returning: lines.joined(separator: "\n"))
            }
        }
    }
}

extension UIImage {
    /// 等比缩到长边不超过 maxDimension。已经够小就原样返回。
    func leoDownscaled(maxDimension: CGFloat) -> UIImage {
        let longest = max(size.width, size.height)
        guard longest > maxDimension else { return self }
        let scale = maxDimension / longest
        let newSize = CGSize(width: size.width * scale, height: size.height * scale)
        return UIGraphicsImageRenderer(size: newSize).image { _ in
            draw(in: CGRect(origin: .zero, size: newSize))
        }
    }
}
