//
//  CollectionsView.swift
//  MinisApp
//
//  [T-collections] 收藏页:任意 app 分享/粘贴进来的链接、图片、文本。
//
//  链接的标题/封面在这里惰性补抓(LPMetadataProvider)——分享扩展进程
//  内存受限不做抓取,主 app 打开本页时补,结果缓存进条目,只抓一次。
//
//  三个交互决定:
//  1) 点击 = 回到内容原处(链接走 UIApplication.open,装了小红书就跳
//     小红书 app;没有对应 app 才落到浏览器)。应用内预览退到长按菜单。
//  2) 删除走 .onDelete + 编辑模式多选 + 长按菜单三条路——之前只挂
//     .swipeActions 且行上有 .onTapGesture,手势被 tap 吞掉,删不动。
//  3) 导入:很多 app(小红书)只给"复制链接"不给系统分享,所以收藏
//     必须能从剪贴板进。PasteButton 是唯一不弹权限提示的读剪贴板方式。
//

import LinkPresentation
import SafariServices
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

private enum TreasuryView: String, CaseIterable, Identifiable {
    case inbox, processing, failed, unread, recent, all
    var id: String { rawValue }
    var title: String {
        switch self {
        case .inbox: "收件箱"
        case .processing: "处理中"
        case .failed: "失败"
        case .unread: "待读"
        case .recent: "最近使用"
        case .all: "全部"
        }
    }
}

struct CollectionsView: View {
    @State private var items: [CollectedItem] = []
    @State private var query = ""
    @State private var filterSource: String? = nil
    @State private var previewItem: CollectedItem?
    /// [T-reader] 应用内阅读器目标。跳不了原 app 的链接都在这里读,
    /// 不再甩去外部 Safari。
    @State private var readerTarget: ReaderTarget?
    /// [T-notes] 正在编辑的笔记
    @State private var editingNote: CollectedItem?
    /// [T-notes] 正在写批注的条目
    @State private var annotating: CollectedItem?
    @State private var readingItem: CollectedItem?
    @State private var pendingReadingItem: CollectedItem?
    @State private var selectedReadingItemID: String?
    @State private var annotationDraft = ""
    /// [T-notes] 显示归档的条目(默认收起)
    @State private var showArchived = false
    @State private var treasuryView = TreasuryView.inbox
    // [T-attachments] 三条导入入口
    @State private var showFileImporter = false
    @State private var showScanner = false
    @State private var photoSelection: [PhotosPickerItem] = []
    @State private var importing = false
    @State private var showPhotoPicker = false
    @State private var showImportSheet = false
    @State private var selection = Set<String>()
    @State private var editMode: EditMode = .inactive
    @State private var toast: String?
    @State private var toastID = UUID()
    /// [T-collections-fulltext] 当前查询在全文索引里的命中(条目 id)。
    @State private var fullTextMatches: [String] = []
    @State private var fullTextSnippets: [String: String] = [:]
    @State private var indexing = false
    @State private var searchTask: Task<Void, Never>?
    @AppStorage(CollectionStore.defaultActionKey, store: SharedContainerStore.sharedDefaults)
    private var defaultAction = "ask"
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private var sources: [String] {
        Array(Set(items.map(\.sourceLabel))).sorted()
    }

    private var visible: [CollectedItem] {
        let spec = TreasuryLocalQuery.parse(query)
        // [T-notes] 归档的默认不出现在主列表 —— 归档就是"收起来但不删"
        var out = (showArchived || spec.archived) ? items.filter(\.archived) : items.filter { !$0.archived }
        out = out.filter { item in
            switch treasuryView {
            case .inbox: item.lastOpenedAt == nil
            case .processing: ["saved", "queued", "processing"].contains(item.processingState)
            case .failed: ["partial", "failed"].contains(item.processingState)
            case .unread: item.readingState == "unread"
            case .recent: item.lastOpenedAt != nil
            case .all: true
            }
        }
        if !spec.kinds.isEmpty { out = out.filter { spec.kinds.contains($0.treasuryKind) } }
        if !spec.processingStates.isEmpty { out = out.filter { spec.processingStates.contains($0.processingState) } }
        if !spec.readingStates.isEmpty { out = out.filter { spec.readingStates.contains($0.readingState) } }
        if !spec.tags.isEmpty {
            out = out.filter { item in
                let tags = Set(item.tags.map { $0.lowercased() })
                return spec.tags.isSubset(of: tags)
            }
        }
        if let pinned = spec.pinned { out = out.filter { $0.pinned == pinned } }
        if let after = spec.after { out = out.filter { $0.createdAt >= after } }
        if let before = spec.before { out = out.filter { $0.createdAt < before } }
        if let filterSource { out = out.filter { $0.sourceLabel == filterSource } }
        let q = spec.textQuery.lowercased()
        if !q.isEmpty {
            // [T-collections-fulltext] 元数据没命中,再问全文索引——
            // "上周存的那篇讲 X 的" 靠的就是这一步。
            let fullTextHits = Set(fullTextMatches)
            out = out.filter {
                ($0.title ?? "").lowercased().contains(q)
                    || $0.value.lowercased().contains(q)
                    || ($0.summary ?? "").lowercased().contains(q)
                    || $0.tags.joined().lowercased().contains(q)
                    || ($0.annotation ?? "").lowercased().contains(q)
                    || fullTextHits.contains($0.id)
            }
        }
        return out.sorted { a, b in
            if a.pinned != b.pinned { return a.pinned }
            if treasuryView == .recent || spec.recent {
                return (a.lastOpenedAt ?? .distantPast) > (b.lastOpenedAt ?? .distantPast)
            }
            // 笔记会被反复编辑,按最后改动排;收藏类 updatedAt 等于创建时间
            return a.updatedAt > b.updatedAt
        }
    }

    var body: some View {
        GeometryReader { geometry in
            let usesSplit = TreasuryWorkspaceLayoutPolicy.usesSplit(
                width: geometry.size.width,
                regularWidth: horizontalSizeClass == .regular)
            Group {
                if usesSplit {
                    NavigationSplitView {
                        collectionList(usesSplit: true)
                    } detail: {
                        splitReadingDetail
                    }
                } else {
                    collectionList(usesSplit: false)
                }
            }
        }
    }

