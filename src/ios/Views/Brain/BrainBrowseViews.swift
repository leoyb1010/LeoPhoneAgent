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
    var inset: CGFloat = LeoTheme.Spacing.md
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        // 换范围时内容跟着弹簧淡入淡出,不再整页瞬间跳变。
        Picker("范围", selection: $scope.animation(LeoMotion.smooth(reduceMotion: reduceMotion))) {
            ForEach(BrainBrowseScope.allCases) { s in
                Text(s.title).tag(s)
            }
        }
        .pickerStyle(.segmented)
        .leoListPlainRow(inset: inset, top: LeoTheme.Spacing.xs, bottom: LeoTheme.Spacing.xxs)
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
            LeoCapsuleBadge(text: String(localized: "私密"), systemImage: "lock.fill",
                            tint: LeoTheme.ColorToken.warning)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text("私密资料"))
        }
    }
}

struct BrainOfflineBadge: View {
    var body: some View {
        LeoCapsuleBadge(text: String(localized: "离线 · 缓存"), systemImage: "icloud.slash")
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("离线,显示的是缓存内容"))
    }
}

/// [T-treasury-design] 命中高亮的摘录:资料库的 `【…】` 标记、手机收藏按查询词定位,
/// 命中段用强调色 + 浅底,不显示括号。
struct LeoHighlightedText: View {
    let segments: [LeoMatchHighlight.Segment]
    @Environment(\.colorScheme) private var colorScheme

    init(markedText: String) { segments = LeoMatchHighlight.segments(markedText: markedText) }
    init(text: String, terms: [String]) { segments = LeoMatchHighlight.segments(text: text, terms: terms) }

    var body: some View {
        Text(attributed)
    }

