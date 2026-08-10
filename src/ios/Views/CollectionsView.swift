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
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct CollectionsView: View {
    @State private var items: [CollectedItem] = []
    @State private var query = ""
    @State private var filterSource: String? = nil
    @State private var previewItem: CollectedItem?
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
        var out = items
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
                    || fullTextHits.contains($0.id)
            }
        }
        return out.sorted { a, b in
            if a.pinned != b.pinned { return a.pinned }
            return a.createdAt > b.createdAt
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
        .navigationTitle(editMode.isEditing && !selection.isEmpty ? "已选 \(selection.count) 条" : "收藏")
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
        .sheet(item: $previewItem) { CollectionPreviewSheet(item: $0) }
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
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button {
                sendToAgent(item, prompt: nil)
            } label: { Label("发给 Agent", systemImage: "paperplane.fill") }
                .tint(.indigo)
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
                        showImportSheet = true
                    } label: { Label("粘贴链接收藏", systemImage: "doc.on.clipboard") }
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
            Text("还没有收藏").font(.headline)
            Text("两种进来的方式:\n① 在任意 app 点分享 → LeoPhoneAgent → 收藏\n② 只给「复制链接」的 app(如小红书):复制后回到这里,\n用上方剪贴板条或右上角「粘贴链接收藏」")
                .font(.footnote).foregroundStyle(.secondary)
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

    /// 点击 = 回到内容原处。链接交给系统:装了对应 app(小红书/B站…)就
    /// 跳 app,没有才落浏览器;图片/文本没有"原处",走应用内预览。
    private func open(_ item: CollectedItem) {
        guard item.kind == .link else {
            previewItem = item
            return
        }
        Task { @MainActor in
            let (resolved, openedApp) = await CollectionOpener.open(
                item.value, cachedResolved: item.resolvedURL)
            if let resolved {
                var updated = item
                updated.resolvedURL = resolved
                CollectionStore.update(updated)
                reload()
            }
            if !openedApp { previewItem = item }
        }
    }

    /// 装回分享缓冲 → 请求新建对话。与外部分享进来的路径一致。
    private func sendToAgent(_ item: CollectedItem, prompt: String?) {
        var shareItems: [PendingShare.Item] = []
        switch item.kind {
        case .link, .text:
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
                let provider = LPMetadataProvider()
                provider.timeout = 12
                let metaTarget = item.resolvedURL.flatMap(URL.init(string:)) ?? url
                let metadata = try? await provider.startFetchingMetadata(for: metaTarget)
                item.metadataFetched = true
                if let metadata {
                    // 抓到的标题优先;抓不到时保留导入时从文案里截的标题
                    if let fetched = metadata.title, !fetched.isEmpty { item.title = fetched }
                    if let imageProvider = metadata.imageProvider,
                       let image = try? await imageProvider.loadUIImage(),
                       let thumbDir = CollectionStore.thumbsDirectory {
                        let name = "thumb-\(item.id).jpg"
                        let resized = image.leoResized(maxDimension: 480)
                        if let data = resized.jpegData(compressionQuality: 0.8) {
                            try? data.write(to: thumbDir.appendingPathComponent(name))
                            item.thumbnailFile = name
                        }
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
            ZStack {
                Color.secondary.opacity(0.12)
                Image(systemName: iconName).font(.system(size: 22)).foregroundStyle(.secondary)
            }
        }
    }

    private var iconName: String {
        switch item.kind {
        case .link: return "link"
        case .text: return "text.alignleft"
        case .file: return "doc"
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
        case .link:
            if let url = URL(string: item.value) {
                LeoSafariView(url: url).ignoresSafeArea()
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

private struct LeoSafariView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }
    func updateUIViewController(_ vc: SFSafariViewController, context: Context) {}
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
