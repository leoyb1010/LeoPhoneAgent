//
//  BrainBrowseViews.swift
//  MinisApp
//
//  [T-brain] 藏宝阁里的资料库:范围切换、检索结果、资料详情(分页正文、
//  跳到位置、下载原件)、知识卡(列表 / 阅读 / 历史版本 / 编辑与冲突处理)。
//  私密资料:每次打开都要 5 分钟内的面容 ID / 设备密码;本次运行解锁过才会搜出来。
//  离线:知识卡与最近 50 页正文走本机缓存,标「离线 · 缓存」。
//

import QuickLook
import SwiftUI
import UIKit

// MARK: - Scope picker

struct BrainScopePicker: View {
    @Binding var scope: BrainBrowseScope

    var body: some View {
        Picker("范围", selection: $scope) {
            ForEach(BrainBrowseScope.allCases) { s in
                Text(s.title).tag(s)
            }
        }
        .pickerStyle(.segmented)
        .padding(.horizontal, 14)
        .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .accessibilityLabel(Text("藏宝阁范围"))
    }
}

extension BrainBrowseScope {
    var title: String {
        switch self {
        case .all: return String(localized: "全部")
        case .phone: return String(localized: "手机收藏")
        case .archive: return String(localized: "资料库")
        case .cards: return String(localized: "知识卡")
        }
    }
}

// MARK: - Small badges

struct BrainPrivacyBadge: View {
    let privacy: BrainPrivacy

    var body: some View {
        if privacy == .private {
            Label("私密", systemImage: "lock.fill")
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 6).padding(.vertical, 2)
                .foregroundStyle(LeoTheme.ColorToken.warning)
                .background(LeoTheme.ColorToken.warning.opacity(0.12), in: Capsule())
                .accessibilityLabel(Text("私密资料"))
        }
    }
}

struct BrainOfflineBadge: View {
    var body: some View {
        Label("离线 · 缓存", systemImage: "icloud.slash")
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .foregroundStyle(LeoTheme.ColorToken.secondaryText)
            .background(LeoTheme.ColorToken.surface, in: Capsule())
            .accessibilityLabel(Text("离线,显示的是缓存内容"))
    }
}

private func brainRowStyle<V: View>(_ v: V) -> some View {
    v.listRowInsets(EdgeInsets(top: 5, leading: 26, bottom: 5, trailing: 26))
        .listRowSeparator(.hidden)
        .listRowBackground(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(LeoTheme.ColorToken.surface)
                .padding(.horizontal, 14)
                .padding(.vertical, 2)
        )
}

// MARK: - Browse section (rows inside the 藏宝阁 List)

@MainActor
final class BrainBrowseModel: ObservableObject {
    @Published var results: [BrainSearchItem] = []
    @Published var cards: [BrainCardSummary] = []
    @Published var loading = false
    @Published var error: BrainError?
    @Published var cardsFromCache = false
    @Published var semanticUsed = false

    /// 只有最新一次请求能改 loading / 结果:打字时旧请求被取消后晚到的收尾不能把新状态冲掉。
    private var generation = 0

    func load(scope: BrainBrowseScope, query: String) async {
        generation += 1
        let mine = generation
        let store = BrainStore.shared
        guard store.isConfigured, let searchScope = scope.searchScope else {
            results = []; cards = []; error = nil; loading = false
            return
        }
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if scope == .cards && q.isEmpty {
            await loadCards()
            return
        }
        guard !q.isEmpty else { results = []; error = nil; loading = false; return }
        // 防抖期间就算「搜索中」:否则每敲一个字都会先闪一下「没有匹配的内容」。
        loading = true
        try? await Task.sleep(nanoseconds: 300_000_000)
        guard !Task.isCancelled, mine == generation else { return }
        defer { if mine == generation { loading = false } }
        do {
            let response = try await store.requireClient().search(
                q, scope: searchScope, limit: 30,
                includePrivate: BrainPrivacyPolicy.includePrivateForUI(unlock: store.unlock))
            guard !Task.isCancelled, mine == generation else { return }
            results = response.items.filter { BrainPrivacyPolicy.isListable($0.privacy, unlock: store.unlock) }
            semanticUsed = response.semanticUsed
            error = nil
        } catch is CancellationError {
        } catch {
            guard !Task.isCancelled, mine == generation else { return }
            results = []
            self.error = (error as? BrainError) ?? .network
        }
    }