    private func collectionList(usesSplit: Bool) -> some View {
        List(selection: $selection) {
            if !editMode.isEditing {
                treasuryHero
                captureActions
                treasuryViewPicker
                importRow
            }
            if items.isEmpty {
                emptyState
            } else if visible.isEmpty {
                // 判据必须是 visible 而不是 items:切到"查看归档"却没有
                // 归档条目时,items 非空 → 不走 emptyState → 页面只剩几个
                // 筛选胶囊和一片空白,没有任何解释。
                Text(showArchived ? "归档里还没有东西。左滑任意条目可以归档。"
                                  : "没有匹配的内容。")
                    .font(.callout).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 28)
                    .listRowSeparator(.hidden)
            } else {
                if sources.count > 1 { sourceFilter }
                ForEach(visible) { item in
                    row(item, usesSplit: usesSplit)
                        .listRowInsets(EdgeInsets(top: 5, leading: 14, bottom: 5, trailing: 14))
                        .listRowSeparator(.hidden)
                        .listRowBackground(
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .fill(LeoTheme.ColorToken.surface)
                                .padding(.vertical, 2)
                        )
                }
                .onDelete { offsets in
                    // visible 是计算属性,搜索防抖会在 MainActor 上异步改
                    // fullTextMatches;若恰好落在渲染与回调之间,数组会变短。
                    let ids = Set(offsets.compactMap {
                        visible.indices.contains($0) ? visible[$0].id : nil
                    })
                    purge(ids)
                }
            }
        }
        .environment(\.editMode, $editMode)
        .navigationTitle(editMode.isEditing && !selection.isEmpty ? "已选 \(selection.count) 条" : "藏宝阁")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "搜索收藏(含正文)")
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(LeoTheme.ColorToken.groupedBackground)
        .dropDestination(for: URL.self) { urls, _ in
            handleDroppedURLs(urls)
            return !urls.isEmpty
        }
        .dropDestination(for: String.self) { values, _ in
            handleDroppedText(values)
            return !values.isEmpty
        }
        .onChange(of: query) { _, newValue in
            // 防抖 250ms 再查:FTS 查询别跟着每一次击键跑
            searchTask?.cancel()
            searchTask = Task {
                try? await Task.sleep(nanoseconds: 250_000_000)
                guard !Task.isCancelled else { return }
                let hits = await CollectionSearchIndex.shared.search(TreasuryLocalQuery.parse(newValue).textQuery)
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    fullTextMatches = hits.map(\.itemId)
                    fullTextSnippets = Dictionary(hits.map { ($0.itemId, $0.snippet) },
                                                  uniquingKeysWith: { a, _ in a })
                }
            }
        }
        .refreshable { reload() }
        // [T-treasury-ui] 条目的进出与重排(置顶跳到最前、归档滑走、删除
        // 收起)都走弹簧,不再瞬间跳变。items 是 Equatable,代价可控。
        .animation(LeoMotion.smooth(reduceMotion: reduceMotion, duration: 0.3), value: items)
        .animation(LeoMotion.snappy(reduceMotion: reduceMotion), value: showArchived)
        .toolbar { toolbarContent }
        // [T-attachments] 相册:PhotosPicker 走系统选择器,不必申请相册权限
        .photosPicker(isPresented: $showPhotoPicker, selection: $photoSelection,
                      maxSelectionCount: 9, matching: .images)
        .onChange(of: photoSelection) { _, picked in
            guard !picked.isEmpty else { return }
            importPhotos(picked)
        }
        .fileImporter(isPresented: $showFileImporter,
                      allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { importFiles(urls) }
        }
        .fullScreenCover(isPresented: $showScanner) {
            DocumentScannerView { pages in
                showScanner = false
                guard !pages.isEmpty else { return }
                importScans(pages)
            }
            .ignoresSafeArea()
        }
        .sheet(item: $previewItem) { CollectionPreviewSheet(item: $0) }
        .sheet(item: $editingNote) { note in
            NavigationStack {
                NoteEditorView(item: note) { updated in
                    CollectionStore.update(updated)
                    reload()
                }
            }
        }
        .sheet(item: $annotating) { target in
            NavigationStack {
                Form {
                    Section {
                        TextField("写下你的想法…", text: $annotationDraft, axis: .vertical)
                            .lineLimit(4...12)
                    } header: {
                        Text("批注")
                    } footer: {
                        Text(target.title ?? target.value)
                            .lineLimit(2)
                    }
                }
                .navigationTitle("批注")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("取消") { annotating = nil }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("保存") { saveAnnotation(for: target) }
                    }
                }
            }
            .presentationDetents([.medium])
        }
        .sheet(item: $readingItem, onDismiss: {
            guard let pending = pendingReadingItem else { return }
            pendingReadingItem = nil
            Task { @MainActor in readingItem = pending }
        }) { item in
            TreasuryReadingSheet(
                item: item,
                relatedItems: TreasuryService.related(to: item, items: items)
            ) { related in
                pendingReadingItem = related
                readingItem = nil
            } onUpdate: {
                reload()
            }
        }
        .fullScreenCover(item: $readerTarget) { target in
            LeoReaderView(url: target.url, preferReaderMode: target.preferReaderMode)
                .ignoresSafeArea()
        }
        .sheet(isPresented: $showImportSheet) {
            CollectionImportSheet { added in
                reload()
                processPendingJobs()
                flash("已收藏 \(added) 条")
            }
        }
        .overlay(alignment: .bottom) {
            if let toast {
                HStack(spacing: 7) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(.green)
                    Text(toast).font(.system(size: 13, weight: .semibold))
                }
                .padding(.horizontal, 16).padding(.vertical, 10)
                .background(.regularMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(.quaternary, lineWidth: 0.5))
                .shadow(color: .black.opacity(0.10), radius: 12, y: 4)
                .padding(.bottom, 24)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .onAppear {
            reload()
            processPendingJobs()
        }
    }

    @ViewBuilder
    private var splitReadingDetail: some View {
        if let id = selectedReadingItemID,
           let item = items.first(where: { $0.id == id }) {
            TreasuryReadingSheet(
                item: item,
                relatedItems: TreasuryService.related(to: item, items: items),
                showsCloseButton: false,
                onOpenOriginal: splitOpenAction(for: item)
            ) { related in
                selectedReadingItemID = related.id
            } onUpdate: {
                reload()
            }
            .id(item.id)
        } else {
            ContentUnavailableView(
                "选择一条收藏",
                systemImage: "sidebar.left",
                description: Text("在左侧选择内容，即可阅读正文、更新进度并添加高亮。")
            )
        }
    }

    private func splitOpenAction(for item: CollectedItem) -> (() -> Void)? {
        guard item.kind != .text else { return nil }
        return { open(item) }
    }

    private var treasuryHero: some View {
        let activeCount = items.filter { !$0.archived }.count
        let noteCount = items.filter { !$0.archived && $0.kind == .note }.count
        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "sparkles.rectangle.stack.fill")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(.orange)
                    .frame(width: 44, height: 44)
                    .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                VStack(alignment: .leading, spacing: 4) {
                    Text("你的可调用记忆")
                        .font(.headline.weight(.bold))
                    Text("收藏、笔记、扫描与文件会统一索引，随时交给 Agent 继续工作。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: 0) {
                treasuryMetric(value: activeCount, label: "内容")
                Divider().frame(height: 28)
                treasuryMetric(value: noteCount, label: "笔记")
                Divider().frame(height: 28)
                treasuryMetric(value: sources.count, label: "来源")
            }
        }
        .padding(16)
        .background(LeoTheme.ColorToken.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.orange.opacity(0.16), lineWidth: 0.5)
        }
        .listRowInsets(EdgeInsets(top: 10, leading: 14, bottom: 5, trailing: 14))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .leoStaggerEntrance(index: 0)
    }

    private func treasuryMetric(value: Int, label: String) -> some View {
        VStack(spacing: 2) {
            Text("\(value)")
                .font(.headline.monospacedDigit().weight(.bold))
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    private var captureActions: some View {
        let columns = Array(repeating: GridItem(.flexible(), spacing: 8), count: 4)
        return LazyVGrid(columns: columns, spacing: 8) {
            treasuryAction("笔记", icon: "square.and.pencil", tint: .indigo, index: 0) { newNote() }
            treasuryAction("粘贴", icon: "doc.on.clipboard", tint: .orange, index: 1) { showImportSheet = true }
            treasuryAction("扫描", icon: "doc.viewfinder", tint: .teal, index: 2) { showScanner = true }
            Menu {
                Button { showPhotoPicker = true } label: { Label("从相册导入", systemImage: "photo.on.rectangle") }
                Button { showFileImporter = true } label: { Label("从文件导入", systemImage: "folder") }
            } label: {
                treasuryActionLabel("导入", icon: "square.and.arrow.down", tint: .blue)
            }
            .buttonStyle(LeoSquishButtonStyle())
            .leoStaggerEntrance(index: 3)
        }
        .listRowInsets(EdgeInsets(top: 5, leading: 14, bottom: 5, trailing: 14))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }

    private var treasuryViewPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(TreasuryView.allCases) { view in
                    Button {
                        withAnimation(LeoMotion.snappy(reduceMotion: reduceMotion)) {
                            treasuryView = view
                            if view != .all { showArchived = false }
                        }
                    } label: {
                        Text(view.title)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(treasuryView == view ? Color.white : Color.primary)
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(treasuryView == view ? Color.orange : LeoTheme.ColorToken.surface,
                                        in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(treasuryView == view ? .isSelected : [])
                }
            }
            .padding(.horizontal, 14)
        }
        .listRowInsets(EdgeInsets())
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }

    private func treasuryAction(
        _ title: String,
        icon: String,
        tint: Color,
        index: Int,
        action: @escaping () -> Void
    ) -> some View {
        Button {
            LeoHaptics.impact(.light)
            action()
        } label: {
            treasuryActionLabel(title, icon: icon, tint: tint)
        }
        .buttonStyle(LeoSquishButtonStyle())
        .leoStaggerEntrance(index: index)
    }

    private func treasuryActionLabel(_ title: String, icon: String, tint: Color) -> some View {
        VStack(spacing: 7) {
            Image(systemName: icon)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(tint)
            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.primary)
        }
        .frame(maxWidth: .infinity, minHeight: 62)
        .background(LeoTheme.ColorToken.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    // MARK: 行

    private func row(_ item: CollectedItem, usesSplit: Bool) -> some View {
        Button {
            if usesSplit, !editMode.isEditing {
                selectedReadingItemID = item.id
            } else {
                open(item)
            }
        } label: {
            CollectionCard(item: item)
        }
        .buttonStyle(.plain)
        .tag(item.id)
        .contextMenu {
            Button {
                open(item)
            } label: { Label(item.kind == .link ? "在原 App 打开" : "打开", systemImage: "arrow.up.forward.app") }
            if item.kind == .link {
                Button {
                    previewItem = item
                } label: { Label("在应用内预览", systemImage: "safari") }
                Button {
                    UIPasteboard.general.string = item.value
                    flash("链接已复制")
                } label: { Label("拷贝链接", systemImage: "doc.on.doc") }
            }
            Button {
                sendToAgent(item, prompt: nil)
            } label: { Label("发给 Agent", systemImage: "paperplane.fill") }
            if item.kind != .file {
                Button {
                    if usesSplit {
                        selectedReadingItemID = item.id
                    } else {
                        readingItem = item
                    }
                } label: { Label("阅读与高亮", systemImage: "highlighter") }
            }
            Button {
                sendToAgent(item, prompt: "用一两句话总结这条收藏的内容要点。")
            } label: { Label("让 Agent 总结", systemImage: "sparkles") }
            if TreasuryEnhancementPolicy.canRetry(
                kind: item.kind, errorCode: item.processingErrorCode
            ) {
                Button {
                    retryProcessing(item)
                } label: { Label("重试处理", systemImage: "arrow.clockwise") }
            }
            Button {
                var updated = item
                updated.pinned.toggle()
                CollectionStore.update(updated)
                reload()
            } label: {
                Label(item.pinned ? "取消置顶" : "置顶", systemImage: item.pinned ? "pin.slash" : "pin")
            }
            Divider()
            Button(role: .destructive) {
                purge([item.id])
            } label: { Label("删除", systemImage: "trash") }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button(role: .destructive) {
                purge([item.id])
            } label: { Label("删除", systemImage: "trash") }
        }
        .swipeActions(edge: .trailing) {
            Button {
                var updated = item
                updated.archived.toggle()
                updated.updatedAt = Date()
                CollectionStore.update(updated)
                reload()
            } label: {
                Label(item.archived ? "取消归档" : "归档",
                      systemImage: item.archived ? "tray.and.arrow.up" : "archivebox")
            }
            .tint(.gray)
        }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button {
                sendToAgent(item, prompt: nil)
            } label: { Label("发给 Agent", systemImage: "paperplane.fill") }
                .tint(.indigo)
            Button {
                var updated = item
                updated.pinned.toggle()
                CollectionStore.update(updated)
                reload()
            } label: {
                Label(item.pinned ? "取消置顶" : "置顶",
                      systemImage: item.pinned ? "pin.slash" : "pin")
            }
            .tint(.orange)
            Button {
                annotationDraft = item.annotation ?? ""
                annotating = item
            } label: { Label("批注", systemImage: "text.bubble") }
                .tint(.teal)
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            if editMode.isEditing {
                Button("完成") {
                    withAnimation { editMode = .inactive; selection = [] }
                }
            } else {
                Menu {
                    Button {
                        withAnimation { showArchived.toggle() }
                    } label: {
                        Label(showArchived ? "回到收藏" : "查看归档",
                              systemImage: showArchived ? "tray.full" : "archivebox")
                    }
                    Button {
                        withAnimation { editMode = .active }
                    } label: { Label("选择", systemImage: "checkmark.circle") }
                    Divider()
                    Picker("分享时的默认动作", selection: $defaultAction) {
                        Text("每次询问").tag("ask")
                        Text("总是发到对话").tag("chat")
                        Text("总是收藏(不打断)").tag("collect")
                    }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        ToolbarItem(placement: .bottomBar) {
            if editMode.isEditing {
                HStack(spacing: 24) {
                    Button {
                        let chosen = items.filter { selection.contains($0.id) }
                        sendToAgent(chosen, prompt: nil)
                    } label: {
                        Label("发给 Agent", systemImage: "paperplane.fill")
                    }
                    .disabled(selection.isEmpty)

                    Button(role: .destructive) {
                        purge(selection)
                        selection = []
                    } label: {
                        Label("删除所选", systemImage: "trash")
                    }
                    .disabled(selection.isEmpty)
                }
            }
        }
    }

    /// 剪贴板里有链接时的一键收藏条。PasteButton 不触发"允许粘贴"提示。
    @ViewBuilder
    private var importRow: some View {
        if !editMode.isEditing, UIPasteboard.general.hasURLs || UIPasteboard.general.hasStrings {
            HStack(spacing: 12) {
                Image(systemName: "doc.on.clipboard.fill")
                    .font(.system(size: 15))
                    .foregroundStyle(.white)
                    .frame(width: 34, height: 34)
                    .background(.orange.gradient, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text("剪贴板里有内容").font(.system(size: 14, weight: .semibold))
                    Text("小红书等只给「复制链接」的 app,从这里收")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                PasteButton(payloadType: String.self) { strings in
                    let added = strings.reduce(0) { $0 + CollectionStore.ingestText($1) }
                    Task { @MainActor in
                        reload()
                        processPendingJobs()
                        flash(added > 0 ? "已收藏 \(added) 条" : "剪贴板里没有可收藏的内容")
                    }
                }
                .labelStyle(.iconOnly)
                .buttonBorderShape(.capsule)
                .tint(.orange)
            }
            .padding(.vertical, 2)
            .listRowBackground(Color.orange.opacity(0.07))
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "shippingbox")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(.linearGradient(colors: [.orange, .pink],
                                                 startPoint: .topLeading,
                                                 endPoint: .bottomTrailing))
                .symbolEffect(.bounce, options: .nonRepeating)
            Text("藏宝阁还是空的")
                .font(.system(size: 17, weight: .semibold))
            // 不放按钮:入口已经有右上角「+」和剪贴板条,这里再放一对
    // 就是重复;空状态只负责指路,页面属于内容本身。
            Text("在任意 app 分享给 LeoPhoneAgent\n或用上方四种方式开始")
                .font(.system(size: 14))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 56)
        .listRowSeparator(.hidden)
    }

    private var sourceFilter: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                filterChip(nil, label: "全部")
                ForEach(sources, id: \.self) { filterChip($0, label: $0) }
            }
        }
        .listRowSeparator(.hidden)
    }

    private func filterChip(_ source: String?, label: String) -> some View {
        let selected = filterSource == source
        return Button {
            withAnimation(.snappy(duration: 0.25)) { filterSource = source }
            LeoHaptics.selection()
        } label: {
            Text(label)
                .font(.system(size: 13, weight: selected ? .semibold : .medium))
                .foregroundStyle(selected ? Color.white : .primary)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(selected ? Color.accentColor : Color.secondary.opacity(0.1),
                            in: Capsule())
        }
        .buttonStyle(.plain)
    }

    // MARK: 行为

    // MARK: - [T-attachments] 导入

    private func importPhotos(_ picked: [PhotosPickerItem]) {
        photoSelection = []
        runImport(count: picked.count) {
            var made: [CollectedItem] = []
            for pick in picked {
                guard let data = try? await pick.loadTransferable(type: Data.self),
                      let image = UIImage(data: data) else { continue }
                if let item = await AttachmentImporter.importImage(image, sourceLabel: "相册") {
                    made.append(item)
                }
            }
            return made
        }
    }

    private func importFiles(_ urls: [URL]) {
        runImport(count: urls.count) {
            var made: [CollectedItem] = []
            for url in urls {
                if let item = await AttachmentImporter.importFile(at: url) { made.append(item) }
            }
            return made
        }
    }

    /// iPad multi-window drag and drop uses the exact same capture pipeline as
    /// Files/Share Extension: URLs save immediately; file bytes are copied into
    /// the managed Treasury directory before the provider's temporary grant ends.
    private func handleDroppedURLs(_ urls: [URL]) {
        var links: [CollectedItem] = []
        var files: [URL] = []
        for url in urls {
            if let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" {
                links.append(CollectedItem(kind: .link, value: url.absoluteString,
                                           sourceLabel: CollectionStore.sourceLabel(forHost: url.host)))
            } else if url.isFileURL {
                files.append(url)
            }
        }
        if !links.isEmpty {
            CollectionStore.add(links)
            reload()
            processPendingJobs()
            flash("已收藏 \(links.count) 条链接")
        }
        if !files.isEmpty { importFiles(files) }
    }

    private func handleDroppedText(_ values: [String]) {
        let made = values.compactMap { raw -> CollectedItem? in
            let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            if let url = URL(string: text), let scheme = url.scheme?.lowercased(),
               scheme == "http" || scheme == "https" {
                return CollectedItem(kind: .link, value: text,
                                     sourceLabel: CollectionStore.sourceLabel(forHost: url.host))
            }
            return CollectedItem(kind: .text, value: String(text.prefix(2_000_000)), sourceLabel: "文本")
        }
        guard !made.isEmpty else { return }
        CollectionStore.add(made)
        reload()
        processPendingJobs()
        flash("已收藏 \(made.count) 条")
    }

    private func importScans(_ pages: [UIImage]) {
        runImport(count: pages.count) {
            var made: [CollectedItem] = []
            for page in pages {
                if let item = await AttachmentImporter.importImage(page, sourceLabel: "扫描件") {
                    made.append(item)
                }
            }
            return made
        }
    }

    /// 导入的公共外壳:防重入、进度提示、失败如实说。
    private func runImport(count: Int, _ work: @escaping () async -> [CollectedItem]) {
        guard !importing else { return }
        importing = true
        flash("正在导入 \(count) 项…", autoHide: false)
        Task {
            let made = await work()
            await MainActor.run {
                importing = false
                if made.isEmpty {
                    flash("没能导入(格式不支持或读取失败)")
                } else {
                    CollectionStore.add(made)
                    reload()
                    processPendingJobs()
                    flash("已导入 \(made.count) 项")
                }
            }
        }
    }

    /// [T-notes] 新建一条空笔记并直接进编辑器。
    private func newNote() {
        let note = CollectedItem.newNote()
        CollectionStore.add([note])
        reload()
        editingNote = note
    }

    /// 批注保存:进条目、也进全文索引(想法本身就该能搜到)。
    private func saveAnnotation(for target: CollectedItem) {
        var updated = target
        let text = annotationDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        updated.annotation = text.isEmpty ? nil : text
        updated.updatedAt = Date()
        CollectionStore.update(updated)
        annotating = nil
        reload()
        // 不写全文索引:index() 是先删后插,这一写会把已抽取的几万字
        // 文章正文替换成"URL+批注"两行,而 indexedIds 里 id 还在,
        // 永不重抽 —— 损失不可逆。批注本身走内存过滤已经能搜到。
    }

    private func reload() {
        items = CollectionStore.load()
        syncToRelay()
    }

    /// [T-treasury-sync] Run the cursor-based change exchange. The client
    /// coalesces overlapping requests and automatically performs another pass
    /// if a local reload happens while network I/O is in flight.
    private func syncToRelay() {
        Task {
            guard let client = GatewayHostStore.shared.activeHosts
                .compactMap({ GatewayHostStore.shared.client(for: $0) })
                .first(where: { $0.relayEventsURL != nil }) else { return }
            await client.syncTreasuryChanges()
        }
    }

    /// 删除条目时把全文索引与系统搜索一并清掉——只删一半会留下
    /// "搜得到但打不开"的幽灵。
    private func purge(_ ids: Set<String>) {
        CollectionStore.delete(ids: ids)
        if let selectedReadingItemID, ids.contains(selectedReadingItemID) {
            self.selectedReadingItemID = nil
        }
        Task {
            for id in ids { await CollectionSearchIndex.shared.remove(itemId: id) }
            await CollectionSearchIndex.shared.unpublishFromSpotlight(ids: ids)
        }
        reload()
    }

    /// Consume the durable SQLite queue serially. Share Extension captures
    /// only save bytes and enqueue work; the main app owns enhancement. Job
    /// claims, retry counts and backoff therefore survive process death.
    private func processPendingJobs() {
        guard !indexing else { return }
        let jobs = CollectionStore.pendingJobs(limit: 20)
        guard !jobs.isEmpty else { return }
        indexing = true
        Task {
            defer { Task { @MainActor in indexing = false } }
            var batch = jobs
            while !batch.isEmpty, !Task.isCancelled {
                for job in batch {
                    guard CollectionStore.claimJob(id: job.id) else { continue }
                    guard let item = CollectionStore.load().first(where: { $0.id == job.itemID }) else {
                        CollectionStore.completeJob(id: job.id)
                        continue
                    }
                    CollectionStore.mutate(id: item.id) { current in
                        current.processingState = "processing"
                        current.processingErrorCode = nil
                    }
                    switch job.type {
                    case "metadata":
                        await processMetadataJob(job, item: item)
                    case "index":
                        await processIndexJob(job, item: item)
                    default:
                        CollectionStore.failJob(id: job.id, errorCode: "unsupported_type")
                        CollectionStore.mutate(id: item.id) { current in
                            current.processingState = "failed"
                            current.processingErrorCode = "unsupported_type"
                            current.updatedAt = Date()
                        }
                    }
                }
                batch = CollectionStore.pendingJobs(limit: 20)
            }
            let snapshot = CollectionStore.load()
            await CollectionSearchIndex.shared.publishToSpotlight(snapshot)
            await MainActor.run { reload() }
        }
    }

    private func processMetadataJob(_ job: CollectionStore.Job,
                                    item original: CollectedItem) async {
        guard original.kind == .link, let url = URL(string: original.value) else {
            CollectionStore.failJob(id: job.id, errorCode: "source_unreachable")
            CollectionStore.mutate(id: original.id) { current in
                current.processingState = "failed"
                current.processingErrorCode = "source_unreachable"
                current.updatedAt = Date()
            }
            return
        }
        var item = original
        let capturedTitle = item.title
        if item.resolvedURL == nil, CollectionOpener.isShortLink(url) {
            let resolved = await CollectionOpener.resolve(url)
            if resolved != url { item.resolvedURL = resolved.absoluteString }
        }
        let target = item.resolvedURL.flatMap(URL.init(string:)) ?? url
        let preview = await LinkPreviewFetcher.fetch(target)
        if let image = preview.image, let thumbDir = CollectionStore.thumbsDirectory {
            let name = "thumb-\(item.id).jpg"
            let resized = image.leoResized(maxDimension: 480)
            if let data = resized.jpegData(compressionQuality: 0.8) {
                try? data.write(to: thumbDir.appendingPathComponent(name), options: .atomic)
                item.thumbnailFile = name
            }
        }
        if item.summary == nil {
            let material = [preview.title ?? item.title, item.value]
                .compactMap { $0 }.joined(separator: "\n")
            if let insight = await LocalBrain.shared.summarizeCollection(
                title: preview.title ?? item.title, text: material
            ) {
                item.summary = insight.summary
                if item.tags.isEmpty { item.tags = insight.tags }
            }
        }
        let captured = item
        CollectionStore.mutate(id: item.id) { current in
            current.metadataFetched = true
            if current.resolvedURL == nil { current.resolvedURL = captured.resolvedURL }
            if let fetched = preview.title, !fetched.isEmpty,
               TreasuryEnhancementPolicy.shouldReplaceTitle(
                current: current.title, captured: capturedTitle
               ) {
                current.title = fetched
            }
            if let thumbnail = captured.thumbnailFile { current.thumbnailFile = thumbnail }
            if current.summary == nil {
                current.summary = captured.summary
                if current.tags.isEmpty { current.tags = captured.tags }
            }
            current.processingState = "queued"
            current.processingErrorCode = nil
            current.updatedAt = Date()
        }
        CollectionStore.completeJob(id: job.id)
    }

    private func processIndexJob(_ job: CollectionStore.Job,
                                 item: CollectedItem) async {
        let body: String?
        var title = item.title ?? ""
        if item.kind == .link {
            let indexed = await CollectionSearchIndex.shared.indexedIds()
            if indexed.contains(item.id) {
                CollectionStore.completeJob(id: job.id)
                CollectionStore.mutate(id: item.id) { current in
                    current.processingState = "ready"
                    current.processingErrorCode = nil
                    current.updatedAt = Date()
                }
                return
            }
            let target = item.resolvedURL.flatMap(URL.init(string:)) ?? URL(string: item.value)
            guard let target, let article = await ArticleExtractor.shared.extract(url: target) else {
                CollectionStore.failJob(
                    id: job.id, errorCode: "article_extraction_unavailable"
                )
                CollectionStore.mutate(id: item.id) { current in
                    current.processingState = "partial"
                    current.processingErrorCode = "article_extraction_unavailable"
                    current.updatedAt = Date()
                }
                return
            }
            title = article.title ?? title
            body = article.text
        } else if item.kind == .text {
            body = item.value
        } else if let bodyFile = item.bodyFile {
            body = await NoteBodyStore.load(bodyFile)
        } else {
            body = nil
        }
        await CollectionSearchIndex.shared.index(
            itemId: item.id, title: title, body: body ?? ""
        )
        CollectionStore.completeJob(id: job.id)
        CollectionStore.mutate(id: item.id) { current in
            current.processingState = "ready"
            current.processingErrorCode = nil
            current.updatedAt = Date()
        }
    }

    private func retryProcessing(_ item: CollectedItem) {
        guard TreasuryEnhancementPolicy.canRetry(
            kind: item.kind, errorCode: item.processingErrorCode
        ) else { return }
        CollectionStore.retryFailedJobs(itemID: item.id)
        CollectionStore.mutate(id: item.id) { current in
            current.processingState = "queued"
            current.processingErrorCode = nil
            current.updatedAt = Date()
        }
        reload()
        processPendingJobs()
    }

    /// autoHide=false 用于"正在导入…"这类进行中提示:导入 OCR 是串行的,
    /// 九张图要跑十几秒,1.8 秒就消失等于中途界面毫无动静。
    /// toastID 挡竞态:前一条的隐藏任务醒来时若已有新 toast,不许掐掉它。
    private func flash(_ message: String, autoHide: Bool = true) {
        let id = UUID()
        toastID = id
        withAnimation(.spring(duration: 0.35, bounce: 0.25)) { toast = message }
        guard autoHide else { return }
        Task {
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            await MainActor.run {
                if toastID == id { withAnimation { toast = nil } }
            }
        }
    }

    /// [T-reader] 点击 = 回到内容原处,去向只有两种:
    /// 能定位到原 app 里那条内容就跳 app(小红书笔记、B站视频…);
    /// 其余一律**应用内阅读器**。以前的第三种去向(甩去外部 Safari)
    /// 已经取消 —— 公众号没有 deep-link 方案,每次都被甩出去的就是它。
    private func open(_ item: CollectedItem) {
        CollectionStore.mutate(id: item.id) { current in
            current.lastOpenedAt = Date()
            if current.readingState == "unread" { current.readingState = "reading" }
            current.updatedAt = Date()
        }
        reload()
        if item.kind == .note {
            editingNote = item
            return
        }
        if item.kind == .text {
            readingItem = CollectionStore.load().first(where: { $0.id == item.id }) ?? item
            return
        }
        guard item.kind == .link else {
            previewItem = item
            return
        }
        Task { @MainActor in
            let (resolved, destination) = await CollectionOpener.plan(
                item.value, cachedResolved: item.resolvedURL)
            if let resolved {
                CollectionStore.mutate(id: item.id) { $0.resolvedURL = resolved }
                reload()
            }
            switch destination {
            case .openedApp:
                break
            case .readInApp(let url):
                readerTarget = ReaderTarget(url: url)
            case .unopenable:
                flash("这条链接打不开")
            }
        }
    }

    /// 装回分享缓冲 → 请求新建对话。与外部分享进来的路径一致。
    private func sendToAgent(_ item: CollectedItem, prompt: String?) {
        sendToAgent([item], prompt: prompt)
    }

    /// 多选与单条共用同一个结构化上下文构造器。正文、来源、标签和批注
    /// 都在独立的 untrusted context 字段中，用户提示不会与资料拼成一段。
    private func sendToAgent(_ selectedItems: [CollectedItem], prompt: String?) {
        let chosen = Array(selectedItems.prefix(20))
        guard !chosen.isEmpty else { return }
        Task {
            let context = await TreasuryContextBuilder.build(items: chosen)
            var shareItems: [PendingShare.Item] = []
            for item in chosen where item.kind == .file {
                if let src = CollectionStore.fileURL(named: item.value),
                   let dest = SharedContainerStore.sharedFileURL(named: item.value),
                   FileManager.default.fileExists(atPath: src.path) {
                    try? FileManager.default.createDirectory(
                        at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try? FileManager.default.removeItem(at: dest)
                    try? FileManager.default.copyItem(at: src, to: dest)
                    shareItems.append(.init(kind: .attachment, value: item.value))
                }
            }
            let instruction = prompt ?? (chosen.count == 1
                ? "请使用我从藏宝阁选择的这条资料回答。保留可追踪来源。"
                : "请综合我从藏宝阁选择的 \(chosen.count) 条资料回答。比较时保留每条资料的可追踪来源。")
            await MainActor.run {
                ShareCoordinator.shared.storeBuffer(PendingShare(
                    items: shareItems,
                    timestamp: Date(),
                    instruction: instruction,
                    treasuryContext: context
                ))
                selection = []
                editMode = .inactive
                dismiss()
                // 分享缓冲已装好,复用主界面现成的"新建对话"通道消费它
                NotificationCenter.default.post(name: .newChatRequested, object: nil)
            }
        }
    }

}

