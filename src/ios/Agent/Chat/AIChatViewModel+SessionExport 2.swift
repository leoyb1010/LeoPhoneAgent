//
//  AIChatViewModel+SessionExport.swift
//  MinisApp
//
//  [T-session-export] Batch C: the whole conversation as one file — Markdown
//  or PDF — registered in the artifact tray and handed to the share sheet
//  (AirDrop, Files, Mail). Assembled from the in-memory messages; tool calls
//  become one-line markers so the transcript stays readable.
//

import Foundation
import UIKit

extension Notification.Name {
    /// AIChatView listens and presents its MinisShareSheet for this URL.
    static let chatShareFileRequested = Notification.Name("chatShareFileRequested")
}

extension AIChatViewModel {

    enum SessionExportFormat {
        case markdown
        case pdf
    }

    /// Build the export, register it as an artifact, then ask the view to
    /// present the share sheet. Fire-and-forget from a menu action.
    func exportSession(format: SessionExportFormat) {
        // Transcript assembly touches main-actor state -- cheap (measured
        // ~16ms/200 messages). The sanitizer + CoreText pagination are NOT
        // cheap on pathological input (a 500KB single-line blob measured
        // 8-74s) -- so everything after this line runs off-main.
        let markdown = sessionExportMarkdown()
        guard !markdown.isEmpty else { return }
        let stamp = Self.exportStamp.string(from: Date())
        let sessionId = self.sessionId
        Task.detached(priority: .userInitiated) {
            let fileName: String
            let data: Data?
            switch format {
            case .markdown:
                fileName = "session-\(stamp).md"
                data = markdown.data(using: .utf8)
            case .pdf:
                fileName = "session-\(stamp).pdf"
                data = Self.pdfData(from: WatchTextSanitizer.plain(markdown))
            }
            guard let data else { return }
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(fileName)
            do {
                try data.write(to: url)
            } catch {
                await MainActor.run { LeoHaptics.notification(.error) }
                return
            }
            // Into the tray so the export survives the share sheet, then share.
            if let sessionId {
                _ = try? await ArtifactRepository.shared.create(
                    data: data,
                    fileName: fileName,
                    mimeType: ArtifactKind.inferredMIMEType(fileName: fileName),
                    sessionId: sessionId,
                    title: fileName)
            }
            await MainActor.run {
                NotificationCenter.default.post(name: .chatShareFileRequested, object: url)
            }
        }
    }

    private static let exportStamp: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter
    }()

    /// The transcript as markdown. User/assistant text in full; tool calls
    /// as single marker lines; errors kept (they're part of what happened).
    private func sessionExportMarkdown() -> String {
        var out: [String] = []
        let header = DateFormatter()
        header.dateFormat = "yyyy-MM-dd HH:mm"
        out.append("# LeoPhoneAgent Session")
        out.append("")
        out.append("_Exported \(header.string(from: Date()))_")
        for message in messages {
            out.append("")
            switch message.role {
            case .user:
                out.append("## 👤 " + String(localized: "You"))
                out.append("")
                out.append(message.content)
            case .assistant:
                out.append("## 🤖 " + String(localized: "Assistant"))
                out.append("")
                for block in message.blocks {
                    switch block.kind {
                    case .text:
                        if !block.content.isEmpty { out.append(block.content); out.append("") }
                    case .thinking:
                        // Reasoning is scratch work, not part of the delivered
                        // conversation — skipped by design.
                        break
                    default:
                        out.append("> 🔧 \(Self.toolMarker(for: block.kind))")
                        out.append("")
                    }
                }
                if let error = message.error {
                    out.append("> ⚠️ \(error)")
                }
            default:
                break
            }
        }
        return out.joined(separator: "\n")
    }

    /// One-line transcript marker for a tool block.
    private static func toolMarker(for kind: AssistantBlockKind) -> String {
        switch kind {
        case .shellTool(let command): return "shell: \(String(command.prefix(80)))"
        case .fileReadTool(let path): return "read: \(path)"
        case .fileWriteTool(let path): return "write: \(path)"
        case .fileEditTool(let path): return "edit: \(path)"
        case .browserTool(let action): return "browser: \(action)"
        case .readImageTool(let path): return "image: \(path)"
        case .memoryTool(let action): return "memory: \(action)"
        case .text, .thinking, .info: return "tool"
        }
    }

    /// A4 pagination of plain text via CoreText — good enough for a readable
    /// transcript PDF without a web view round-trip.
    nonisolated private static func pdfData(from text: String) -> Data? {
        let pageRect = CGRect(x: 0, y: 0, width: 595, height: 842)
        let inset: CGFloat = 40
        let textRect = pageRect.insetBy(dx: inset, dy: inset)
        // CTFramesetterCreateFrame re-typesets every paragraph that touches a
        // page, so ONE giant paragraph (minified JSON, base64 dump) is
        // quadratic -- measured 8s for a 500KB single line, 74s for emoji
        // soup. Hard-wrapping long lines restores linear behaviour.
        let wrapped = text
            .split(separator: "\n", omittingEmptySubsequences: false)
            .flatMap { line -> [Substring] in
                guard line.count > 4000 else { return [line] }
                var pieces: [Substring] = []
                var start = line.startIndex
                while start < line.endIndex {
                    let end = line.index(start, offsetBy: 4000, limitedBy: line.endIndex) ?? line.endIndex
                    pieces.append(line[start..<end])
                    start = end
                }
                return pieces
            }
            .joined(separator: "\n")
        let attributed = NSAttributedString(
            string: wrapped,
            attributes: [
                .font: UIFont.systemFont(ofSize: 11),
                .foregroundColor: UIColor.black,
            ])
        let framesetter = CTFramesetterCreateWithAttributedString(attributed)
        let renderer = UIGraphicsPDFRenderer(bounds: pageRect)
        var location = 0
        let total = attributed.length
        guard total > 0 else { return nil }
        return renderer.pdfData { context in
            while location < total {
                context.beginPage()
                let path = CGPath(rect: textRect, transform: nil)
                let frame = CTFramesetterCreateFrame(
                    framesetter, CFRange(location: location, length: 0), path, nil)
                // CoreText draws in flipped coordinates.
                let cg = context.cgContext
                cg.saveGState()
                cg.translateBy(x: 0, y: pageRect.height)
                cg.scaleBy(x: 1, y: -1)
                CTFrameDraw(frame, cg)
                cg.restoreGState()
                let visible = CTFrameGetVisibleStringRange(frame)
                if visible.length == 0 { break }
                location += visible.length
            }
        }
    }
}
