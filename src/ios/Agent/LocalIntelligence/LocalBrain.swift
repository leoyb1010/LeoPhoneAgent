//
//  LocalBrain.swift
//  MinisApp
//
//  [T-local-brain] 端上小脑:高频、低风险、结构化的活儿本机做完。
//
//  定位很克制——它不是路由中枢,也不接管对话主脑(那仍然是云端模型 +
//  工具调用)。只做三件每天发生几十次、却要为此联网等待的小事:
//    ① 收藏自动摘要与标签(存进来就有一句话说明,回头翻收藏不用点开)
//    ② 输入框文本改写(润色/精简/翻译,选中即改,不出手机)
//    ③ 语音转结构化任务(说一段话 → 标题 + 要点 + 目标机器)
//
//  可用性是个矩阵,不是版本号:设备要支持 Apple Intelligence、用户要开、
//  模型要下载好、语言要覆盖。任何一环缺失都必须优雅回落到"这件事照旧
//  联网做",绝不能让功能消失或报错。
//

import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

#if canImport(FoundationModels)
@available(iOS 26.0, *)
@Generable
private struct CollectionInsightPayload {
    let summary: String
    let tags: [String]
}

@available(iOS 26.0, *)
@Generable
private struct StructuredTaskPayload {
    let title: String
    let detail: String
}
#endif

@MainActor
final class LocalBrain: ObservableObject {
    static let shared = LocalBrain()
    private init() {}

    /// 本机模型此刻能不能用,以及为什么不能。UI 用它决定显示与否。
    enum Availability: Equatable {
        case ready
        case unsupportedDevice
        case notEnabled          // 用户没开 Apple Intelligence
        case modelNotReady       // 正在下载 / 空间不足
        case unavailableOnOS     // 系统版本不带
    }