    func loadCards() async {
        let store = BrainStore.shared
        loading = true
        defer { loading = false }
        do {
            let client = try store.requireClient()
            let (list, data) = try await client.cards()
            cards = list.items
            cardsFromCache = false
            error = nil
            store.cache.storeCardList(data)
            // 知识卡全文离线可读:后台把正文都缓存一遍(最多 50 张)。
            Task.detached(priority: .utility) {
                for summary in list.items.prefix(50) {
                    if let (_, body) = try? await client.card(summary.id) {
                        store.cache.storeCard(id: summary.id, data: body)
                    }
                }
            }
        } catch {
            let brainError = (error as? BrainError) ?? .network
            if brainError.isOffline, let data = store.cache.cardList(),
               let list = try? BrainJSON.decode(BrainCardList.self, from: data) {
                cards = list.items
                cardsFromCache = true
                self.error = nil
            } else {
                cards = []
                self.error = brainError
            }
        }
    }
}

struct BrainBrowseSection: View {
    let scope: BrainBrowseScope
    let query: String
    /// 下拉刷新时由藏宝阁递增,资料库区块跟着重查。
    var refreshToken: Int = 0
    @ObservedObject private var store = BrainStore.shared
    @StateObject private var model = BrainBrowseModel()
    @State private var creatingCard = false
    @State private var retryToken = 0

    private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var phase: BrainBrowsePhase {
        BrainBrowsePhase.resolve(configured: store.isConfigured, scope: scope, query: query,
                                 loading: model.loading, error: model.error,
                                 resultCount: scope == .cards && trimmed.isEmpty ? model.cards.count : model.results.count)
    }

