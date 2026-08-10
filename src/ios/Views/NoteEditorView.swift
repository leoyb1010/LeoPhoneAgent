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
    /// 保存后回调,让列表刷新标题/时间。
    var onSaved: (CollectedItem) -> Void

    @State private var title: String
    @State private var body_: String = ""
    @State private var loaded = false
    @State private var previewing = false
    @State private var showVersions = false
    @State private var saveTask: Task<Void, Never>?
    @FocusState private var bodyFocused: Bool
    @Environment(\.dismiss) private var dismiss

    init(item: CollectedItem, onSaved: @escaping (CollectedItem) -> Void) {
        self.item = item
        self.onSaved = onSaved
        _title = State(initialValue: item.title ?? "")
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
                    .onChange(of: body_) { _, _ in scheduleSave() }
                    .overlay(alignment: .topLeading) {
                        if body_.isEmpty {
                            Text("写点什么…支持 Markdown")
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
            guard !loaded, let file = item.bodyFile else { loaded = true; return }
            body_ = await NoteBodyStore.load(file)
            loaded = true
        }
        .onDisappear {
            // 退出立即落盘:去抖任务还没到点就被取消,内容就丢了。
            //
            // 关键是**在这里同步取值**再交给 Task:@State 的存储由 SwiftUI
            // 管理,视图从层级里移除后再去读它,拿到的可能已经不是用户最后
            // 输入的内容 —— 那就是"写完退出,内容没了"。取值发生在视图还
            // 活着的这一刻,Task 里只碰局部常量,没有任何不确定性。
            saveTask?.cancel()
            let bodySnapshot = body_
            let titleSnapshot = title
            let target = item
            Task { await Self.persist(body: bodySnapshot, title: titleSnapshot,
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
        guard loaded else { return }
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            guard !Task.isCancelled else { return }
            await persist()
        }
    }

    private func persist() async {
        guard loaded else { return }
        await Self.persist(body: body_, title: title, item: item, onSaved: onSaved)
    }

    /// 静态版本:只吃传进来的值,不读任何 @State。视图已经消失时也能安全跑完。
    private static func persist(body: String, title: String,
                                item: CollectedItem,
                                onSaved: @escaping (CollectedItem) -> Void) async {
        guard let file = item.bodyFile else { return }
        await NoteBodyStore.save(body, to: file)
        var updated = item
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        updated.title = trimmedTitle.isEmpty ? nil : trimmedTitle
        updated.updatedAt = Date()
        // value 存首行摘要,列表和搜索都直接用它,不必去读正文文件
        updated.value = String(body.prefix(200))
        await MainActor.run { onSaved(updated) }
        await CollectionSearchIndex.shared.index(
            itemId: updated.id, title: updated.title ?? "", body: body)
    }

    private func summarize() {
        Task {
            guard let insight = await LocalBrain.shared.summarizeCollection(
                title: title, text: body_) else { return }
            var updated = item
            updated.summary = insight.summary
            if !insight.tags.isEmpty { updated.tags = insight.tags }
            updated.updatedAt = Date()
            await MainActor.run { onSaved(updated) }
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
            let found = NoteBodyStore.versions(of: fileName)
            var previews: [String: String] = [:]
            for version in found {
                previews[version.id] = String(NoteBodyStore.readVersion(version).prefix(60))
            }
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