// MARK: - 阅读、进度与定位高亮

private struct TreasuryReadingSheet: View {
    let item: CollectedItem
    let relatedItems: [CollectedItem]
    let showsCloseButton: Bool
    let onOpenOriginal: (() -> Void)?
    let onOpenRelated: (CollectedItem) -> Void
    let onUpdate: () -> Void

    @State private var bodyText = ""
    @State private var bodyStatus = "loading"
    @State private var readingState: String
    @State private var progress: Double
    @State private var selection = NSRange(location: NSNotFound, length: 0)
    @State private var highlightNote = ""
    @State private var highlights: [TreasureHighlight] = []
    @State private var message: String?

    init(item: CollectedItem,
         relatedItems: [CollectedItem],
         showsCloseButton: Bool = true,
         onOpenOriginal: (() -> Void)? = nil,
         onOpenRelated: @escaping (CollectedItem) -> Void,
         onUpdate: @escaping () -> Void) {
        self.item = item
        self.relatedItems = relatedItems
        self.showsCloseButton = showsCloseButton
        self.onOpenOriginal = onOpenOriginal
        self.onOpenRelated = onOpenRelated
        self.onUpdate = onUpdate
        _readingState = State(initialValue: item.readingState)
        _progress = State(initialValue: item.readingProgress)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("阅读状态", selection: $readingState) {
                        Text("未读").tag("unread")
                        Text("阅读中").tag("reading")
                        Text("已读").tag("read")
                    }
                    .pickerStyle(.segmented)
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("阅读进度")
                            Spacer()
                            Text(progress, format: .percent.precision(.fractionLength(0)))
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                        }
                        Slider(value: $progress, in: 0...1, step: 0.01) { editing in
                            if !editing { persistReadingState() }
                        }
                            .accessibilityLabel("阅读进度")
                    }
                }

                Section("正文") {
                    if bodyStatus == "loading" {
                        ProgressView("正在读取…")
                    } else if bodyText.isEmpty {
                        ContentUnavailableView(
                            bodyStatus == "missing" ? "正文文件缺失" : "正文尚未抽取",
                            systemImage: "doc.text.magnifyingglass",
                            description: Text("原始收藏仍然安全保留，增强失败不会删除内容。")
                        )
                    } else {
                        SelectableTreasuryText(text: bodyText, selection: $selection)
                            .frame(minHeight: 240)
                            .accessibilityLabel("收藏正文，可选择文字添加高亮")
                        if bodyStatus == "truncated" {
                            Text("为保持阅读流畅，当前显示前 200,000 个字符；原始正文仍完整保留。")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                if !bodyText.isEmpty {
                    Section {
                        TextField("高亮批注（可选）", text: $highlightNote, axis: .vertical)
                            .lineLimit(2...6)
                        Button("保存所选文字为高亮", systemImage: "highlighter") {
                            saveHighlight()
                        }
                        .disabled(selectedQuote == nil)
                    } header: {
                        Text("新建高亮")
                    } footer: {
                        if let quote = selectedQuote {
                            Text("已选择：\(quote)").lineLimit(3)
                        } else {
                            Text("先在正文中选择一段文字；高亮会记录精确位置。")
                        }
                    }
                }

                if !highlights.isEmpty {
                    Section("已保存高亮") {
                        ForEach(highlights) { highlight in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(highlight.quoteText)
                                    .font(.callout)
                                    .textSelection(.enabled)
                                if let note = highlight.note, !note.isEmpty {
                                    Text(note).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            .swipeActions {
                                Button("删除", role: .destructive) {
                                    CollectionStore.deleteHighlight(id: highlight.id)
                                    reloadHighlights()
                                }
                            }
                        }
                    }
                }

                if !relatedItems.isEmpty {
                    Section("相关收藏") {
                        ForEach(relatedItems) { related in
                            Button {
                                onOpenRelated(related)
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(related.title ?? related.value)
                                            .lineLimit(2)
                                            .foregroundStyle(.primary)
                                        Text(related.sourceLabel)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(.tertiary)
                                }
                            }
                        }
                    }
                }

                if let message {
                    Section { Text(message).foregroundStyle(.secondary) }
                }
            }
            .navigationTitle(item.title?.isEmpty == false ? item.title! : "阅读")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if showsCloseButton {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("关闭") { persistReadingState(); dismiss() }
                    }
                }
                if let onOpenOriginal {
                    ToolbarItem(placement: .primaryAction) {
                        Button(item.kind == .note ? "编辑" : "打开", action: onOpenOriginal)
                    }
                }
            }
            .task { await loadBody(); reloadHighlights() }
            .onChange(of: readingState) { _, _ in persistReadingState() }
            .onDisappear { persistReadingState() }
        }
    }

    private var selectedQuote: String? {
        guard selection.location != NSNotFound, selection.location >= 0,
              selection.length > 0,
              selection.location + selection.length <= (bodyText as NSString).length else { return nil }
        let quote = (bodyText as NSString).substring(with: selection)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return quote.isEmpty ? nil : String(quote.prefix(20_000))
    }

    private func loadBody() async {
        let resolution: (String, String)
        switch item.kind {
        case .text:
            resolution = (item.value, "available")
        case .note:
            guard let bodyFile = item.bodyFile else {
                resolution = ("", "missing"); break
            }
            let value = await NoteBodyStore.load(bodyFile)
            resolution = (value, value.isEmpty ? "missing" : "available")
        case .link:
            let indexed = await CollectionSearchIndex.shared.document(itemId: item.id)?.body ?? ""
            resolution = (indexed, indexed.isEmpty ? "not_extracted" : "available")
        case .file:
            guard let bodyFile = item.bodyFile else {
                resolution = ("", "not_extracted"); break
            }
            let value = await NoteBodyStore.load(bodyFile)
            resolution = (value, value.isEmpty ? "missing" : "available")
        }
        guard !Task.isCancelled else { return }
        let readerLimit = 200_000
        bodyText = String(resolution.0.prefix(readerLimit))
        bodyStatus = resolution.0.count > readerLimit ? "truncated" : resolution.1
    }

    private func persistReadingState() {
        let requestedProgress = min(1, max(0, progress))
        let safeProgress: Double
        let effectiveState: String
        switch readingState {
        case "none", "unread":
            safeProgress = 0
            effectiveState = readingState
        case "read":
            safeProgress = 1
            effectiveState = "read"
        default:
            safeProgress = requestedProgress
            effectiveState = requestedProgress >= 1 ? "read" : "reading"
        }
        CollectionStore.mutate(id: item.id) { current in
            current.readingState = effectiveState
            current.readingProgress = safeProgress
            current.lastOpenedAt = current.lastOpenedAt ?? Date()
            current.updatedAt = Date()
        }
        if safeProgress != progress { progress = safeProgress }
        if effectiveState != readingState { readingState = effectiveState }
        onUpdate()
    }

    private func saveHighlight() {
        guard let quote = selectedQuote else { return }
        let rawRange = (bodyText as NSString).range(of: quote, options: [], range: selection)
        guard rawRange.location != NSNotFound,
              let saved = CollectionStore.addHighlight(
                itemID: item.id, body: bodyText, quoteText: quote, note: highlightNote,
                startOffset: rawRange.location, endOffset: rawRange.location + rawRange.length
              ) else {
            message = "高亮保存失败，请确认正文仍然可用后重试。"
            return
        }
        highlights.append(saved)
        highlights.sort {
            let leftPage = $0.pageNumber ?? 0
            let rightPage = $1.pageNumber ?? 0
            return leftPage == rightPage ? $0.startOffset < $1.startOffset : leftPage < rightPage
        }
        highlightNote = ""
        selection = NSRange(location: NSNotFound, length: 0)
        message = "高亮已保存。"
    }

    private func reloadHighlights() {
        highlights = CollectionStore.highlights(itemID: item.id)
    }
}