    var body: some View {
        Group {
            switch phase {
            case .notConfigured(let showsPrompt):
                if showsPrompt {
                    LeoEmptyState(systemImage: "books.vertical",
                                  title: String(localized: "还没有连接资料库"),
                                  message: String(localized: "在「设置 › 资料库」连接 Mac 上的资料库后,这里能搜到你的文件和知识卡。"),
                                  actionTitle: String(localized: "去连接"),
                                  actionSystemImage: "link",
                                  action: openBrainSettings)
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
            default:
                content
            }
        }
        .task(id: "\(scope.rawValue)|\(query)|\(store.isConfigured)|\(store.unlock.unlockedThisSession)|\(refreshToken)|\(retryToken)") {
            await model.load(scope: scope, query: query)
        }
        .task(id: "\(store.isConfigured)|\(scope.rawValue)") {
            // 资料库 / 知识卡范围顶上的一行连接状态:没检测过就检测一次。
            if store.isConfigured, scope != .phone, scope != .all, store.health == nil, store.statusError == nil {
                await store.refreshHealth()
            }
        }
        .sheet(isPresented: $creatingCard) {
            NavigationStack {
                BrainCardEditorView(card: nil) { _ in Task { await model.loadCards() } }
            }
        }
    }

    private func openBrainSettings() {
        DeepLinkCoordinator.shared.pendingSettingsTarget = .brain
    }

    @ViewBuilder
    private var content: some View {
        if scope == .all {
            if !trimmed.isEmpty { sectionHeader(String(localized: "资料库")) }
        } else if let status = BrainConnectionSummary.text(configured: store.isConfigured, health: store.health,
                                                         statusError: store.statusError) {
            Label(status, systemImage: store.statusError == nil && store.health?.ok != false
                  ? "checkmark.circle" : "exclamationmark.circle")
                .font(.caption)
                .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                .padding(.horizontal, 14)
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
        }
        if case .failed(let error) = phase {
            failedRow(error)
        }
        if scope == .cards && trimmed.isEmpty {
            HStack {
                if model.cardsFromCache { BrainOfflineBadge() }
                Spacer()
                Button {
                    creatingCard = true
                } label: { Label("新建知识卡", systemImage: "square.and.pencil") }
                .frame(minHeight: 44)
                .disabled(model.cardsFromCache)
            }
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            .padding(.horizontal, 14)
            if phase == .loading {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
            ForEach(model.cards) { card in
                brainRowStyle(
                    NavigationLink {
                        BrainCardDetailView(cardId: card.id, initialTitle: card.title)
                    } label: { BrainCardRow(card: card) }
                )
            }
            if phase == .empty {
                hintRow(String(localized: "资料库里还没有知识卡。"))
            }
        } else if phase == .idle {
            if scope == .archive {
                hintRow(String(localized: "输入关键词搜索资料库里的文件。"))
            }
        } else {
            if phase == .loading {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
            if !store.unlock.unlockedThisSession {
                Button {
                    Task { _ = await store.unlockPrivate() }
                } label: {
                    Label("同时搜索私密资料(需要面容 ID)", systemImage: "lock.open")
                        .font(.footnote)
                        .frame(minHeight: 44)
                }
                .listRowBackground(Color.clear)
                .padding(.horizontal, 14)
            }
            ForEach(model.results) { item in
                brainRowStyle(
                    NavigationLink {
                        if item.isCard {
                            BrainCardDetailView(cardId: item.id, initialTitle: item.title)
                        } else {
                            BrainFileDetailView(fileId: item.id, title: item.title, privacy: item.privacy,
                                                initialLocator: item.match?.locator)
                        }
                    } label: { BrainResultRow(item: item) }
                )
            }
            if phase == .empty {
                hintRow(String(localized: "资料库里没有匹配的内容。"))
            }
        }
    }

    private func hintRow(_ text: String) -> some View {
        Text(text).font(.footnote)
            .foregroundStyle(LeoTheme.ColorToken.secondaryText)
            .padding(.horizontal, 14)
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(LeoTheme.ColorToken.secondaryText)
            .padding(.horizontal, 14)
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            .accessibilityAddTraits(.isHeader)
    }

    /// 出错一行:说清楚原因,并给下一步(重试 / 去重新连接)。离线时「全部」仍照常显示手机收藏。
    private func failedRow(_ error: BrainError) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Label(error.isOffline
                  ? (scope == .all ? String(localized: "资料库离线,只显示手机收藏。") : String(localized: "资料库离线,暂时搜不了。"))
                  : error.message,
                  systemImage: error.isOffline ? "icloud.slash" : "exclamationmark.triangle")
                .font(.footnote)
                .foregroundStyle(LeoTheme.ColorToken.warning)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            switch error.recovery {
            case .retry:
                Button(String(localized: "重试")) { retryToken += 1 }
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.borderless)
                    .frame(minHeight: 44)
            case .reconnect:
                Button(String(localized: "去设置")) { openBrainSettings() }
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.borderless)
                    .frame(minHeight: 44)
            case .none:
                EmptyView()
            }
        }
        .padding(.horizontal, 14)
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }
}

struct BrainResultRow: View {
    let item: BrainSearchItem

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: item.isCard ? "rectangle.on.rectangle.angled" : "doc.text")
                    .foregroundStyle(LeoTheme.ColorToken.accent)
                    .accessibilityHidden(true)
                Text(item.title.isEmpty ? String(localized: "未命名") : item.title)
                    .font(.body.weight(.medium)).lineLimit(2)
                Spacer(minLength: 0)
                BrainPrivacyBadge(privacy: item.privacy)
            }
            if let path = item.path, !path.isEmpty {
                Text(verbatim: path).font(.caption2.monospaced()).lineLimit(1).truncationMode(.middle)
                    .foregroundStyle(LeoTheme.ColorToken.tertiaryText)
            }
            if let excerpt = item.match?.excerpt, !excerpt.isEmpty {
                Text(verbatim: excerpt).font(.footnote).lineLimit(3)
                    .foregroundStyle(LeoTheme.ColorToken.secondaryText)
            }
            HStack(spacing: 8) {
                if let category = item.category, !category.isEmpty {
                    Text(verbatim: category).font(.caption2)
                }
                if let locator = item.match?.locator, !locator.isEmpty {
                    Label(locator, systemImage: "mappin").font(.caption2)
                }
            }
            .foregroundStyle(LeoTheme.ColorToken.secondaryText)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

