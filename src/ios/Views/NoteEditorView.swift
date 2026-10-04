//
//  NoteEditorView.swift
//  MinisApp
//
//  [T-notes] 笔记编辑器 —— 原生 TextEditor,零 WebView。
//
//  这是"丝滑"的来源:leonote 那套是 web 编辑器,搬过来光是加载 WebView
//  就几百毫秒,打字还要过一层 JS 桥。这里是 SwiftUI 原生文本视图,
//  打开即用、输入零延迟。
//
//  预览用系统的 AttributedString(markdown:) 渲染,不引第三方 Markdown 库
//  —— 标题、粗体、斜体、行内代码、链接、列表都认,个人笔记够用。
//
//  保存策略:停手 1.2 秒自动存,退出时立即存。不做"每次按键都写盘"
//  (那才是卡的根源),也不让用户自己记得按保存。
//

import SwiftUI

struct NoteEditorView: View {
    let item: CollectedItem
    /// Persist metadata and refresh the list; false keeps the editor's recovery draft.
    var onSaved: (CollectedItem) -> Bool

    @State private var title: String
    @State private var body_: String = ""
    @State private var loaded = false
    /// 上一次**已持久化**的正文/标题。退出时与它比较判断要不要再落一次盘。
    /// 基线必须跟着每次成功落盘走,不能停在初次载入那版:去抖保存已经
    /// 写过中间态、用户又改回原文再退出,和初始基线比是"没改过",
    /// 磁盘却定格在中间那版。
    @State private var lastPersistedBody = ""
    @State private var lastPersistedTitle: String
    @State private var previewing = false
    @State private var showVersions = false
    @State private var saveTask: Task<Void, Never>?
    @State private var saveError: String?
    @State private var isSaving = false
    @State private var editedBeforeLoad = false
    @State private var bodyEditedBeforeLoad = false
    @State private var summarySaveFailed = false
    @FocusState private var bodyFocused: Bool
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    init(item: CollectedItem, onSaved: @escaping (CollectedItem) -> Bool) {
        self.item = item
        self.onSaved = onSaved
        _title = State(initialValue: item.title ?? "")
        _lastPersistedTitle = State(initialValue: item.title ?? "")
    }

