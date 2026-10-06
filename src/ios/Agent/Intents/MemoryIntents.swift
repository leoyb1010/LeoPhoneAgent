//
//  MemoryIntents.swift
//  MinisApp
//
//  [C3] 记忆进 Siri / 快捷指令:「记住这个」与「想一想」。
//
//  RememberThisIntent 只往当天记忆日志追加一条,不读取任何已有记忆,锁屏可跑;
//  RecallMemoryIntent 会把记忆片段念出来 / 交给下一步,必须解锁。
//

import AppIntents
import Foundation
import UIKit

struct RememberThisIntent: AppIntent {
    static var title: LocalizedStringResource = "记住这个"
    static var description = IntentDescription("把一句话写进 LeoPhoneAgent 的记忆，以后对话里会自动想起。不会读出已有记忆。")
    static var openAppWhenRun: Bool = false
    static var supportedModes: IntentModes = .background
    static var authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

    @Parameter(title: "内容", requestValueDialog: "要我记住什么？")
    var text: String

    static var parameterSummary: some ParameterSummary {
        Summary("记住 \(\.$text)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let content = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(4000))
        guard !content.isEmpty else { return .result(dialog: "没听清要记什么。") }
        guard (UserDefaults.standard.object(forKey: "memory.global.enabled") as? Bool) ?? true else {
            return .result(dialog: "记忆功能已关闭，可以在 App 的设置 › 记忆里打开。")
        }
        // 锁屏可跑(产品决定保留):条目上标明来源,读记忆时能分辨这条不是对话里记下的。
        let locked = !UIApplication.shared.isProtectedDataAvailable
        let outcome = AIChatViewModel.writeDailyMemory(content, source: locked ? "快捷指令·锁屏" : "快捷指令")
        return .result(dialog: outcome.success ? "记住了。" : "没记上，请稍后再试。")
    }
}

struct RecallMemoryIntent: AppIntent {
    static var title: LocalizedStringResource = "想一想"
    static var description = IntentDescription("在 LeoPhoneAgent 的记忆里找和问题最相关的 3 条，返回文本。")
    static var openAppWhenRun: Bool = false
    static var supportedModes: IntentModes = .background
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "问题", requestValueDialog: "想找哪方面的记忆？")
    var query: String

    static var parameterSummary: some ParameterSummary {
        Summary("在记忆里找 \(\.$query)")
    }

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let normalized = String(query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(500))
        guard !normalized.isEmpty else {
            return .result(value: "", dialog: "没听清要找什么。")
        }
        let found = await MemoryRecallIndex.shared.query(normalized, topK: 3)
        guard !found.results.isEmpty else {
            return .result(value: "", dialog: "记忆里没找到相关内容。")
        }
        let text = found.results
            .map { "· \($0.text.trimmingCharacters(in: .whitespacesAndNewlines))" }
            .joined(separator: "\n")
        return .result(value: text, dialog: IntentDialog(stringLiteral: String(text.prefix(500))))
    }
}