    var availability: Availability {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                return .ready
            case .unavailable(let reason):
                switch reason {
                case .deviceNotEligible: return .unsupportedDevice
                case .appleIntelligenceNotEnabled: return .notEnabled
                case .modelNotReady: return .modelNotReady
                @unknown default: return .unavailableOnOS
                }
            @unknown default:
                return .unavailableOnOS
            }
        }
        return .unavailableOnOS
        #else
        return .unavailableOnOS
        #endif
    }

    var isReady: Bool { availability == .ready }

    var statusText: String {
        switch availability {
        case .ready: return String(localized: "本机模型可用")
        case .unsupportedDevice: return String(localized: "这台设备不支持 Apple Intelligence")
        case .notEnabled: return String(localized: "在系统设置里开启 Apple Intelligence 后可用")
        case .modelNotReady: return String(localized: "本机模型还在准备中")
        case .unavailableOnOS: return String(localized: "当前系统版本不提供本机模型")
        }
    }

    // MARK: - ① 收藏摘要与标签

    struct CollectionInsight {
        let summary: String
        let tags: [String]
    }

    /// 给一条收藏生成一句话摘要 + 最多 3 个标签。不可用时返回 nil,
    /// 调用方保持原样(不显示摘要),不报错。
    func summarizeCollection(title: String?, text: String) async -> CollectionInsight? {
        #if canImport(FoundationModels)
        guard #available(iOS 26.0, *), isReady else { return nil }
        let material = [title, text].compactMap { $0 }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard material.count >= 12 else { return nil }
        do {
            let session = LanguageModelSession(
                instructions: "你是一个内容归档助手。摘要不超过 40 个中文字符，标签最多 3 个。"
            )
            let response = try await session.respond(
                to: "为下面的收藏生成一句话摘要和标签：\n\(String(material.prefix(2000)))",
                generating: CollectionInsightPayload.self
            )
            let summary = response.content.summary.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !summary.isEmpty else { return nil }
            let tags = response.content.tags
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            return CollectionInsight(summary: String(summary.prefix(80)), tags: Array(tags.prefix(3)))
        } catch {
            return nil
        }
        #else
        return nil
        #endif
    }

    static func parseInsight(_ raw: String) -> CollectionInsight? {
        var summary = ""
        var tags: [String] = []
        for line in raw.split(separator: "\n") {
            let s = line.trimmingCharacters(in: .whitespaces)
            if s.hasPrefix("摘要:") || s.hasPrefix("摘要:") {
                summary = String(s.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            } else if s.hasPrefix("标签:") || s.hasPrefix("标签:") {
                tags = String(s.dropFirst(3))
                    .split(whereSeparator: { "、,,/ ".contains($0) })
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                    .filter { !$0.isEmpty }
            }
        }
        guard !summary.isEmpty else { return nil }
        return CollectionInsight(summary: String(summary.prefix(80)),
                                 tags: Array(tags.prefix(3)))
    }

    // MARK: - ② 文本改写

    enum RewriteStyle: String, CaseIterable, Identifiable {
        case polish, concise, expand, translateEN, translateZH, formal, casual
        var id: String { rawValue }

        var title: String {
            switch self {
            case .polish: return String(localized: "润色")
            case .concise: return String(localized: "更精简")
            case .expand: return String(localized: "更详细")
            case .translateEN: return String(localized: "译成英文")
            case .translateZH: return String(localized: "译成中文")
            case .formal: return String(localized: "更正式")
            case .casual: return String(localized: "更口语")
            }
        }

        var icon: String {
            switch self {
            case .polish: return "wand.and.stars"
            case .concise: return "arrow.down.right.and.arrow.up.left"
            case .expand: return "arrow.up.left.and.arrow.down.right"
            case .translateEN, .translateZH: return "character.book.closed"
            case .formal: return "text.badge.checkmark"
            case .casual: return "bubble.left.and.bubble.right"
            }
        }

        var instruction: String {
            switch self {
            case .polish: return "润色下面这段文字,保持原意与语言,让它更通顺自然。"
            case .concise: return "把下面这段文字压缩得更精简,保留全部关键信息。"
            case .expand: return "把下面这段文字写得更详细具体,补充必要的说明。"
            case .translateEN: return "把下面这段文字翻译成地道的英文。"
            case .translateZH: return "把下面这段文字翻译成地道的简体中文。"
            case .formal: return "把下面这段文字改写得更正式、更书面。"
            case .casual: return "把下面这段文字改写得更口语、更轻松。"
            }
        }
    }

    /// 改写输入框里的文本。不可用返回 nil,调用方保留原文。
    func rewrite(_ text: String, style: RewriteStyle) async -> String? {
        #if canImport(FoundationModels)
        guard #available(iOS 26.0, *), isReady else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let prompt = "\(style.instruction)\n\n只输出改写后的文字本身,不要解释、不要加引号。\n\n\(String(trimmed.prefix(4000)))"
        guard let raw = await respond(to: prompt, instructions:
            "你是一个文字编辑。只输出改写结果,不解释、不寒暄、不加前后缀。") else { return nil }
        return raw.trimmingCharacters(in: .whitespacesAndNewlines)
        #else
        return nil
        #endif
    }

    // MARK: - ③ 语音 → 结构化任务

    struct StructuredTask {
        let title: String
        let detail: String
    }

    /// 把一段口述整理成"标题 + 要点"。用于语音下任务时先给个可确认的草稿。
    func structureTask(from speech: String) async -> StructuredTask? {
        #if canImport(FoundationModels)
        guard #available(iOS 26.0, *), isReady else { return nil }
        let trimmed = speech.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 8 else { return nil }
        do {
            let session = LanguageModelSession(
                instructions: "把口语化表述整理成可执行任务。标题不超过 20 个中文字符，要点用一到三句话。"
            )
            let response = try await session.respond(
                to: "整理下面这段口述：\n\(String(trimmed.prefix(3000)))",
                generating: StructuredTaskPayload.self
            )
            let title = response.content.title.trimmingCharacters(in: .whitespacesAndNewlines)
            let detail = response.content.detail.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { return nil }
            return StructuredTask(
                title: String(title.prefix(40)),
                detail: detail.isEmpty ? trimmed : detail
            )
        } catch {
            return nil
        }
        #else
        return nil
        #endif
    }

    // MARK: - 底层调用

    /// 单轮生成。任何异常(会话超限、内容被拦、模型忙)一律回 nil,
    /// 由调用方回落到原有行为——本机模型是加分项,不是依赖项。
    private func respond(to prompt: String, instructions: String) async -> String? {
        #if canImport(FoundationModels)
        guard #available(iOS 26.0, *) else { return nil }
        do {
            let session = LanguageModelSession(instructions: instructions)
            let response = try await session.respond(to: prompt)
            let text = response.content.trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : text
        } catch {
            return nil
        }
        #else
        return nil
        #endif
    }
}