    var body: some View {
        VStack(spacing: 0) {
            TextField("标题", text: $title)
                .font(.system(size: 20, weight: .semibold))
                .textFieldStyle(.plain)
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .onChange(of: title) { _, _ in scheduleSave() }

            Divider().padding(.top, 10)

            if let saveError {
                HStack(alignment: .top, spacing: 12) {
                    Text(saveError).font(.footnote).foregroundStyle(.red)
                    Spacer(minLength: 0)
                    Button("重试保存") { Task { _ = await persist() } }
                        .disabled(isSaving || !loaded)
                }
                .padding(.horizontal, 16).padding(.vertical, 8)
                .accessibilityIdentifier("note.save-error")
            }

            if previewing {
                ScrollView {
                    Text(rendered)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .padding(16)
                }
            } else {
                TextEditor(text: $body_)
                    .font(.system(size: 16))
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, 12)
                    .focused($bodyFocused)
                    .onChange(of: body_) { _, _ in
                        if !loaded { bodyEditedBeforeLoad = true }
                        scheduleSave()
                    }
                    .overlay(alignment: .topLeading) {
                        if body_.isEmpty {
                            Text("写点什么…")
                                .foregroundStyle(.tertiary)
                                .padding(.horizontal, 17)
                                .padding(.top, 8)
                                .allowsHitTesting(false)
                        }
                    }
            }
        }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(isSaving ? "保存中…" : "完成") {
                    if !loaded, !editedBeforeLoad { dismiss(); return }
                    Task { if await persist() { dismiss() } }
                }
                .disabled(isSaving)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    previewing.toggle()
                    bodyFocused = false
                } label: {
                    Image(systemName: previewing ? "pencil" : "eye")
                }
                .accessibilityLabel(previewing ? "继续编辑" : "预览")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        showVersions = true
                    } label: { Label("历史版本", systemImage: "clock.arrow.circlepath") }
                    if LocalBrain.shared.isReady, !body_.isEmpty {
                        Button {
                            summarize()
                        } label: { Label("本机生成摘要与标签", systemImage: "sparkles") }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
            ToolbarItem(placement: .keyboard) {
                HStack {
                    Spacer()
                    Button("完成") { bodyFocused = false }
                }
            }
        }
        .sheet(isPresented: $showVersions) {
            NavigationStack {
                NoteVersionsView(fileName: item.bodyFile ?? "") { restored in
                    body_ = restored
                    scheduleSave()
                    showVersions = false
                }
            }
        }
        .task {
            guard !loaded else { return }
            let recovery = NoteBodyStore.loadRecoveryDraft(noteID: item.id)
            let disk: String
            if let file = item.bodyFile { disk = await NoteBodyStore.load(file) }
            else { disk = "" }
            // load 排在共用串行队列里,刚导入一批照片(OCR 写盘)时要等
            // 几秒 —— 期间用户可能已经开始打字。无条件覆盖就是把那两秒
            // 的输入吃掉。用户开打了就以输入为准,回头补存。
            if !bodyEditedBeforeLoad { body_ = recovery?.body ?? disk }
            if !editedBeforeLoad, let recovery { title = recovery.title }
            lastPersistedBody = disk
            loaded = true
            if hasUnsavedChanges {
                if recovery != nil { saveError = String(localized: "已恢复未保存的编辑，将再次尝试保存。") }
                scheduleSave()
            }
        }
        .interactiveDismissDisabled(hasUnsavedChanges || isSaving)
        .alert("摘要与标签未能保存", isPresented: $summarySaveFailed) {
            Button("重新生成") { summarize() }
            Button("取消", role: .cancel) {}
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase != .active, hasUnsavedChanges || isSaving else { return }
            saveTask?.cancel()
            _ = checkpointRecovery()
            Task { _ = await persist() }
        }
        .onDisappear {
            // 退出立即落盘:去抖任务还没到点就被取消,内容就丢了。
            //
            // 关键是**在这里同步取值**再交给 Task:@State 的存储由 SwiftUI
            // 管理,视图从层级里移除后再去读它,拿到的可能已经不是用户最后
            // 输入的内容 —— 那就是"写完退出,内容没了"。取值发生在视图还
            // 活着的这一刻,Task 里只碰局部常量,没有任何不确定性。
            saveTask?.cancel()
            guard hasUnsavedChanges || isSaving else { return }
            _ = checkpointRecovery()
            // 正文还没从磁盘读进来就退出的话,body_ 还是空串 —— 写回去
            // 就是把整篇笔记清空。这个守卫原来在实例方法 persist 里,
            // 重构成静态方法时漏掉了,而 onDisappear 直接调静态版绕过了它。
            // 窗口不是理论上的:笔记正文和 OCR 共用一条串行队列,刚导入
            // 一批照片时这次 load 排在多次写盘之后,是秒级的。
            guard loaded else { return }
            let bodySnapshot = body_
            let titleSnapshot = title
            let target = item
            // 相对上次落盘没有净改动就不写:一是只读打开不该动 updatedAt
            // 把笔记顶到列表最前;二是比较对象必须是"上次已持久化"的内容
            // 而不是初次载入的 —— 否则去抖保存过中间态后改回原文再退出,
            // 会被误判"没改过"而跳过落盘。
            Task { _ = await Self.persist(body: bodySnapshot, title: titleSnapshot,
                                          item: target, onSaved: onSaved) }
        }
    }

    /// Markdown → 富文本。解析失败(极少见)就按纯文本显示,不要空白。
    private var rendered: AttributedString {
        (try? AttributedString(
            markdown: body_,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(body_)
    }

    /// 停手 1.2 秒才写盘。每次按键都存 = 主线程之外也扛不住的磁盘噪音。
    private func scheduleSave() {
        if !loaded { editedBeforeLoad = true }
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled else { return }
            _ = checkpointRecovery()
            try? await Task.sleep(nanoseconds: 850_000_000)
            guard !Task.isCancelled else { return }
            _ = await persist()
        }
    }

    private var hasUnsavedChanges: Bool {
        loaded ? body_ != lastPersistedBody || title != lastPersistedTitle : editedBeforeLoad
    }

    private var recoverySnapshot: NoteBodyStore.RecoveryDraft {
        .init(body: loaded || bodyEditedBeforeLoad ? body_ : nil, title: title, bodyFile: item.bodyFile)
    }

    @discardableResult
    private func checkpointRecovery() -> Bool {
        let saved = NoteBodyStore.saveRecoveryDraft(recoverySnapshot, noteID: item.id)
        if !saved { saveError = String(localized: "恢复草稿未能保存。请保持此页，检查存储空间后重试。") }
        return saved
    }

    @discardableResult
    private func persist() async -> Bool {
        guard loaded, !isSaving else { return false }
        guard hasUnsavedChanges else {
            NoteBodyStore.clearRecoveryDraft(noteID: item.id, matching: recoverySnapshot)
            return true
        }
        isSaving = true
        defer { isSaving = false }
        let bodySnapshot = body_
        let titleSnapshot = title
        let recoverySaved = checkpointRecovery()
        let result = await Self.persist(body: bodySnapshot, title: titleSnapshot, item: item, onSaved: onSaved)
        guard result == .saved else {
            if result == .metadataFailed {
                saveError = recoverySaved
                    ? String(localized: "正文已保存，但标题和笔记信息未能保存。编辑已保留在恢复草稿中，请重试。")
                    : String(localized: "正文已保存，但笔记信息和恢复草稿未能保存。请保持此页，检查存储空间后重试。")
            } else {
                saveError = recoverySaved
                    ? String(localized: "正文未能保存，编辑已保留在本机恢复草稿中。请重试保存。")
                    : String(localized: "正文和恢复草稿都未能保存。请保持此页，检查存储空间后重试。")
            }
            return false
        }
        // 基线跟着落盘走:之后"改回原样再退出"与这版比才是真的没改。
        await MainActor.run {
            lastPersistedBody = bodySnapshot
            lastPersistedTitle = titleSnapshot
            saveError = nil
        }
        // A newer edit may have arrived while the body write was suspended.
        if hasUnsavedChanges { scheduleSave(); return false }
        return true
    }

    /// 静态版本:只吃传进来的值,不读任何 @State。视图已经消失时也能安全跑完。
    enum SaveResult: Equatable {
        case saved, bodyFailed, metadataFailed
    }

    private static func persist(body: String, title: String,
                                item: CollectedItem,
                                onSaved: @escaping (CollectedItem) -> Bool) async -> SaveResult {
        guard let file = item.bodyFile, await NoteBodyStore.save(body, to: file) else { return .bodyFailed }
        // 以库里的**最新版**为基底,而不是编辑器打开那一刻的快照。
        // 否则:生成摘要 → 再敲一个字 → persist 用旧快照重建 → 摘要没了。
        // 编辑器开着时在别处改的置顶/归档/批注同理会被回滚。
        var updated = CollectionStore.load().first { $0.id == item.id } ?? item
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        updated.title = trimmedTitle.isEmpty ? nil : trimmedTitle
        updated.updatedAt = Date()
        // value 存首行摘要,列表和搜索都直接用它,不必去读正文文件
        updated.value = String(body.prefix(200))
        guard await MainActor.run(body: { onSaved(updated) }) else { return .metadataFailed }
        await CollectionSearchIndex.shared.index(
            itemId: updated.id, title: updated.title ?? "", body: body)
        NoteBodyStore.clearRecoveryDraft(noteID: item.id,
            matching: .init(body: body, title: title, bodyFile: item.bodyFile))
        return .saved
    }

    private func summarize() {
        Task {
            guard await persist() else { return }
            guard let insight = await LocalBrain.shared.summarizeCollection(
                title: title, text: body_) else { return }
            var updated = CollectionStore.load().first { $0.id == item.id } ?? item
            updated.summary = insight.summary
            if !insight.tags.isEmpty { updated.tags = insight.tags }
            updated.updatedAt = Date()
            if !onSaved(updated) { summarySaveFailed = true }
        }
    }
}