struct BrainCardRow: View {
    let card: BrainCardSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(card.title.isEmpty ? String(localized: "未命名") : card.title)
                .font(.body.weight(.medium)).lineLimit(2)
            if let summary = card.summary, !summary.isEmpty {
                Text(verbatim: summary).font(.footnote).lineLimit(2)
                    .foregroundStyle(LeoTheme.ColorToken.secondaryText)
            }
            Text(verbatim: ["v\(card.version)", card.status ?? "", card.category ?? "", card.updatedAt ?? ""]
                .filter { !$0.isEmpty }.joined(separator: " · "))
                .font(.caption2)
                .foregroundStyle(LeoTheme.ColorToken.tertiaryText)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Private gate

private struct BrainLockedView: View {
    let onUnlock: () -> Void

    var body: some View {
        LeoEmptyState(systemImage: "lock.fill",
                      title: String(localized: "私密资料"),
                      message: String(localized: "用面容 ID 或设备密码解锁后查看。5 分钟内再次打开不用重复解锁。"),
                      actionTitle: String(localized: "解锁查看"),
                      actionSystemImage: "faceid",
                      action: onUnlock)
    }
}

// MARK: - File detail

struct BrainFileDetailView: View {
    let fileId: String
    let title: String
    let privacy: BrainPrivacy
    let initialLocator: String?

    @ObservedObject private var store = BrainStore.shared
    @State private var meta: BrainFileMeta?
    @State private var chunks: [BrainChunk] = []
    @State private var total = 0
    @State private var nextOffset = 0
    @State private var loading = false
    @State private var fromCache = false
    @State private var error: String?
    @State private var locatorDraft = ""
    @State private var activeLocator: String?
    @State private var unlocked = false
    @State private var downloading = false
    /// 下载好的原件交给系统快速查看(自带完成与分享:存到文件、隔空投送、用别的 App 打开)。
    @State private var previewURL: URL?

    private var effectivePrivacy: BrainPrivacy { meta?.privacy == .private ? .private : privacy }

    var body: some View {
        Group {
            if effectivePrivacy == .restricted {
                LeoEmptyState(systemImage: "nosign", title: String(localized: "这份资料不能在手机上查看"))
            } else if effectivePrivacy == .private && !unlocked {
                BrainLockedView { Task { await unlock() } }
            } else {
                content
            }
        }
        .navigationTitle(unlocked ? (meta?.title ?? title) : title)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if privacy == .private {
                await unlock()
            } else {
                unlocked = true
                await reload(locator: initialLocator)
            }
        }
        .quickLookPreview($previewURL)
    }