private struct SelectableTreasuryText: UIViewRepresentable {
    let text: String
    @Binding var selection: NSRange

    func makeCoordinator() -> Coordinator { Coordinator(selection: $selection) }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.adjustsFontForContentSizeCategory = true
        view.font = .preferredFont(forTextStyle: .body)
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.accessibilityTraits.insert(.staticText)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text { view.text = text }
        context.coordinator.selection = $selection
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var selection: Binding<NSRange>
        init(selection: Binding<NSRange>) { self.selection = selection }

        func textViewDidChangeSelection(_ textView: UITextView) {
            selection.wrappedValue = textView.selectedRange
        }
    }
}

// MARK: - 导入(粘贴)

private struct CollectionImportSheet: View {
    let onDone: (Int) -> Void
    @State private var text = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $text)
                        .frame(minHeight: 130)
                        .font(.system(size: 15))
                } header: {
                    Text("粘贴内容")
                } footer: {
                    Text("整段粘贴即可——小红书那种「99 复制打开小红书,看看【…】 http://xhslink.com/…」的文案会自动抽出链接,前面的文字当标题。多条可换行分隔。")
                }
                Section {
                    PasteButton(payloadType: String.self) { strings in
                        text = strings.joined(separator: "\n")
                    }
                    .buttonBorderShape(.capsule)
                }
            }
            .navigationTitle("粘贴收藏")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("收藏") {
                        let added = text
                            .components(separatedBy: .newlines)
                            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
                            .reduce(0) { $0 + CollectionStore.ingestText($1) }
                        onDone(added)
                        dismiss()
                    }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

