//
//  LocalBrain+Tools.swift
//  MinisApp
//
//  [WP-45] Foundation Models 27 system tools on the local brain:
//  - screenshot Q&A, offline: the image goes in as an `Attachment`, `OCRTool`
//    (Vision cross-import) reads its text, the on-device model answers;
//  - "find that conversation from last week", offline: `SpotlightSearchTool` over
//    the sessions `SessionSpotlightIndexer` already indexes. `.focused(.items)` on
//    purpose — the default guide's schema overflows the on-device context window.
//  Both are on-device only (never the external stand-in model): images and the
//  search index stay on the phone.
//

import CoreGraphics
import Foundation
#if canImport(FoundationModels)
import CoreSpotlight
import FoundationModels
import Vision

extension LocalBrain {
    /// Answer `question` about an image (screenshot, photo of a document). nil when the
    /// on-device model is unavailable or the answer is empty.
    func answer(aboutImage image: CGImage, question: String) async -> String? {
        guard availability == .ready else { return nil }
        let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            // 模拟器 SDK 没有 FoundationModels 的 OCRTool；模拟器上只靠附件本身作答（单测与 UI 测试用）。
            #if targetEnvironment(simulator)
            let tools: [any Tool] = []
            #else
            let tools: [any Tool] = [OCRTool()]
            #endif
            let session = LanguageModelSession(
                tools: tools,
                instructions: "你帮用户看一张图片(多为截图)。需要读图里的文字时调用 OCR 工具,只依据图里实际有的内容回答,看不清就直说。回答简洁。")
            let response = try await session.respond {
                Attachment(image).label("图片")
                q.isEmpty ? "这张图里写了什么?用三句话以内概括。" : q
            }
            let text = response.content.trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : text
        } catch {
            return nil
        }
    }

    /// Search this phone's conversations by meaning ("上周讨论报销那次"), on-device.
    func findSessions(matching query: String) async -> String? {
        guard availability == .ready else { return nil }
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return nil }
        do {
            let tool = SpotlightSearchTool(configuration: .init(sources: [.coreSpotlight], guide: .focused(.items)))
            let session = LanguageModelSession(
                tools: [tool],
                instructions: "你在用户自己的 LeoBot 会话索引里找会话(只有标题)。调用搜索工具,列出最相关的最多 5 个会话标题,每行一个;找不到就说找不到,不要编造。")
            let response = try await session.respond(to: q)
            let text = response.content.trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : text
        } catch {
            return nil
        }
    }
}
#endif
