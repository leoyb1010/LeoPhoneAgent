//
//  QuickNoteIntent.swift
//  MinisApp
//
//  [T-notes] 对 Siri 说一句就存成笔记。
//
//  这条路径的价值在于**不打开 app**:想法冒出来的时候人往往在走路、
//  在开车、手上拿着别的东西 —— 掏出手机解锁找 app 的那十几秒,想法就
//  跑了。锁屏喊一句,它已经在收藏库里了。
//
//  口述进来的常常是一段流水话,交给本机模型整理成标题 + 要点再存;
//  本机模型不可用就原样存 —— 不因为它缺席而少一个功能。
//

import AppIntents
import Foundation

@available(iOS 17.0, *)
struct QuickNoteIntent: AppIntent {
    static var title: LocalizedStringResource = "记一条笔记"
    static var description = IntentDescription("把一段话直接存进收藏库,不用打开 app。")
    /// 后台执行:开 app 就失去了这条路径的意义。
    static var openAppWhenRun: Bool = false

    @Parameter(title: "内容", requestValueDialog: "要记什么?")
    var text: String

    static var parameterSummary: some ParameterSummary {
        Summary("记下 \(\.$text)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else {
            return .result(dialog: "没听清要记什么。")
        }

        // 口述是流水话,先让本机模型理成标题 + 要点。
        // 加 4 秒竞速超时:Foundation Models 冷启动可能要好几秒,而
        // App Intent 的执行预算有限 —— 超时就原样存,绝不让"记一条"
        // 因为整理慢而整个失败。
        let structured = await withTaskGroup(of: LocalBrain.StructuredTask?.self) { group in
            group.addTask { await LocalBrain.shared.structureTask(from: raw) }
            group.addTask {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
        var note = CollectedItem.newNote(title: structured?.title ?? "")
        let body = structured.map { "\($0.title)\n\n\($0.detail)" } ?? raw
        if note.title == nil {
            // 没有本机模型时,拿首句当标题
            let firstSentence = raw.split(whereSeparator: { "。!?\n.!?".contains($0) }).first
            note.title = firstSentence.map { String($0.prefix(30)) }
        }
        note.value = String(body.prefix(200))
        note.sourceLabel = "笔记"

        // 先落正文再入库:反过来的话 save 失败会在收藏里留下一条打不开的
        // 空笔记 —— 用户对着 Siri 说完话,得到的是个空壳。
        if let file = note.bodyFile {
            await NoteBodyStore.save(body, to: file)
        }
        CollectionStore.add([note])
        await CollectionSearchIndex.shared.index(
            itemId: note.id, title: note.title ?? "", body: body)

        return .result(dialog: IntentDialog("记下了:\(note.title ?? String(raw.prefix(20)))"))
    }
}
