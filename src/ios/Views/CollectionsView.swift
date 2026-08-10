//
//  CollectionsView.swift
//  MinisApp
//
//  [T-collections] 收藏页:任意 app 分享进来的链接/图片/文本,带预览卡片。
//
//  链接的标题/封面在这里惰性补抓(LPMetadataProvider)——分享扩展进程
//  内存受限不做抓取,主 app 打开本页时补,结果缓存进条目,只抓一次。
//
//  「发给 Agent」复用分享管道:把条目装回 ShareCoordinator 的缓冲,
//  再请求新建对话——与从小红书分享进来的路径完全一致,零新协议。
//

import LinkPresentation
import QuickLook
import SafariServices
import SwiftUI
import UIKit

struct CollectionsView: View {
    @State private var items: [CollectedItem] = []
    @State private var query = ""
    @State private var filterSource: String? = nil
    @State private var previewItem: CollectedItem?
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
            out = out.filter {
                ($0.title ?? "").lowercased().contains(q)
                    || $0.value.lowercased().contains(q)
                    || ($0.summary ?? "").lowercased().contains(q)
                    || $0.tags.joined().lowercased().contains(q)
            }
        }
        return out.sorted { a, b in
            if a.pinned != b.pinned { return a.pinned }
            return a.createdAt > b.createdAt
        }
    }

    var body: some View {
        List {
            if items.isEmpty {
                emptyState
            } else {
                if sources.count > 1 { sourceFilter }
                ForEach(visible) { item in
                    CollectionCard(item: item)
                        .contentShape(Rectangle())
                        .onTapGesture { previewItem = item }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                CollectionStore.delete(ids: [item.id])
                                reload()
                            } label: { Label("删除", systemImage: "trash") }
                            Button {
                                var updated = item
                                updated.pinned.toggle()
                                CollectionStore.update(updated)
                                reload()
                            } label: {
                                Label(item.pinned ? "取消置顶" : "置顶",
                                      systemImage: item.pinned ? "pin.slash" : "pin")
                            }.tint(.orange)
                        }
                        .swipeActions(edge: .leading, allowsFullSwipe: true) {
                            Button {
                                sendToAgent(item, prompt: nil)
                            } label: { Label("发给 Agent", systemImage: "paperplane.fill") }
                                .tint(.indigo)
                            Button {
                                sendToAgent(item, prompt: "用一两句话总结这条收藏的内容要点。")
                            } label: { Label("总结", systemImage: "sparkles") }
                                .tint(.purple)
                        }
                }
            }
        }
        .navigationTitle("收藏")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "搜索收藏")
        .refreshable { reload() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("分享时的默认动作", selection: $defaultAction) {
                        Text("每次询问").tag("ask")
                        Text("总是发到对话").tag("chat")
                        Text("总是收藏(不打断)").tag("collect")
                    }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        .sheet(item: $previewItem) { CollectionPreviewSheet(item: $0) }
        .onAppear {
            reload()
            fetchMissingMetadata()
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "star.square.on.square")
                .font(.system(size: 40)).foregroundStyle(.secondary)
            Text("还没有收藏").font(.headline)
            Text("在小红书等任意 app 里点分享 → LeoPhoneAgent → 收藏。\n设置为「总是收藏」后分享即存,不打断刷内容。")
                .font(.footnote).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
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

    private func reload() {
        items = CollectionStore.load()
    }

    /// 装回分享缓冲 → 请求新建对话。与外部分享进来的路径一致。
    private func sendToAgent(_ item: CollectedItem, prompt: String?) {
        var shareItems: [PendingShare.Item] = []
        switch item.kind {
        case .link, .text:
            shareItems.append(.init(kind: .inlineText, value: item.value))
        case .file:
            // 复制回分享中转目录(附件消费方从那里取)
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
                let provider = LPMetadataProvider()
                provider.timeout = 12
                let metadata = try? await provider.startFetchingMetadata(for: url)
                item.metadataFetched = true
                if let metadata {
                    item.title = metadata.title
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
                CollectionStore.update(item)
                await MainActor.run { reload() }
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
                    .lineLimit(2)
                if let summary = item.summary, !summary.isEmpty {
                    Text(summary).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                HStack(spacing: 6) {
                    if item.pinned { Image(systemName: "pin.fill").font(.system(size: 9)).foregroundStyle(.orange) }
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
        }
        .padding(.vertical, 2)
    }

    private var displayTitle: String {
        if let title = item.title, !title.isEmpty { return title }
        switch item.kind {
        case .link: return item.value
        case .text: return item.value
        case .file: return item.value
        }
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

// MARK: - 预览

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