    private var content: some View {
        List {
            Section {
                if let meta {
                    if let path = meta.path { LabeledContent("路径") { Text(verbatim: path).font(.caption.monospaced()) } }
                    if let category = meta.category { LabeledContent("分类", value: category) }
                    if let project = meta.project, !project.isEmpty { LabeledContent("项目", value: project) }
                    if let size = meta.size {
                        LabeledContent("大小", value: ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
                    }
                    if let summary = meta.summary, !summary.isEmpty {
                        Text(verbatim: summary).font(.footnote).foregroundStyle(LeoTheme.ColorToken.secondaryText)
                    }
                    HStack {
                        BrainPrivacyBadge(privacy: meta.privacy)
                        if fromCache { BrainOfflineBadge() }
                    }
                    if meta.originalAvailable || meta.backupAvailable {
                        Button {
                            Task { await download() }
                        } label: {
                            if downloading { ProgressView() } else { Label("下载原件", systemImage: "arrow.down.doc") }
                        }
                        .disabled(downloading || fromCache)
                    }
                } else if loading {
                    ProgressView()
                }
                if let error {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(LeoTheme.ColorToken.warning)
                    Button {
                        self.error = nil
                        Task { await reload(locator: activeLocator) }
                    } label: { Label("重试", systemImage: "arrow.clockwise") }
                    .disabled(loading)
                }
            }

            Section {
                HStack {
                    TextField("跳到位置(如 第3页)", text: $locatorDraft)
                        .textInputAutocapitalization(.never)
                        .onSubmit { Task { await reload(locator: locatorDraft) } }
                        .accessibilityLabel(Text("跳到的位置"))
                    Button("跳转") { Task { await reload(locator: locatorDraft) } }
                        .disabled(locatorDraft.trimmingCharacters(in: .whitespaces).isEmpty || loading)
                }
                if activeLocator != nil {
                    Button("回到开头") { Task { await reload(locator: nil) } }
                }
            } header: { Text("正文") } footer: {
                if total > 0 { Text("共 \(total) 段") }
            }

            ForEach(chunks) { chunk in
                VStack(alignment: .leading, spacing: 6) {
                    if let locator = chunk.locator, !locator.isEmpty {
                        Text(verbatim: locator).font(.caption.weight(.semibold))
                            .foregroundStyle(LeoTheme.ColorToken.accent)
                    }
                    Text(verbatim: chunk.text).font(.callout).textSelection(.enabled)
                }
                .padding(.vertical, 4)
            }

            if nextOffset < total && !chunks.isEmpty {
                Button {
                    Task { await loadMore() }
                } label: {
                    if loading { ProgressView() } else { Label("加载更多", systemImage: "arrow.down.circle") }
                }
                .disabled(loading)
            }
        }
    }

    private func unlock() async {
        if await store.unlockPrivate() {
            unlocked = true
            await reload(locator: initialLocator)
        }
    }

    private var cacheAllowed: Bool { effectivePrivacy == .general }

    private func reload(locator: String?) async {
        let loc = locator?.trimmingCharacters(in: .whitespacesAndNewlines)
        activeLocator = (loc?.isEmpty == false) ? loc : nil
        chunks = []
        nextOffset = 0
        total = 0
        await loadMeta()
        await loadPage(offset: 0)
    }

    private func loadMore() async { await loadPage(offset: nextOffset) }

    private func loadMeta() async {
        do {
            let (m, data) = try await store.requireClient().file(fileId)
            meta = m
            if m.privacy == .private && !store.isUnlockFresh() { unlocked = false; return }
            if m.privacy == .general { store.cache.storeFileMeta(id: fileId, data: data) }
            fromCache = false
        } catch let e as BrainError where e.isOffline {
            if let data = store.cache.fileMeta(id: fileId), let m = try? BrainJSON.decode(BrainFileMeta.self, from: data) {
                meta = m
                fromCache = true
            } else {
                error = e.message
            }
        } catch {
            self.error = (error as? BrainError)?.message ?? BrainError.network.message
        }
    }

    private func loadPage(offset: Int) async {
        guard effectivePrivacy != .private || store.isUnlockFresh() else { unlocked = false; return }
        loading = true
        defer { loading = false }
        // 跳到位置只作用于第一页;之后按 offset 往下翻。
        let locator = offset == 0 ? activeLocator : nil
        do {
            let (page, data) = try await store.requireClient().chunks(fileId, offset: offset, locator: locator)
            apply(page, offset: offset)
            if cacheAllowed { store.cache.storeChunkPage(fileId: fileId, offset: offset, locator: locator, data: data) }
            fromCache = false
            error = nil
        } catch let e as BrainError where e.isOffline {
            if let data = store.cache.chunkPage(fileId: fileId, offset: offset, locator: locator),
               let page = try? BrainJSON.decode(BrainChunkPage.self, from: data) {
                apply(page, offset: offset)
                fromCache = true
                error = nil
            } else {
                error = String(localized: "离线,这一页没有缓存。")
            }
        } catch {
            self.error = (error as? BrainError)?.message ?? BrainError.network.message
        }
    }

    private func apply(_ page: BrainChunkPage, offset: Int) {
        if offset == 0 { chunks = page.chunks } else { chunks += page.chunks }
        total = page.total
        nextOffset = offset + page.chunks.count
        if page.chunks.isEmpty { nextOffset = total }
    }

    private func download() async {
        guard effectivePrivacy != .private || store.isUnlockFresh() else { unlocked = false; return }
        downloading = true
        defer { downloading = false }
        do {
            let url = try await store.requireClient().downloadOriginal(fileId)
            previewURL = url
        } catch {
            self.error = (error as? BrainError)?.message ?? BrainError.network.message
        }
    }
}

// MARK: - Cards

struct BrainCardDetailView: View {
    let cardId: String
    let initialTitle: String

