//
//  ExportSessionIntent.swift
//  MinisApp
//
//  [C5] 导出会话:返回文件,可接「存储文件」或「共享」。
//  内容与 App 内「导出 Markdown」同一个函数生成。
//

import AppIntents
import Foundation
import UniformTypeIdentifiers

enum SessionExportFileFormat: String, AppEnum {
    case markdown
    case plainText

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "导出格式")
    static let caseDisplayRepresentations: [SessionExportFileFormat: DisplayRepresentation] = [
        .markdown: "Markdown",
        .plainText: "纯文本",
    ]
}

struct ExportSessionIntent: AppIntent {
    static var title: LocalizedStringResource = "导出会话"
    static var description = IntentDescription("把一个 LeoBot 会话导出成 Markdown 或纯文本文件，可接「存储文件」或「共享」。")
    static var openAppWhenRun: Bool = false
    static var supportedModes: IntentModes = .background
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "会话")
    var session: SessionEntity

    @Parameter(title: "格式", default: .markdown)
    var format: SessionExportFileFormat

    static var parameterSummary: some ParameterSummary {
        Summary("把 \(\.$session) 导出为 \(\.$format)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<IntentFile> {
        if SessionLockStore.shared.isHiddenFromSystemSurfaces(session.id) {
            throw SessionLockedIntentError.locked
        }
        let (vm, isNew) = ViewModelCache.shared.getOrCreate(for: session.id)
        if isNew {
            // loadSession() marks this session as the one on screen; it isn't.
            let onScreen = AIChatViewModel.activeSessionId
            await vm.loadSession()
            AIChatViewModel.activeSessionId = onScreen
        }
        let markdown = AIChatViewModel.sessionExportMarkdown(messages: vm.messages)
        let stamp = AIChatViewModel.exportStamp.string(from: Date())
        let file: IntentFile
        switch format {
        case .markdown:
            file = IntentFile(data: Data(markdown.utf8), filename: "session-\(stamp).md",
                              type: UTType(filenameExtension: "md") ?? .plainText)
        case .plainText:
            // 长会话去 Markdown 很慢(App 内导出同样放在后台线程做),不占主线程。
            let plain = await Task.detached(priority: .userInitiated) { WatchTextSanitizer.plain(markdown) }.value
            file = IntentFile(data: Data(plain.utf8), filename: "session-\(stamp).txt",
                              type: .plainText)
        }
        return .result(value: file)
    }
}