// MARK: - 卡片

/// [T-treasury-ui] 来源 → 稳定颜色。同一个来源永远同色,列表里形成识别;
/// 卡片徽标、无图占位共用这一个函数,不许各配各的色。
func leoSourceColor(_ source: String) -> Color {
    let palette: [Color] = [.blue, .purple, .pink, .orange, .green, .teal, .indigo, .brown]
    // 不能用 hashValue:Swift 的字符串哈希每次启动换随机种子,
    // "同一来源永远同色"重启一次就破了。djb2 是稳定的。
    var hash: UInt64 = 5381
    for byte in source.utf8 { hash = hash &* 33 &+ UInt64(byte) }
    return palette[Int(hash % UInt64(palette.count))]
}

/// 相对时间:"3 分钟前"比"08-10 15:24"更接近人问自己的问题("刚存的
/// 那条呢?"),超过一周才退回日期。
/// 格式器构造是昂贵操作,列表每行每帧 new 一个会拖慢滚动 —— 缓存住。
private let leoRelativeFormatter: RelativeDateTimeFormatter = {
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .short
    formatter.locale = Locale(identifier: "zh_CN")
    return formatter
}()

func leoRelativeDate(_ date: Date) -> String {
    let interval = Date().timeIntervalSince(date)
    if interval > 7 * 86400 {
        return date.formatted(.dateTime.month().day())
    }
    return leoRelativeFormatter.localizedString(for: date, relativeTo: Date())
}