    @ObservedObject private var store = BrainStore.shared
    @State private var card: BrainCard?
    @State private var viewingVersion: Int?
    @State private var fromCache = false
    @State private var error: String?
    @State private var editing = false

    var body: some View {
        List {
            if let card {
                Section {
                    HStack {
                        Text(verbatim: "v\(card.version)").font(.caption.monospaced())
                        if let status = card.status { Text(verbatim: status).font(.caption) }
                        if fromCache { BrainOfflineBadge() }
                        Spacer()
                    }
                    .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                    if let viewingVersion {
                        Label("正在看历史版本 v\(viewingVersion)", systemImage: "clock.arrow.circlepath")
                            .font(.footnote)
                        Button("回到最新版本") { Task { await load(version: nil) } }
                    }
                    SelectableMarkdownView(markdown: card.body)
                }
                if !card.sources.isEmpty {
                    Section("出处") {
                        ForEach(card.sources, id: \.self) { source in
                            NavigationLink {
                                BrainFileDetailView(fileId: source.fileId, title: source.fileId, privacy: .general,
                                                    initialLocator: source.locator)
                            } label: {
                                Text(verbatim: [source.fileId, source.locator ?? ""].filter { !$0.isEmpty }.joined(separator: " · "))
                                    .font(.footnote.monospaced())
                            }
                        }
                    }
                }
                if !card.history.isEmpty {
                    Section("历史版本") {
                        ForEach(card.history, id: \.self) { entry in
                            Button {
                                Task { await load(version: entry.version) }
                            } label: {
                                HStack {
                                    Text(verbatim: "v\(entry.version)").font(.footnote.monospaced())
                                    Text(verbatim: entry.title ?? "").font(.footnote).lineLimit(1)
                                    Spacer()
                                    Text(verbatim: entry.savedAt ?? "").font(.caption2)
                                        .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                                }
                            }
                            .disabled(fromCache)
                        }
                    }
                }
            } else if error == nil {
                ProgressView().frame(maxWidth: .infinity)
            }
            if let error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.footnote).foregroundStyle(LeoTheme.ColorToken.warning)
            }
        }
        .navigationTitle(card?.title ?? initialTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("编辑") { editing = true }
                    .disabled(card == nil || fromCache || viewingVersion != nil)
            }
        }
        .sheet(isPresented: $editing) {
            NavigationStack {
                BrainCardEditorView(card: card) { saved in
                    if let saved { card = saved; viewingVersion = nil }
                    else { Task { await load(version: nil) } }
                }
            }
        }
        .task { await load(version: nil) }
    }

    private func load(version: Int?) async {
        do {
            let (c, data) = try await store.requireClient().card(cardId, version: version)
            card = c
            viewingVersion = version
            fromCache = false
            error = nil
            if version == nil { store.cache.storeCard(id: cardId, data: data) }
        } catch let e as BrainError where e.isOffline {
            if let data = store.cache.card(id: cardId), let c = try? BrainJSON.decode(BrainCard.self, from: data) {
                card = c
                viewingVersion = nil
                fromCache = true
                error = nil
            } else {
                error = e.message
            }
        } catch {
            self.error = (error as? BrainError)?.message ?? BrainError.network.message
        }
    }
}

struct BrainCardEditorView: View {
    let card: BrainCard?
    /// 保存成功传回新卡;版本冲突传 nil(调用方重新载入)。
    let onDone: (BrainCard?) -> Void

    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var store = BrainStore.shared
    @State private var title = ""
    @State private var bodyText = ""
    @State private var category = ""
    @State private var status = "draft"
    @State private var saving = false
    @State private var error: String?
    @State private var conflict = false
    @State private var confirmDiscard = false
    @State private var loaded = false

    /// 改过但没保存:不让下滑误关,取消先确认。
    private var isDirty: Bool {
        guard loaded else { return false }
        return title != (card?.title ?? "") || bodyText != (card?.body ?? "")
            || category != (card?.category ?? "") || status != (card?.status ?? "draft")
    }

