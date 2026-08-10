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
    static var title: LocalizedStringResource = "收藏到 LPA"
    static var description = IntentDescription(
        "把一段文字或链接存进收藏。整段粘贴即可——会自动抽出其中的链接,前面的文案当标题。")
    static var openAppWhenRun = false

    @Parameter(title: "内容",
               description: "链接,或含链接的一整段文案(小红书那种复制出来的文字)。",
               inputConnectionBehavior: .connectToPreviousIntentResult)
    var content: String

    static var parameterSummary: some ParameterSummary {
        Summary("收藏 \(\.$content) 到 LPA")
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