private struct CollectionCard: View {
    let item: CollectedItem
    /// file 类条目的异步缩略图。原来在行里同步 UIImage(contentsOfFile:)
    /// 把原图整张解码(最长边可达 2400px)再缩到 60×60,滚动掉帧。
    @State private var fileThumb: UIImage?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            thumbnail
                .frame(width: 60, height: 60)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(.quaternary, lineWidth: 0.5))
                .overlay(alignment: .bottomTrailing) {
                    // 笔记角标:一眼分清"我写的"和"我收的"
                    if item.kind == .note {
                        Image(systemName: "pencil")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(.white)
                            .padding(4)
                            .background(.indigo, in: Circle())
                            .offset(x: 4, y: 4)
                    }
                }
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 5) {
                    if item.pinned {
                        Image(systemName: "pin.fill")
                            .font(.system(size: 10)).foregroundStyle(.orange)
                    }
                    Text(displayTitle)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                if let summary = item.summary, !summary.isEmpty {
                    Text(summary)
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                if let note = item.annotation, !note.isEmpty {
                    // 批注:引用样式,和摘要视觉上分开 —— 这是"我的话"
                    HStack(spacing: 5) {
                        RoundedRectangle(cornerRadius: 1)
                            .fill(.teal.opacity(0.6)).frame(width: 2)
                        Text(note).font(.system(size: 12)).foregroundStyle(.teal)
                            .lineLimit(1)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: 6) {
                    Text(item.sourceLabel)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(leoSourceColor(item.sourceLabel))
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(leoSourceColor(item.sourceLabel).opacity(0.13), in: Capsule())
                    Text(leoRelativeDate(item.updatedAt))
                        .font(.system(size: 11)).foregroundStyle(.tertiary)
                    ForEach(item.tags.prefix(2), id: \.self) { tag in
                        Text("#\(tag)").font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .task(id: item.value) {
            // ThumbnailCache 用 ImageIO 直接产 120px 小图(不整张解码),
            // 后台队列 + NSCache 都是现成的,直接复用。
            guard item.kind == .file, item.thumbnailFile == nil,
                  let dir = CollectionStore.filesDirectory else { return }
            let image = await ThumbnailCache.shared.thumbnail(
                for: dir.appendingPathComponent(item.value).path, maxSize: 120)
            // 行被复用去显示别的条目时 task(id:) 会取消本任务 ——
            // 别把旧条目的图填进新行。
            guard !Task.isCancelled else { return }
            fileThumb = image
        }
    }

    private var displayTitle: String {
        if let title = item.title, !title.isEmpty { return title }
        return item.value
    }

    @ViewBuilder
    private var thumbnail: some View {
        if let thumb = item.thumbnailFile,
           let dir = CollectionStore.thumbsDirectory,
           let image = UIImage(contentsOfFile: dir.appendingPathComponent(thumb).path) {
            Image(uiImage: image).resizable().scaledToFill()
        } else if item.kind == .file, let image = fileThumb {
            // 异步缩略图就绪前先落到下面的占位分支,填充后自动刷新
            Image(uiImage: image).resizable().scaledToFill()
        } else {
            // [T-preview] 抓不到封面时不留白:用来源色 + 标题首字做占位,
            // 一眼能认出是哪条(小图标的一片灰认不出任何东西)。
            ZStack {
                placeholderColor.opacity(0.18)
                if let ch = placeholderGlyph {
                    Text(String(ch))
                        .font(.system(size: 26, weight: .medium))
                        .foregroundStyle(placeholderColor)
                } else {
                    Image(systemName: iconName).font(.system(size: 22))
                        .foregroundStyle(placeholderColor)
                }
            }
        }
    }

    private var placeholderColor: Color { leoSourceColor(item.sourceLabel) }

    /// 标题首个有意义的字符。
    private var placeholderGlyph: Character? {
        let source = (item.title ?? item.sourceLabel).trimmingCharacters(in: .whitespacesAndNewlines)
        return source.first { $0.isLetter || $0.isNumber }
    }

    private var iconName: String {
        switch item.kind {
        case .link: return "link"
        case .text: return "text.alignleft"
        case .file: return "doc"
        case .note: return "note.text"
        }
    }
}

// MARK: - 应用内预览

private struct CollectionPreviewSheet: View {
    /// 扫描件/图片的 OCR 正文(惰性读盘)
    @State private var ocrText = ""

    let item: CollectedItem
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(item.sourceLabel)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("关闭") { dismiss() }
                    }
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch item.kind {
        case .note:
            // 笔记的完整编辑在 NoteEditorView;这里是只读预览
            ScrollView {
                Text(item.value)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                    .padding()
            }
        case .link:
            if let url = URL(string: item.value) {
                // 统一走 LeoReaderView:带阅读模式、关闭按钮与工具条折叠
                LeoReaderView(url: url, preferReaderMode: ReaderTarget(url: url).preferReaderMode)
                    .ignoresSafeArea()
            } else {
                Text(item.value).padding()
            }
        case .text:
            ScrollView {
                Text(item.value)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                    .padding()
            }
        case .file:
            if let dir = CollectionStore.filesDirectory,
               let image = UIImage(contentsOfFile: dir.appendingPathComponent(item.value).path) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Image(uiImage: image).resizable().scaledToFit()
                        // [T-attachments] OCR 识别出的文字。存了却看不到
                        // 就等于没存 —— 扫描件的价值一半在图、一半在字。
                        if !ocrText.isEmpty {
                            Divider()
                            Text("识别到的文字")
                                .font(.caption).foregroundStyle(.secondary)
                                .padding(.horizontal)
                            Text(ocrText)
                                .font(.system(size: 15))
                                .textSelection(.enabled)
                                .padding(.horizontal)
                        }
                    }
                }
                .task {
                    guard ocrText.isEmpty, let file = item.bodyFile else { return }
                    ocrText = await NoteBodyStore.load(file)
                }
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "doc").font(.system(size: 40))
                    Text(item.value).font(.footnote)
                }
            }
        }
    }
}

// MARK: - 小工具

private extension NSItemProvider {
    func loadUIImage() async throws -> UIImage? {
        try await withCheckedThrowingContinuation { cont in
            loadObject(ofClass: UIImage.self) { object, error in
                if let error { cont.resume(throwing: error) }
                else { cont.resume(returning: object as? UIImage) }
            }
        }
    }
}

private extension UIImage {
    func leoResized(maxDimension: CGFloat) -> UIImage {
        let longest = max(size.width, size.height)
        guard longest > maxDimension else { return self }
        let scale = maxDimension / longest
        let newSize = CGSize(width: size.width * scale, height: size.height * scale)
        return UIGraphicsImageRenderer(size: newSize).image { _ in
            draw(in: CGRect(origin: .zero, size: newSize))
        }
    }
}