    var body: some View {
        Form {
            Section {
                TextField("标题", text: $title)
                TextField("分类(可选)", text: $category)
                Picker("状态", selection: $status) {
                    Text("草稿").tag("draft")
                    Text("已确认").tag("confirmed")
                    Text("参考").tag("reference")
                }
            }
            Section("正文") {
                TextEditor(text: $bodyText)
                    .frame(minHeight: 240)
                    .accessibilityLabel(Text("知识卡正文"))
            }
            if let error {
                Section { Text(error).font(.footnote).foregroundStyle(LeoTheme.ColorToken.warning) }
            }
        }
        .navigationTitle(card == nil ? String(localized: "新建知识卡") : String(localized: "编辑知识卡"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("取消") { if isDirty { confirmDiscard = true } else { dismiss() } }
            }
            ToolbarItem(placement: .confirmationAction) {
                if saving {
                    ProgressView()
                } else {
                    Button("保存") { Task { await save() } }
                        .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty
                                  || bodyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .interactiveDismissDisabled(isDirty || saving)
        .confirmationDialog("放弃这次修改?", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("放弃修改", role: .destructive) { dismiss() }
            Button("继续编辑", role: .cancel) {}
        }
        .alert("已被其他设备修改", isPresented: $conflict) {
            Button("拷贝我的修改并重新载入") {
                UIPasteboard.general.string = bodyText
                onDone(nil)
                dismiss()
            }
            Button("重新载入", role: .destructive) {
                onDone(nil)
                dismiss()
            }
            Button("继续编辑", role: .cancel) {}
        } message: {
            Text("这张卡在别处有了新版本。重新载入后再改,你刚才的修改不会覆盖它;可以先把你写的正文拷贝走。")
        }
        .onAppear {
            defer { loaded = true }
            guard let card, !loaded else { return }
            title = card.title
            bodyText = card.body
            category = card.category ?? ""
            status = card.status ?? "draft"
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        var draft = BrainCardDraft(id: card?.id, version: card?.version,
                                   title: title.trimmingCharacters(in: .whitespacesAndNewlines), body: bodyText)
        draft.category = category.isEmpty ? nil : category
        draft.status = status
        draft.sources = card?.sources ?? []
        do {
            let (saved, data) = try await store.requireClient().saveCard(draft)
            store.cache.storeCard(id: saved.id, data: data)
            onDone(saved)
            dismiss()
        } catch BrainError.versionConflict {
            conflict = true
        } catch {
            self.error = (error as? BrainError)?.message ?? BrainError.network.message
        }
    }
}

// MARK: - Send a 藏宝阁 item to the archive inbox

enum BrainTreasuryCapture {
    @MainActor
    static func send(_ item: CollectedItem) async -> String {
        let store = BrainStore.shared
        let title = (item.title?.isEmpty == false ? item.title! : String(item.value.prefix(40)))
        do {
            switch item.kind {
            case .file:
                guard let url = CollectionStore.fileURL(named: item.value) else { throw BrainError.notFound }
                _ = try await store.captureFile(url, filename: url.lastPathComponent)
            case .note:
                var text = ""
                if let file = item.bodyFile { text = await NoteBodyStore.load(file) }
                _ = try await store.captureText(markdown(title: title, body: text, item: item),
                                                filename: BrainStore.markdownFileName(title))
            case .link, .text:
                _ = try await store.captureText(markdown(title: title, body: item.value, item: item),
                                                filename: BrainStore.markdownFileName(title))
            }
            return String(localized: "已送进资料库收件箱")
        } catch {
            return (error as? BrainError)?.message ?? BrainError.network.message
        }
    }

    private static func markdown(title: String, body: String, item: CollectedItem) -> String {
        var parts = ["# \(title)", "", body]
        if let summary = item.summary, !summary.isEmpty { parts += ["", "> \(summary)"] }
        if let note = item.annotation, !note.isEmpty { parts += ["", "## 批注", "", note] }
        if !item.tags.isEmpty { parts += ["", "标签:" + item.tags.joined(separator: "、")] }
        parts += ["", "来源:LeoBot 藏宝阁 · \(item.sourceLabel)"]
        return parts.joined(separator: "\n")
    }
}