// MARK: - 历史版本

private struct NoteVersionsView: View {
    let fileName: String
    var onRestore: (String) -> Void

    @State private var versions: [NoteBodyStore.Version] = []
    /// 预读的每版首行。原来在 List 行里直接调 readVersion(同步磁盘 IO),
    /// 每行还调两次 —— 十版就是二十次主线程读盘,滚动能感觉到顿。
    @State private var snippets: [String: String] = [:]
    @State private var previewText: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            if versions.isEmpty {
                Text("还没有历史版本。每次保存会自动留一份,最多保留 10 版。")
                    .font(.callout).foregroundStyle(.secondary)
            }
            ForEach(versions) { version in
                Button {
                    previewText = NoteBodyStore.readVersion(version)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(version.savedAt.formatted(date: .abbreviated, time: .shortened))
                            .font(.system(size: 15))
                        Text(snippets[version.id] ?? "")
                            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .navigationTitle("历史版本")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("关闭") { dismiss() }
            }
        }
        .task {
            // .task 继承视图的 MainActor —— 扫目录 + 逐个读文件全在主线程。
            // 挪进后台队列再回来。
            let (found, previews) = await NoteBodyStore.versionsWithPreviews(of: fileName)
            versions = found
            snippets = previews
        }
        .sheet(isPresented: Binding(get: { previewText != nil },
                                    set: { if !$0 { previewText = nil } })) {
            NavigationStack {
                ScrollView {
                    Text(previewText ?? "")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .padding()
                }
                .navigationTitle("这一版")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("取消") { previewText = nil }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("恢复这一版") {
                            if let text = previewText { onRestore(text) }
                            previewText = nil
                        }
                    }
                }
            }
        }
    }
}