    private var attributed: AttributedString {
        var out = LeoMatchHighlight.attributed(segments)
        for run in out.runs where run.inlinePresentationIntent == .stronglyEmphasized {
            out[run.range].inlinePresentationIntent = nil
            out[run.range].foregroundColor = LeoTheme.ColorToken.accent
            out[run.range].backgroundColor = LeoTheme.ColorToken.accent.opacity(colorScheme == .dark ? 0.26 : 0.14)
            out[run.range].font = .footnote.weight(.semibold)
        }
        return out
    }
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
    /// 藏宝阁传进来:在当前导航栈里推出资料库设置,不再跳去设置面板(iPad 上会把藏宝阁关掉)。
    var onOpenSettings: (() -> Void)? = nil
    /// 列表容器宽度:决定卡片左右边距与列数(手机一列,宽容器两列居中)。
    var containerWidth: CGFloat = 0
    @ObservedObject private var store = BrainStore.shared
    @StateObject private var model = BrainBrowseModel()
    @State private var creatingCard = false
    @State private var retryToken = 0
    @Namespace private var zoomNamespace
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var inset: CGFloat { TreasuryGridLayout.horizontalInset(forWidth: containerWidth) }
    private var columns: Int { TreasuryGridLayout.columns(forWidth: containerWidth) }

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
        if let onOpenSettings {
            onOpenSettings()
        } else {
            DeepLinkCoordinator.shared.pendingSettingsTarget = .brain
        }
    }

    private var connectionHealthy: Bool { store.statusError == nil && store.health?.ok != false }

    @ViewBuilder
    private var content: some View {
        if scope == .all {
            if !trimmed.isEmpty {
                LeoSectionHeader(title: String(localized: "资料库"),
                                 count: phase == .loading ? nil : model.results.count,
                                 systemImage: "books.vertical")
                    .leoListPlainRow(inset: inset, top: LeoTheme.Spacing.md, bottom: LeoTheme.Spacing.xxs)
            }
        } else if let status = BrainConnectionSummary.text(configured: store.isConfigured, health: store.health,
                                                         statusError: store.statusError) {
            HStack(spacing: LeoTheme.Spacing.xs - 2) {
                // 连接状态变化时图标换形 + 轻弹一下;Reduce Motion 下只换形不弹。
                Image(systemName: connectionHealthy ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                    .foregroundStyle(connectionHealthy ? LeoTheme.ColorToken.success : LeoTheme.ColorToken.warning)
                    .contentTransition(.symbolEffect(.replace))
                    .symbolEffect(.bounce, value: reduceMotion ? true : connectionHealthy)
                    .accessibilityHidden(true)
                Text(status)
                    .foregroundStyle(LeoTheme.ColorToken.secondaryText)
            }
            .font(.caption)
            .accessibilityElement(children: .combine)
            .leoListPlainRow(inset: inset + LeoTheme.Spacing.xxs)
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
                .font(.subheadline.weight(.semibold))
                .frame(minHeight: 44)
                .disabled(model.cardsFromCache)
            }
            .leoListPlainRow(inset: inset)
            if phase == .loading && model.cards.isEmpty {
                skeletonRows
            }
            resultGrid(model.cards, id: \.id) { card in
                BrainCardDetailView(cardId: card.id, initialTitle: card.title)
            } label: { card in
                BrainCardRow(card: card)
            }
            if phase == .empty {
                LeoEmptyState(systemImage: "rectangle.on.rectangle.angled",
                              title: String(localized: "资料库里还没有知识卡。"))
            }
        } else if phase == .idle {
            if scope == .archive {
                LeoEmptyState(systemImage: "text.magnifyingglass",
                              title: String(localized: "搜索你的资料库"),
                              message: String(localized: "输入关键词搜索资料库里的文件。"))
            }
        } else {
            if !store.unlock.unlockedThisSession {
                Button {
                    Task { _ = await store.unlockPrivate() }
                } label: {
                    Label("同时搜索私密资料(需要面容 ID)", systemImage: "lock")
                        .font(.footnote.weight(.medium))
                        .frame(minHeight: 44)
                }
                .buttonStyle(.borderless)
                .leoListPlainRow(inset: inset + LeoTheme.Spacing.xxs)
            }
            if phase == .loading && model.results.isEmpty {
                skeletonRows
            }
            resultGrid(model.results, id: \.id) { item in
                if item.isCard {
                    BrainCardDetailView(cardId: item.id, initialTitle: item.title)
                } else {
                    BrainFileDetailView(fileId: item.id, title: item.title, privacy: item.privacy,
                                        initialLocator: item.match?.locator)
                }
            } label: { item in
                BrainResultRow(item: item)
            }
            if phase == .empty {
                LeoEmptyState(systemImage: "doc.text.magnifyingglass",
                              title: String(localized: "资料库里没有匹配的内容。"))
            }
        }
    }

    /// 远端结果到达前的骨架:和真实卡片同一个结构,结果落下时不跳版。
    @ViewBuilder
    private var skeletonRows: some View {
        ForEach(0..<3, id: \.self) { index in
            LeoSkeletonCard(lines: index == 0 ? 2 : 1)
                .leoListCardRow(inset: inset)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("正在搜索资料库"))
    }

    /// 一列:每条一行(整行可点、带推进箭头)。宽容器:按列分行,每格一张卡。
    /// 前 8 条错峰入场,之后的直接出现;卡片 → 详情走缩放转场。
    @ViewBuilder
    private func resultGrid<Item, ID: Hashable, Destination: View, RowLabel: View>(
        _ items: [Item], id: KeyPath<Item, ID>,
        @ViewBuilder destination: @escaping (Item) -> Destination,
        @ViewBuilder label: @escaping (Item) -> RowLabel
    ) -> some View {
        let order = LeoStaggerPolicy.indices(for: items.map { $0[keyPath: id] })
        if columns <= 1 {
            ForEach(items, id: id) { item in
                let key = item[keyPath: id]
                NavigationLink {
                    destination(item).leoZoomTransition(id: key, in: zoomNamespace)
                } label: {
                    label(item)
                        .leoZoomSource(id: key, in: zoomNamespace)
                        .leoCardHover()
                }
                .leoStaggerEntrance(index: order[key] ?? Int.max)
                .leoScrollDepth()
                .leoListCardRow(inset: inset)
            }
        } else {
            let rows = TreasuryGridLayout.rows(items, columns: columns)
            ForEach(rows.indices, id: \.self) { rowIndex in
                HStack(alignment: .top, spacing: TreasuryGridLayout.spacing) {
                    ForEach(rows[rowIndex], id: id) { item in
                        let key = item[keyPath: id]
                        NavigationLink {
                            destination(item).leoZoomTransition(id: key, in: zoomNamespace)
                        } label: {
                            label(item)
                                .padding(LeoTheme.Card.padding)
                                .frame(maxWidth: .infinity, alignment: .topLeading)
                                .background(LeoTheme.ColorToken.surface,
                                            in: RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
                                .contentShape(RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
                                .leoZoomSource(id: key, in: zoomNamespace)
                                .leoCardHover()
                        }
                        .buttonStyle(.plain)
                        .leoStaggerEntrance(index: order[key] ?? Int.max)
                    }
                    // 最后一行不满时占位,保持列宽一致。
                    ForEach(0..<(columns - rows[rowIndex].count), id: \.self) { _ in
                        Color.clear.frame(maxWidth: .infinity, maxHeight: 1)
                    }
                }
                .leoScrollDepth()
                .leoListPlainRow(inset: inset, top: LeoTheme.Card.gap / 2, bottom: LeoTheme.Card.gap / 2)
            }
        }
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
        .padding(.horizontal, LeoTheme.Spacing.sm)
        .background(LeoTheme.ColorToken.warning.opacity(0.08),
                    in: RoundedRectangle(cornerRadius: LeoTheme.Radius.field, style: .continuous))
        .leoListPlainRow(inset: inset)
    }
}

/// 资料库检索结果卡:类型图块 · 标题 · 来源路径 · 命中摘录(高亮) · 元数据胶囊。
struct BrainResultRow: View {
    let item: BrainSearchItem

    private var symbol: String {
        BrainFileKindIcon.symbol(path: item.path ?? item.ext.map { "file.\($0)" }, isCard: item.isCard)
    }

    var body: some View {
        HStack(alignment: .top, spacing: LeoTheme.Spacing.sm) {
            LeoIconTile(systemImage: symbol, size: 40)
            VStack(alignment: .leading, spacing: LeoTheme.Card.lineGap) {
                HStack(alignment: .firstTextBaseline, spacing: LeoTheme.Spacing.xs) {
                    Text(item.title.isEmpty ? String(localized: "未命名") : item.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(LeoTheme.ColorToken.primaryText)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 0)
                    BrainPrivacyBadge(privacy: item.privacy)
                }
                if let path = item.path, !path.isEmpty {
                    Text(verbatim: path).font(.caption2.monospaced()).lineLimit(1).truncationMode(.middle)
                        .foregroundStyle(LeoTheme.ColorToken.tertiaryText)
                }
                if let excerpt = item.match?.excerpt, !excerpt.isEmpty {
                    LeoHighlightedText(markedText: excerpt)
                        .font(.footnote)
                        .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                        .lineLimit(3)
                        .lineSpacing(2)
                        .padding(.top, 2)
                }
                let category = item.category.flatMap { $0.isEmpty ? nil : $0 }
                let locator = item.match?.locator.flatMap { $0.isEmpty ? nil : $0 }
                if category != nil || locator != nil {
                    LeoFlowLayout(spacing: 6) {
                        if let category { LeoCapsuleBadge(text: category, systemImage: "folder") }
                        if let locator {
                            LeoCapsuleBadge(text: locator, systemImage: "mappin", tint: LeoTheme.ColorToken.accent)
                        }
                    }
                    .padding(.top, 2)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// 知识卡:图块 · 标题 · 摘要 · 版本 / 状态 / 分类 / 日期胶囊。
struct BrainCardRow: View {
    let card: BrainCardSummary

    var body: some View {
        HStack(alignment: .top, spacing: LeoTheme.Spacing.sm) {
            LeoIconTile(systemImage: "rectangle.on.rectangle.angled", size: 40)
            VStack(alignment: .leading, spacing: LeoTheme.Card.lineGap) {
                Text(card.title.isEmpty ? String(localized: "未命名") : card.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(LeoTheme.ColorToken.primaryText)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                if let summary = card.summary, !summary.isEmpty {
                    Text(verbatim: summary).font(.footnote).lineLimit(2)
                        .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                }
                BrainCardMetaChips(version: card.version, status: card.status, category: card.category,
                                   date: BrainDisplay.date(card.updatedAt))
                    .padding(.top, 2)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// 知识卡的元数据胶囊:列表行和详情页头部共用。
struct BrainCardMetaChips: View {
    let version: Int
    let status: String?
    let category: String?
    let date: String?
    var fromCache = false

    var body: some View {
        LeoFlowLayout(spacing: 6) {
            LeoCapsuleBadge(text: "v\(version)", monospaced: true)
            if let label = BrainDisplay.status(status) {
                LeoCapsuleBadge(text: label, systemImage: status == "confirmed" ? "checkmark.seal" : nil,
                                tint: status == "confirmed" ? LeoTheme.ColorToken.accent : LeoTheme.ColorToken.secondaryText)
            }
            if let category, !category.isEmpty { LeoCapsuleBadge(text: category, systemImage: "folder") }
            if let date, !date.isEmpty { LeoCapsuleBadge(text: date, systemImage: "clock") }
            if fromCache { BrainOfflineBadge() }
        }
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
                fileHero
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

            if chunks.isEmpty && loading {
                // 正文还在路上:段落骨架,和真实段落同宽同节奏。
                ForEach(0..<3, id: \.self) { _ in
                    LeoSkeletonCard(showsTile: false, lines: 3)
                        .leoReadingMeasure()
                        .padding(.vertical, LeoTheme.Spacing.xs)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text("正在读取…"))
            }

            ForEach(chunks) { chunk in
                VStack(alignment: .leading, spacing: LeoTheme.Spacing.xs) {
                    if let locator = chunk.locator, !locator.isEmpty {
                        LeoCapsuleBadge(text: locator, systemImage: "mappin", tint: LeoTheme.ColorToken.accent)
                    }
                    Text(verbatim: chunk.text)
                        .font(.body)
                        .foregroundStyle(LeoTheme.ColorToken.primaryText)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .leoReadingMeasure()
                .padding(.vertical, LeoTheme.Spacing.xs)
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

    /// 头部:类型图块 · 标题 · 路径 · 元数据胶囊 · 摘要 · 下载原件。
    @ViewBuilder
    private var fileHero: some View {
        VStack(alignment: .leading, spacing: LeoTheme.Spacing.sm) {
            HStack(alignment: .top, spacing: LeoTheme.Spacing.sm) {
                LeoIconTile(systemImage: BrainFileKindIcon.symbol(path: meta?.path ?? meta?.ext.map { "file.\($0)" }),
                            size: LeoTheme.Card.heroTile)
                VStack(alignment: .leading, spacing: LeoTheme.Spacing.xxs) {
                    Text(verbatim: meta?.title ?? title)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(LeoTheme.ColorToken.primaryText)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                    if let path = meta?.path, !path.isEmpty {
                        Text(verbatim: path)
                            .font(.caption.monospaced())
                            .foregroundStyle(LeoTheme.ColorToken.tertiaryText)
                            .lineLimit(2)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                    }
                }
            }
            if let meta {
                LeoFlowLayout(spacing: 6) {
                    if let category = meta.category, !category.isEmpty {
                        LeoCapsuleBadge(text: category, systemImage: "folder")
                    }
                    if let project = meta.project, !project.isEmpty {
                        LeoCapsuleBadge(text: project, systemImage: "shippingbox")
                    }
                    if let size = meta.size {
                        LeoCapsuleBadge(text: ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file),
                                        systemImage: "internaldrive", monospaced: true)
                    }
                    BrainPrivacyBadge(privacy: meta.privacy)
                    if fromCache { BrainOfflineBadge() }
                }
                if let summary = meta.summary, !summary.isEmpty {
                    Text(verbatim: summary)
                        .font(.subheadline)
                        .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if meta.originalAvailable || meta.backupAvailable {
                    Button {
                        Task { await download() }
                    } label: {
                        HStack(spacing: LeoTheme.Spacing.xs - 2) {
                            if downloading {
                                ProgressView().tint(.white)
                            } else {
                                Image(systemName: "arrow.down.doc")
                            }
                            Text("下载原件")
                        }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, LeoTheme.Spacing.md)
                        .frame(minHeight: LeoTheme.TouchTarget.minimum)
                        .background(LeoTheme.ColorToken.accent, in: Capsule())
                        .contentShape(Capsule())
                    }
                    .buttonStyle(LeoSquishButtonStyle())
                    .disabled(downloading || fromCache)
                    .opacity(downloading || fromCache ? 0.55 : 1)
                }
            } else if loading {
                LeoSkeletonBar(width: 200, height: 18, cornerRadius: 9)
                    .accessibilityHidden(true)
            }
        }
        .padding(.vertical, LeoTheme.Spacing.xs)
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        List {
            if let card {
                Section {
                    VStack(alignment: .leading, spacing: LeoTheme.Spacing.sm) {
                        HStack(alignment: .top, spacing: LeoTheme.Spacing.sm) {
                            LeoIconTile(systemImage: "rectangle.on.rectangle.angled", size: LeoTheme.Card.heroTile)
                            Text(verbatim: card.title.isEmpty ? initialTitle : card.title)
                                .font(.title3.weight(.semibold))
                                .foregroundStyle(LeoTheme.ColorToken.primaryText)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityAddTraits(.isHeader)
                        }
                        BrainCardMetaChips(version: card.version, status: card.status, category: card.category,
                                           date: BrainDisplay.date(card.updatedAt), fromCache: fromCache)
                    }
                    .padding(.vertical, LeoTheme.Spacing.xs)
                    if let viewingVersion {
                        Label("正在看历史版本 v\(viewingVersion)", systemImage: "clock.arrow.circlepath")
                            .font(.footnote)
                            .foregroundStyle(LeoTheme.ColorToken.accent)
                        Button("回到最新版本") { Task { await load(version: nil) } }
                    }
                }
                Section {
                    SelectableMarkdownView(markdown: card.body)
                        .frame(maxWidth: LeoTheme.Reading.maxWidth, alignment: .leading)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, LeoTheme.Spacing.xxs)
                }
                if !card.sources.isEmpty {
                    Section("出处") {
                        ForEach(Array(card.sources.enumerated()), id: \.element) { index, source in
                            let label = BrainDisplay.sourceLabel(index: index, locator: source.locator)
                            NavigationLink {
                                BrainFileDetailView(fileId: source.fileId, title: label, privacy: .general,
                                                    initialLocator: source.locator)
                            } label: {
                                Label {
                                    Text(verbatim: label).font(.footnote)
                                } icon: {
                                    Image(systemName: "mappin.and.ellipse")
                                        .foregroundStyle(LeoTheme.ColorToken.accent)
                                }
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
                                    Text(verbatim: BrainDisplay.date(entry.savedAt) ?? "").font(.caption2)
                                        .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                                }
                            }
                            .disabled(fromCache)
                        }
                    }
                }
            } else if error == nil {
                Section {
                    LeoSkeletonCard(lines: 4)
                        .padding(.vertical, LeoTheme.Spacing.xs)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(Text("正在读取…"))
                }
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
                LeoHaptics.content(.copied)
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
            LeoHaptics.content(.saved)
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
