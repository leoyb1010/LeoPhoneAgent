//
//  CollectionIntents.swift
//  MinisApp
//
//  [T-collections] 收藏进 Siri / 快捷指令 / 操作按钮。
//
//  为什么需要它:小红书这类 app 只给"复制链接"、不给系统分享面板。
//  有了这个 intent,一条「获取剪贴板 → 收藏到 LPA」的快捷指令就能绑到
//  侧边操作按钮或控制中心——复制完按一下键,内容进收藏,连 app 都不用开。
//
//  openAppWhenRun = false:后台完成,不打断当前正在刷的 app。
//

import AppIntents
import Foundation

@available(iOS 16.0, *)
struct CollectLinkIntent: AppIntent {
    static let title: LocalizedStringResource = "收进藏宝阁"
    static let description = IntentDescription(
        "把一段文字或链接存进收藏。整段粘贴即可——会自动抽出其中的链接,前面的文案当标题。")
    static let openAppWhenRun = false

    @Parameter(title: "内容",
               description: "链接,或含链接的一整段文案(小红书那种复制出来的文字)。",
               inputConnectionBehavior: .connectToPreviousIntentResult)
    var content: String

    static var parameterSummary: some ParameterSummary {
        Summary("把 \(\.$content) 收进藏宝阁")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let added = CollectionStore.ingestText(content)
        guard added > 0 else {
            return .result(dialog: "内容是空的,没有收藏。")
        }
        let total = CollectionStore.load().count
        return .result(dialog: "已收藏,现在一共 \(total) 条。")
    }
}

/// Explicit search action for Shortcuts/Siri. It returns only titles and
/// source labels; article bodies, OCR, annotations, snippets and local paths
/// are intentionally not spoken or exported by this system surface.
@available(iOS 16.0, *)
struct SearchTreasuryIntent: AppIntent {
    static let title: LocalizedStringResource = "搜索藏宝阁"
    static let description = IntentDescription(
        "搜索本机藏宝阁并返回少量标题和来源。不会读取或朗读收藏正文。")
    static let openAppWhenRun = false

    @Parameter(title: "搜索内容", requestValueDialog: "要在藏宝阁里搜索什么？")
    var query: String

    static var parameterSummary: some ParameterSummary {
        Summary("在藏宝阁搜索 \(\.$query)")
    }

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let normalized = String(query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(500))
        guard !normalized.isEmpty else {
            let output = TreasuryShortcutPresentation.searchText(
                query: "", response: .init(items: [], truncated: false))
            return .result(value: output, dialog: IntentDialog(stringLiteral: output))
        }
        let response = await TreasuryService.search(.init(query: normalized, limit: 5))
        let output = TreasuryShortcutPresentation.searchText(query: normalized, response: response)
        return .result(value: output, dialog: IntentDialog(stringLiteral: output))
    }
}

/// Opens the product surface through the same central route used by the
/// `leophoneagent://collections` deep link. ContentView consumes a pending
/// route both on cold launch and while already running.
@available(iOS 16.0, *)
struct OpenTreasuryIntent: AppIntent {
    static let title: LocalizedStringResource = "打开藏宝阁"
    static let description = IntentDescription("打开 LeoPhoneAgent 的藏宝阁。")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        TreasuryIntentRouteStore.requestOpen()
        return .result(dialog: "正在打开藏宝阁。")
    }
}
