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
    @State private var annotationDraft = ""
    /// [T-notes] 显示归档的条目(默认收起)
    @State private var showArchived = false
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
    /// [T-collections-fulltext] 当前查询在全文索引里的命中(条目 id)。
    @State private var fullTextMatches: [String] = []
    @State private var fullTextSnippets: [String: String] = [:]
    @State private var indexing = false
    @State private var lastSyncedFingerprint = ""
    @State private var searchTask: Task<Void, Never>?
    @AppStorage(CollectionStore.defaultActionKey, store: SharedContainerStore.sharedDefaults)
    private var defaultAction = "ask"
    @Environment(\.dismiss) private var dismiss

    private var sources: [String] {
        Array(Set(items.map(\.sourceLabel))).sorted()
    }

    private var visible: [CollectedItem] {
        // [T-notes] 归档的默认不出现在主列表 —— 归档就是"收起来但不删"
        var out = showArchived ? items.filter(\.archived) : items.filter { !$0.archived }
        if let filterSource { out = out.filter { $0.sourceLabel == filterSource } }
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
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
            // 笔记会被反复编辑,按最后改动排;收藏类 updatedAt 等于创建时间
            return a.updatedAt > b.updatedAt
        }
    }

    var body: some View {
        List(selection: $selection) {
            importRow
            if items.isEmpty {
                emptyState
            } else {
                if sources.count > 1 { sourceFilter }
                ForEach(visible) { item in
                    row(item)
                }
                .onDelete { offsets in
                    let ids = Set(offsets.map { visible[$0].id })
                    purge(ids)
                }
            }
        }
        .environment(\.editMode, $editMode)
        .navigationTitle(editMode.isEditing && !selection.isEmpty ? "已选 \(selection.count) 条" : "Leo藏宝阁")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "搜索收藏(含正文)")
        .onChange(of: query) { _, newValue in
            // 防抖 250ms 再查:FTS 查询别跟着每一次击键跑
            searchTask?.cancel()
            searchTask = Task {
                try? await Task.sleep(nanoseconds: 250_000_000)
                guard !Task.isCancelled else { return }
                let hits = await CollectionSearchIndex.shared.search(newValue)
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    fullTextMatches = hits.map(\.itemId)
                    fullTextSnippets = Dictionary(hits.map { ($0.itemId, $0.snippet) },
                                                  uniquingKeysWith: { a, _ in a })
                }
            }
        }
        .refreshable { reload() }
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
        .fullScreenCover(item: $readerTarget) { target in
            LeoReaderView(url: target.url, preferReaderMode: target.preferReaderMode)
                .ignoresSafeArea()
        }
        .sheet(isPresented: $showImportSheet) {
            CollectionImportSheet { added in
                reload()
                fetchMissingMetadata()
                flash("已收藏 \(added) 条")
            }
        }
        .overlay(alignment: .bottom) {
            if let toast {
                Text(toast)
                    .font(.footnote.weight(.medium))
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.bottom, 24)
                    .transition(.opacity)
            }
        }
        .onAppear {
            reload()
            fetchMissingMetadata()
            indexMissingFullText()
        }
    }

    // MARK: 行

    private func row(_ item: CollectedItem) -> some View {
        Button {
            open(item)
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
            Button {
                sendToAgent(item, prompt: "用一两句话总结这条收藏的内容要点。")
            } label: { Label("让 Agent 总结", systemImage: "sparkles") }
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
                        newNote()
                    } label: { Label("写一条笔记", systemImage: "square.and.pencil") }
                    Button {
                        showImportSheet = true
                    } label: { Label("粘贴链接收藏", systemImage: "doc.on.clipboard") }
                    Divider()
                    // [T-attachments] 附件三条路,全用系统件
                    Button {
                        showScanner = true
                    } label: { Label("扫描纸质文档", systemImage: "doc.viewfinder") }
                    Button {
                        showPhotoPicker = true
                    } label: { Label("从相册导入", systemImage: "photo.on.rectangle") }
                    Button {
                        showFileImporter = true
                    } label: { Label("从文件导入", systemImage: "folder") }
                    Divider()
                    Button {
                        withAnimation { showArchived.toggle() }
                    } label: {
                        Label(showArchived ? "回到收藏" : "查看归档",
                              systemImage: showArchived ? "tray.full" : "archivebox")
                    }
                    Button {
                        withAnimation { editMode = .active }
                    } label: { Label("选择并删除", systemImage: "checkmark.circle") }
                    Divider()
                    Picker("分享时的默认动作", selection: $defaultAction) {
                        Text("每次询问").tag("ask")
                        Text("总是发到对话").tag("chat")
                        Text("总是收藏(不打断)").tag("collect")
                    }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        // [T-ia] 新增入口:点一下直接写笔记(进藏宝阁最常做的事),
        // 长按才展开其他导入方式。一次点击拿到最常用的那个,不必先读菜单
        // ——把"写笔记"埋在杂项 ⋯ 里,正是"点进来了还要再找"的根源。
        ToolbarItem(placement: .topBarTrailing) {
            if !editMode.isEditing {
                Menu {
                    Button {
                        showImportSheet = true
                    } label: { Label("粘贴链接", systemImage: "doc.on.clipboard") }
                    Divider()
                    Button {
                        showScanner = true
                    } label: { Label("扫描纸质文档", systemImage: "doc.viewfinder") }
                    Button {
                        showPhotoPicker = true
                    } label: { Label("从相册导入", systemImage: "photo.on.rectangle") }
                    Button {
                        showFileImporter = true
                    } label: { Label("从文件导入", systemImage: "folder") }
                } label: {
                    Image(systemName: "plus")
                } primaryAction: {
                    newNote()
                }
                .accessibilityLabel("写笔记;长按可选其他导入方式")
            }
        }
        ToolbarItem(placement: .bottomBar) {
            if editMode.isEditing {
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

    /// 剪贴板里有链接时的一键收藏条。PasteButton 不触发"允许粘贴"提示。
    @ViewBuilder
    private var importRow: some View {
        if !editMode.isEditing, UIPasteboard.general.hasURLs || UIPasteboard.general.hasStrings {
            HStack(spacing: 10) {
                Image(systemName: "doc.on.clipboard")
                    .foregroundStyle(.yellow)
                VStack(alignment: .leading, spacing: 1) {
                    Text("剪贴板里有内容").font(.system(size: 14, weight: .medium))
                    Text("小红书等只给「复制链接」的 app,从这里收藏")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                PasteButton(payloadType: String.self) { strings in
                    let added = strings.reduce(0) { $0 + CollectionStore.ingestText($1) }
                    Task { @MainActor in
                        reload()
                        fetchMissingMetadata()
                        flash(added > 0 ? "已收藏 \(added) 条" : "剪贴板里没有可收藏的内容")
                    }
                }
                .labelStyle(.iconOnly)
                .buttonBorderShape(.capsule)
            }
            .listRowBackground(Color.yellow.opacity(0.08))
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "star.square.on.square")
                .font(.system(size: 40)).foregroundStyle(.secondary)
            Text("藏宝阁还是空的").font(.headline)
            Text("在任意 app 点分享 → LeoPhoneAgent,或者从这里开始:")
                .font(.footnote).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            // 空状态给可点的按钮,而不是一段"你可以去哪里点"的说明
            HStack(spacing: 10) {
                Button {
                    newNote()
                } label: {
                    Label("写笔记", systemImage: "square.and.pencil")
                }
                .buttonStyle(.borderedProminent)
                Button {
                    showImportSheet = true
                } label: {
                    Label("粘贴链接", systemImage: "doc.on.clipboard")
                }
                .buttonStyle(.bordered)
            }
            .padding(.top, 4)
            Text("小红书这类只给「复制链接」的 app:复制后回到这里,\n顶部剪贴板条一点即存。")
                .font(.caption).foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 32)
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
        Button {
            filterSource = source
        } label: {
            Text(label)
                .font(.caption.weight(.medium))
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(filterSource == source ? Color.accentColor.opacity(0.2)
                                                   : Color.secondary.opacity(0.12),
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
        flash("正在导入 \(count) 项…")
        Task {
            let made = await work()
            await MainActor.run {
                importing = false
                if made.isEmpty {
                    flash("没能导入(格式不支持或读取失败)")
                } else {
                    CollectionStore.add(made)
                    reload()
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
        Task {
            await CollectionSearchIndex.shared.index(
                itemId: updated.id,
                title: updated.title ?? "",
                body: [updated.value, text].joined(separator: "\n"))
        }
    }

    private func reload() {
        items = CollectionStore.load()
        syncToRelay()
    }

    /// [T-collections-fleet] 把收藏索引推给中继,Mac 端才看得到。
    /// 指纹含内容(不只 id):补完标题摘要后 id 集不变,但 Mac 端不能
    /// 停留在贫化快照上。成功后才记账,失败下次自动重试。
    private func syncToRelay() {
        let snapshot = items
        let fingerprint = snapshot.map {
            "\($0.id)|\($0.title ?? "")|\($0.summary ?? "")|\($0.tags.joined())|\($0.pinned)"
        }.joined(separator: "\n").hashValue.description
        guard fingerprint != lastSyncedFingerprint else { return }
        Task {
            guard let client = GatewayHostStore.shared.activeHosts
                .compactMap({ GatewayHostStore.shared.client(for: $0) })
                .first(where: { $0.relayEventsURL != nil }) else { return }
            if await client.uploadCollections(snapshot) {
                await MainActor.run { lastSyncedFingerprint = fingerprint }
            }
        }
    }

    /// 删除条目时把全文索引与系统搜索一并清掉——只删一半会留下
    /// "搜得到但打不开"的幽灵。
    private func purge(_ ids: Set<String>) {
        CollectionStore.delete(ids: ids)
        Task {
            for id in ids { await CollectionSearchIndex.shared.remove(itemId: id) }
            await CollectionSearchIndex.shared.unpublishFromSpotlight(ids: ids)
        }
        reload()
    }

    /// [T-collections-fulltext] 给还没有正文的链接抓正文入索引。
    /// 串行循环直到清空(WebView 一次一个);抽取失败记尝试次数,
    /// 3 次仍失败就放弃——否则付费墙/短文那几条会永远堵在队首,
    /// 后面的条目一辈子进不了索引。
    private func indexMissingFullText() {
        guard !indexing else { return }
        indexing = true
        Task {
            defer { Task { @MainActor in indexing = false } }
            let failKey = "collections.fulltext.attempts"
            var attempts = (UserDefaults.standard.dictionary(forKey: failKey) as? [String: Int]) ?? [:]
            let indexed = await CollectionSearchIndex.shared.indexedIds()
            let todo = items.filter {
                $0.kind == .link && !indexed.contains($0.id) && (attempts[$0.id] ?? 0) < 3
            }
            for item in todo {
                let target = item.resolvedURL.flatMap(URL.init(string:))
                    ?? URL(string: item.value)
                guard let target else { attempts[item.id] = 3; continue }
                if let article = await ArticleExtractor.shared.extract(url: target) {
                    await CollectionSearchIndex.shared.index(
                        itemId: item.id,
                        title: article.title ?? item.title ?? "",
                        body: article.text)
                    attempts.removeValue(forKey: item.id)
                } else {
                    attempts[item.id] = (attempts[item.id] ?? 0) + 1
                }
            }
            UserDefaults.standard.set(attempts, forKey: failKey)
            let snapshot = items
            await CollectionSearchIndex.shared.publishToSpotlight(snapshot)
        }
    }

    private func flash(_ message: String) {
        withAnimation { toast = message }
        Task {
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            await MainActor.run { withAnimation { toast = nil } }
        }
    }

    /// [T-reader] 点击 = 回到内容原处,去向只有两种:
    /// 能定位到原 app 里那条内容就跳 app(小红书笔记、B站视频…);
    /// 其余一律**应用内阅读器**。以前的第三种去向(甩去外部 Safari)
    /// 已经取消 —— 公众号没有 deep-link 方案,每次都被甩出去的就是它。
    private func open(_ item: CollectedItem) {
        if item.kind == .note {
            editingNote = item
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
                var updated = item
                updated.resolvedURL = resolved
                CollectionStore.update(updated)
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
        var shareItems: [PendingShare.Item] = []
        switch item.kind {
        case .link, .text, .note:
            shareItems.append(.init(kind: .inlineText, value: item.value))
        case .file:
            if let src = CollectionStore.filesDirectory?.appendingPathComponent(item.value),
               let destDir = SharedContainerStore.sharedFileDirectory {
                try? FileManager.default.createDirectory(at: destDir, withIntermediateDirectories: true)
                let dest = destDir.appendingPathComponent(item.value)
                try? FileManager.default.removeItem(at: dest)
                try? FileManager.default.copyItem(at: src, to: dest)
                shareItems.append(.init(kind: .attachment, value: item.value))
            }
        }
        if let prompt { shareItems.append(.init(kind: .inlineText, value: prompt)) }
        guard !shareItems.isEmpty else { return }
        ShareCoordinator.shared.storeBuffer(PendingShare(items: shareItems, timestamp: Date()))
        dismiss()
        // 分享缓冲已装好,复用主界面现成的"新建对话"通道消费它
        NotificationCenter.default.post(name: .newChatRequested, object: nil)
    }

    /// 惰性补抓链接标题/封面,每条只试一次。
    private func fetchMissingMetadata() {
        let pending = items.filter { $0.kind == .link && !$0.metadataFetched }
        guard !pending.isEmpty else { return }
        Task {
            for var item in pending.prefix(10) {
                guard let url = URL(string: item.value) else { continue }
                // [T-collections-deeplink] 顺手把短链解析掉,首次点击直达 app
                if item.resolvedURL == nil, CollectionOpener.isShortLink(url) {
                    let resolved = await CollectionOpener.resolve(url)
                    if resolved != url { item.resolvedURL = resolved.absoluteString }
                }
                // [T-preview] 通用抓取:系统抓取器 → HTML 多级兜底
                // (og / twitter / JSON-LD / 站点变量 / 正文首图 / favicon)。
                // 任何站都走这一条,不是给某几个站开的特例。
                let metaTarget = item.resolvedURL.flatMap(URL.init(string:)) ?? url
                let preview = await LinkPreviewFetcher.fetch(metaTarget)
                item.metadataFetched = true
                // 抓到的标题优先;抓不到时保留导入时从文案里截的标题
                if let fetched = preview.title, !fetched.isEmpty { item.title = fetched }
                if let image = preview.image, let thumbDir = CollectionStore.thumbsDirectory {
                    let name = "thumb-\(item.id).jpg"
                    let resized = image.leoResized(maxDimension: 480)
                    if let data = resized.jpegData(compressionQuality: 0.8) {
                        try? data.write(to: thumbDir.appendingPathComponent(name))
                        item.thumbnailFile = name
                    }
                }
                // [T-local-brain] 顺手让本机模型给一句话摘要与标签。
                // 不可用就跳过——收藏功能本身不依赖它。
                if item.summary == nil {
                    let material = [item.title, item.value].compactMap { $0 }.joined(separator: "\n")
                    if let insight = await LocalBrain.shared.summarizeCollection(
                        title: item.title, text: material) {
                        item.summary = insight.summary
                        if item.tags.isEmpty { item.tags = insight.tags }
                    }
                }
                CollectionStore.update(item)
                await MainActor.run { reload() }
            }
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

private struct CollectionCard: View {
    let item: CollectedItem

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            thumbnail
                .frame(width: 64, height: 64)
                .clipShape(RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 4) {
                Text(displayTitle)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                if let summary = item.summary, !summary.isEmpty {
                    Text(summary).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                HStack(spacing: 6) {
                    if item.pinned {
                        Image(systemName: "pin.fill").font(.system(size: 9)).foregroundStyle(.orange)
                    }
                    Text(item.sourceLabel)
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color.accentColor.opacity(0.15), in: Capsule())
                    Text(item.createdAt.formatted(.dateTime.month().day().hour().minute()))
                        .font(.caption2).foregroundStyle(.tertiary)
                    ForEach(item.tags.prefix(3), id: \.self) { tag in
                        Text("#\(tag)").font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
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
        } else if item.kind == .file,
                  let dir = CollectionStore.filesDirectory,
                  let image = UIImage(contentsOfFile: dir.appendingPathComponent(item.value).path) {
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

    /// 按来源取一个稳定的颜色 —— 同一个来源永远同色,列表里能形成识别。
    private var placeholderColor: Color {
        let palette: [Color] = [.blue, .purple, .pink, .orange, .green, .teal, .indigo, .brown]
        let seed = abs(item.sourceLabel.hashValue)
        return palette[seed % palette.count]
    }

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
                ScrollView([.horizontal, .vertical]) {
                    Image(uiImage: image).resizable().scaledToFit()
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
