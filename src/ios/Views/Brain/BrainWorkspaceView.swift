import AVKit
import SwiftUI

@MainActor
final class BrainWorkspaceModel: ObservableObject {
    @Published var files: [BrainSearchItem] = []
    @Published var cards: [BrainCardSummary] = []
    @Published var media: [BrainMediaItem] = []
    @Published var loading = false
    @Published var fileError: String?
    @Published var mediaError: String?
    @Published var warning: String?
    @Published var fileTotal = 0
    @Published var mediaTotal = 0
    private var fileOffset = 0
    private var mediaOffset = 0
    private var fileEnded = false
    private var mediaEnded = false
    private var generation = UUID()
    var hasMore: Bool { (!fileEnded && fileOffset < fileTotal) || (!mediaEnded && mediaOffset < mediaTotal) }

    func clearMedia() { media = []; mediaTotal = 0; mediaOffset = 0; mediaEnded = true }

    func load(query: String, scope: BrainWorkspaceScope, includeMedia: Bool, append: Bool = false) async {
        let ticket: UUID
        if append {
            guard !loading else { return }; ticket = generation
        } else {
            generation = UUID(); ticket = generation
            files = []; cards = []; media = []; fileOffset = 0; mediaOffset = 0
            fileTotal = 0; mediaTotal = 0; fileEnded = false; mediaEnded = false
        }
        loading = true; fileError = nil; mediaError = nil; warning = nil
        defer { if ticket == generation { loading = false } }
        let store = BrainStore.shared
        guard store.isConfigured else { return }
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !append {
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
        }
        guard ticket == generation, !Task.isCancelled else { return }
        do {
            let client = try store.requireClient()
            if !scope.isMedia && !fileEnded {
                do {
                    if query.isEmpty {
                        if scope == .cards {
                            let list = try await client.cards(offset: fileOffset, limit: 24).0
                            var verified: [BrainCardSummary] = []
                            for summary in list.items {
                                guard ticket == generation, !Task.isCancelled else { return }
                                do {
                                    _ = try await client.generalCard(summary.id)
                                    verified.append(summary)
                                } catch let error as BrainError {
                                    if case .forbidden = error { warning = "部分知识卡含私密来源，请在第二大脑网页查看。" }
                                    else { throw error }
                                }
                            }
                            guard ticket == generation, !Task.isCancelled, store.isConfigured else { return }
                            var seen = Set(cards.map(\.id))
                            cards += verified.filter { seen.insert($0.id).inserted }
                            fileOffset += list.items.count; fileTotal = list.total
                            fileEnded = list.items.isEmpty || fileOffset >= list.total
                        } else { fileEnded = true }
                    } else {
                        let page = try await client.search(query, scope: scope == .cards ? .cards : scope == .files ? .files : .all,
                                                           limit: 24, offset: fileOffset, includePrivate: includeMedia && store.isUnlockFresh())
                        guard ticket == generation, !Task.isCancelled else { return }
                        var seen = Set(files.map { $0.type + ":" + $0.id })
                        files += page.items.filter { $0.privacy == .general || ($0.privacy == .private && includeMedia && store.isUnlockFresh()) }
                            .filter { seen.insert($0.type + ":" + $0.id).inserted }
                        let next = page.resumeOffset(after: fileOffset)
                        fileEnded = next <= fileOffset || next >= page.total
                        fileOffset = next; fileTotal = page.total
                    }
                } catch {
                    guard ticket == generation, !Task.isCancelled else { return }
                    fileError = (error as? BrainError)?.message ?? BrainError.network.message
                }
            }
            guard ticket == generation, !Task.isCancelled else { return }
            if (scope.isMedia || scope == .all) && includeMedia && store.isUnlockFresh() && !mediaEnded {
                do {
                    let page = try await client.mediaSearch(query, kind: scope.mediaKind, offset: mediaOffset)
                    guard ticket == generation, !Task.isCancelled, store.isConfigured, store.isUnlockFresh() else { return }
                    var seen = Set(media.map(\.id))
                    media += page.items.filter { seen.insert($0.id).inserted }
                    let next = page.resumeOffset(after: mediaOffset)
                    mediaEnded = next <= mediaOffset || next >= page.total
                    mediaOffset = next; mediaTotal = page.total; warning = page.warning
                } catch {
                    guard ticket == generation, !Task.isCancelled else { return }
                    mediaError = (error as? BrainError)?.message ?? BrainError.network.message
                }
            }
        } catch {
            guard ticket == generation, !Task.isCancelled else { return }
            fileError = (error as? BrainError)?.message ?? BrainError.network.message
        }
    }
}

/// The archive is the main workspace. Existing phone collections remain an
/// explicit destination with their original storage and capture behavior.
struct BrainWorkspaceView: View {
    var onClose: (() -> Void)? = nil
    @ObservedObject private var store = BrainStore.shared
    @StateObject private var model = BrainWorkspaceModel()
    @State private var query = ""
    @State private var scope: BrainWorkspaceScope = .all
    @State private var refresh = 0
    @State private var clock = Date()
    @State private var unlockError: String?
    @Environment(\.scenePhase) private var scenePhase
    private var mediaUnlocked: Bool { store.isConfigured && store.unlock.isFresh(now: clock) && scenePhase == .active }

    var body: some View {
        Group {
            if onClose != nil {
                NavigationStack { workspace }
            } else { workspace }
        }
    }

    private var workspace: some View {
        List {
            Section {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "brain.head.profile").font(.title).foregroundStyle(Color.accentColor)
                    VStack(alignment: .leading, spacing: 5) {
                        Text("你的资料，随时找回").font(.headline)
                        Text("检索文件、知识卡、图片文字和视频片段，再打开来源使用。")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                }.padding(.vertical, 8)
                if store.isConfigured {
                    NavigationLink { BrainSettingsView() } label: {
                        Label(store.statusError == nil ? "第二大脑已连接" : "检查第二大脑连接", systemImage: store.statusError == nil ? "checkmark.circle" : "exclamationmark.circle")
                            .font(.subheadline)
                    }
                    Button {
                        if mediaUnlocked { store.lockPrivate(); clock = Date() }
                        else { Task { await unlock() } }
                    } label: {
                        Label(mediaUnlocked ? "锁定私密资料" : "解锁私密资料", systemImage: mediaUnlocked ? "lock.open" : "faceid")
                    }
                    if let unlockError { Text(unlockError).font(.caption).foregroundStyle(.secondary) }
                } else {
                    NavigationLink { BrainSettingsView() } label: { Label("连接第二大脑", systemImage: "link") }
                }
            }
            Section {
                // Six tiny segments are unreadable on Duo. A wrapping native
                // grid gives every scope a real 44pt target at narrow widths.
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 90))], spacing: 8) {
                    ForEach(BrainWorkspaceScope.allCases) { item in
                        Button { scope = item } label: {
                            Label(item.title, systemImage: item.symbol)
                                .font(.subheadline.weight(scope == item ? .semibold : .regular))
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .background(scope == item ? Color.accentColor.opacity(0.13) : Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
                        }.buttonStyle(.plain)
                            .accessibilityAddTraits(scope == item ? .isSelected : [])
                            .accessibilityIdentifier("brain.scope.\(item.rawValue)")
                    }
                }.padding(.vertical, 4)
            }
            if store.isConfigured {
                fileResults
                if scope == .all || scope.isMedia { mediaResults }
                if model.loading { ProgressView("正在检索第二大脑…").frame(maxWidth: .infinity).accessibilityIdentifier("brain.loading") }
                if model.hasMore {
                    Button("加载更多结果") { Task { await reload(append: true) } }
                        .disabled(model.loading).accessibilityIdentifier("brain.load-more")
                }
            } else {
                ContentUnavailableView("第二大脑尚未连接", systemImage: "externaldrive.badge.wifi", description: Text("连接后可检索完整资料库；已有手机收藏仍可在下方打开。"))
            }
            Section {
                NavigationLink { CollectionsView(phoneOnly: true) } label: { Label("手机收藏与收件箱", systemImage: "tray") }
                    .accessibilityIdentifier("brain.phone-collections")
                Link(destination: store.endpoint?.base ?? URL(string: BrainEndpoint.defaultBaseURL)!) {
                    Label("打开第二大脑网页", systemImage: "safari")
                }
            } footer: { Text("资料保留在第二大脑项目中。私密影像只在解锁后浏览，不会自动传给对话模型。") }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("分类检索")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "搜资料、图片内容、视频片段…")
        .scrollDismissesKeyboard(.interactively)
        .toolbar {
            if let onClose { ToolbarItem(placement: .cancellationAction) { Button("完成", action: onClose) } }
        }
        .task(id: "\(query)|\(scope.rawValue)|\(refresh)|\(store.isConfigured)|\(store.baseURLString)|\(store.connectionRevision)|\(mediaUnlocked)") { await reload() }
        .task(id: store.unlock.lastUnlock) {
            clock = Date()
            guard let date = store.unlock.lastUnlock else { model.clearMedia(); return }
            do { try await Task.sleep(for: .seconds(max(0, date.addingTimeInterval(BrainUnlockState.viewValidity).timeIntervalSinceNow))) }
            catch { return }
            clock = Date(); model.clearMedia()
        }
        .onChange(of: scenePhase) { _, phase in
            clock = Date()
            if phase != .active { model.clearMedia() }
        }
        .refreshable { refresh += 1; await store.refreshHealth() }
        .accessibilityIdentifier("brain.workspace")
    }

    @ViewBuilder private var fileResults: some View {
        if !scope.isMedia {
            Section(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? (scope == .files ? "查找文件" : "从知识卡开始") : "资料与知识卡 · \(model.fileTotal)") {
                if let error = model.fileError { recovery(error) }
                if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text("在上方输入关键词检索全库。图片和视频也可直接按类型浏览。")
                        .font(.subheadline).foregroundStyle(.secondary)
                    ForEach(model.cards) { card in
                        NavigationLink {
                            BrainWorkspaceFileDestination(item: BrainSearchItem(type: "card", id: card.id, title: card.title, privacy: "general"), onClose: onClose)
                        } label: { BrainCardRow(card: card) }
                    }
                    if let warning = model.warning { Text(warning).font(.caption).foregroundStyle(.secondary) }
                } else {
                    ForEach(model.files) { item in
                        NavigationLink {
                            BrainWorkspaceFileDestination(item: item, onClose: onClose)
                        } label: { BrainResultRow(item: item) }
                    }
                    if model.files.isEmpty && !model.loading && model.fileError == nil {
                        ContentUnavailableView.search(text: query)
                    }
                }
            }
        }
    }

    @ViewBuilder private var mediaResults: some View {
        Section("图片与视频\(mediaUnlocked ? " · \(model.mediaTotal)" : "")") {
            if !mediaUnlocked {
                Button {
                    Task { await unlock() }
                } label: { Label("解锁图片与视频", systemImage: "faceid").frame(minHeight: 44) }
                Text("需要此设备的私密资料权限。解锁只用于本机浏览。")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                if let error = model.mediaError { recovery(error) }
                if let warning = model.warning, !warning.isEmpty { Text(warning).font(.caption).foregroundStyle(.secondary) }
                ForEach(model.media) { item in
                    NavigationLink { BrainMediaDetailView(item: item) } label: { BrainMediaRow(item: item) }
                }
                if model.media.isEmpty && !model.loading && model.mediaError == nil {
                    ContentUnavailableView("没有匹配的影像", systemImage: "photo.on.rectangle", description: Text("试试日期、地点、已有的人物标签或画面内容。"))
                }
            }
        }
    }

    private func recovery(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(message).foregroundStyle(.secondary)
            HStack {
                Button("重试") { refresh += 1 }
                NavigationLink("连接设置") { BrainSettingsView() }
            }.buttonStyle(.bordered)
        }
    }
    private func reload(append: Bool = false) async {
        await model.load(query: query, scope: scope, includeMedia: mediaUnlocked, append: append)
    }
    @MainActor private func unlock() async {
        unlockError = nil
        guard store.knownScopes?.contains("private") != false else {
            unlockError = "此设备令牌没有私密资料权限，请在连接设置检查。"
            return
        }
        if await store.unlockPrivate() { clock = Date(); refresh += 1 }
        else { unlockError = "未能解锁；资料保持锁定，可重试或检查设备密码与面容 ID。" }
    }
}

private struct BrainWorkspaceFileDestination: View {
    let item: BrainSearchItem
    var onClose: (() -> Void)?
    @State private var sending = false
    @State private var failure: String?
    @State private var quoteRequested = false
    @State private var originalRevision: Int?
    @State private var clock = Date()
    @ObservedObject private var store = BrainStore.shared
    @Environment(\.scenePhase) private var scenePhase
    private var canRead: Bool {
        store.isConfigured && originalRevision == store.connectionRevision && scenePhase == .active
            && (item.privacy == .general || (item.privacy == .private && store.unlock.isFresh(now: clock)))
    }
    var body: some View {
        Group {
            if !canRead { ContentUnavailableView("资料已锁定", systemImage: "lock", description: Text("请返回第二大脑重新打开。")) }
            else if item.isCard { BrainWorkspaceCardView(cardId: item.id) }
            else { BrainFileDetailView(fileId: item.id, title: item.title, privacy: item.privacy, initialLocator: item.match?.locator) }
        }
        .onAppear { if originalRevision == nil { originalRevision = store.connectionRevision } }
        .task(id: quoteRequested) { if quoteRequested { await quote() } }
        .task(id: store.unlock.lastUnlock) {
            clock = Date()
            guard let date = store.unlock.lastUnlock else { return }
            do { try await Task.sleep(for: .seconds(max(0, date.addingTimeInterval(BrainUnlockState.viewValidity).timeIntervalSinceNow))) }
            catch { return }
            clock = Date()
        }
        .onChange(of: scenePhase) { _, _ in clock = Date(); quoteRequested = false }
        .onChange(of: store.connectionRevision) { _, _ in quoteRequested = false }
        .navigationTitle(canRead ? (item.isCard ? "知识卡" : "资料") : "已锁定")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .bottomBar) {
                Button { quoteRequested = true } label: { Label(sending ? "正在准备引用…" : "引用到新对话", systemImage: "text.bubble") }
                    .disabled(sending || !canRead || item.privacy != .general)
            }
        }
        .alert("引用未完成", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("好", role: .cancel) {}
        } message: { Text(failure ?? "") }
    }
    @MainActor private func quote() async {
        let revision = store.connectionRevision
        sending = true; defer { sending = false; quoteRequested = false }
        do {
            let client = try store.requireClient()
            let context: String
            if item.isCard {
                let card = try await client.generalCard(item.id)
                try Task.checkCancellation()
                context = BrainToolFormatter.renderUntrusted(["id":card.id,"title":card.title,"body":String(card.body.prefix(24000)), "sources":card.sources.map { ["file_id":$0.fileId,"locator":$0.locator ?? ""] }], element: "brain_reference")
            } else {
                let meta = try await client.file(item.id).0
                try Task.checkCancellation()
                guard revision == store.connectionRevision else { throw CancellationError() }
                guard meta.privacy == .general else { throw BrainError.forbidden("私密资料不能引用到云端对话。") }
                let page = try await client.chunks(item.id, offset: 0, locator: item.match?.locator).0
                context = BrainToolFormatter.readOutput(meta: meta, page: page, offset: 0, location: .cloud)
            }
            try Task.checkCancellation()
            guard canRead, revision == store.connectionRevision else { throw CancellationError() }
            ShareCoordinator.shared.storeBuffer(PendingShare(items: [], timestamp: Date(), instruction: "请基于我选中的第二大脑资料回答，保留来源引用。", treasuryContext: context))
            onClose?()
            NotificationCenter.default.post(name: .newChatRequested, object: nil)
        } catch { if !Task.isCancelled && !(error is CancellationError) { failure = (error as? BrainError)?.message ?? BrainError.network.message } }
    }
}

private struct BrainMediaRow: View {
    let item: BrainMediaItem
    @State private var image: UIImage?
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Group {
                if let image { Image(uiImage: image).resizable().scaledToFill() }
                else { Image(systemName: item.isVideo ? "video" : "photo").font(.title2).foregroundStyle(.secondary) }
            }.frame(width: 84, height: 72).background(Color.secondary.opacity(0.08)).clipShape(RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 4) {
                Text(item.title).font(.headline).lineLimit(2)
                Text([item.capturedAt.map { String($0.prefix(10)) }, item.place].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
                Text(item.isVideo ? "视频 · 查看片段与转写" : "图片 · 查看画面与文字").font(.caption).foregroundStyle(.secondary)
            }
        }.padding(.vertical, 4)
        .task(id: item.id) {
            guard BrainStore.shared.isUnlockFresh(), let client = BrainStore.shared.client() else { return }
            if let data = try? await client.mediaBytes(item.id, variant: "thumbnail"), !Task.isCancelled, BrainStore.shared.isUnlockFresh() { image = UIImage(data: data) }
        }
        .onDisappear { image = nil }
    }
}

private struct BrainMediaDetailView: View {
    let item: BrainMediaItem
    @ObservedObject private var store = BrainStore.shared
    @Environment(\.scenePhase) private var scenePhase
    @State private var clock = Date()
    @State private var detail: BrainMediaItem?
    @State private var image: UIImage?
    @State private var player: AVPlayer?
    @State private var temporaryVideo: URL?
    @State private var error: String?
    @State private var loading = false
    @State private var retry = 0
    @State private var originalRevision: Int?
    private var allowed: Bool { store.isConfigured && originalRevision == store.connectionRevision && store.unlock.isFresh(now: clock) && scenePhase == .active }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if allowed {
                    if let player { VideoPlayer(player: player).frame(minHeight: 240, idealHeight: 420) }
                    else if let image { Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 600).clipShape(RoundedRectangle(cornerRadius: 16)) }
                    if loading { ProgressView("载入影像…") }
                    Text((detail ?? item).title).font(.title2.bold())
                    Text([item.capturedAt, item.place].compactMap { $0 }.joined(separator: " · ")).font(.subheadline).foregroundStyle(.secondary)
                    if let text = detail?.description, !text.isEmpty {
                        Text("内容线索 · 可能含自动生成描述").font(.headline)
                        Text(text).textSelection(.enabled)
                    }
                    if let ocr = detail?.ocr, !ocr.isEmpty { Text("画面文字").font(.headline); Text(ocr).textSelection(.enabled) }
                    ForEach(Array((detail?.segments ?? []).enumerated()), id: \.offset) { _, segment in
                        VStack(alignment: .leading, spacing: 6) {
                            Button { player?.seek(to: CMTime(seconds: segment.start, preferredTimescale: 600)) } label: {
                                Label(String(format: "%02d:%02d", Int(segment.start) / 60, Int(segment.start) % 60), systemImage: "play.circle")
                            }.disabled(player == nil)
                            Text(segment.text).textSelection(.enabled)
                        }
                    }
                    if let error {
                        Text(error).foregroundStyle(.secondary)
                        Button("重试") { retry += 1 }
                    }
                    Text("私密影像仅在本机显示，不会附加到云端对话。人物关系沿用已有标签，自动描述不等于身份确认。")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    ContentUnavailableView("影像已锁定", systemImage: "lock", description: Text("返回第二大脑重新解锁后查看。"))
                }
            }.padding(20).frame(maxWidth: 880, alignment: .leading).frame(maxWidth: .infinity)
        }.navigationTitle(item.isVideo ? "视频" : "图片").navigationBarTitleDisplayMode(.inline)
        .onAppear { if originalRevision == nil { originalRevision = store.connectionRevision } }
        .task(id: "\(allowed)|\(retry)|\(store.connectionRevision)") { if allowed { await load() } else { clear() } }
        .task(id: store.unlock.lastUnlock) {
            clock = Date()
            guard let date = store.unlock.lastUnlock else { clear(); return }
            do { try await Task.sleep(for: .seconds(max(0, date.addingTimeInterval(BrainUnlockState.viewValidity).timeIntervalSinceNow))) }
            catch { return }
            clock = Date(); clear()
        }
        .onChange(of: scenePhase) { _, phase in clock = Date(); if phase != .active { clear() } }
        .onDisappear { clear() }
    }
    @MainActor private func load() async {
        clear(); loading = true; error = nil
        defer { loading = false }
        do {
            let client = try store.requireClient()
            let result = try await client.mediaDetail(item.id)
            guard !Task.isCancelled, store.isUnlockFresh(), allowed else { return }
            detail = result
            let bytes = try await client.mediaBytes(item.id, variant: item.isVideo ? "video" : "preview")
            guard !Task.isCancelled, store.isUnlockFresh(), allowed else { return }
            if item.isVideo {
                let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mp4")
                try bytes.write(to: url, options: [.atomic, .completeFileProtection])
                temporaryVideo = url; player = AVPlayer(url: url)
            } else { image = UIImage(data: bytes); if image == nil { throw BrainError.invalidResponse } }
        } catch { if !Task.isCancelled && allowed { self.error = (error as? BrainError)?.message ?? BrainError.network.message } }
    }
    private func clear() {
        player?.pause(); player = nil; image = nil; detail = nil
        if let temporaryVideo { try? FileManager.default.removeItem(at: temporaryVideo) }
        temporaryVideo = nil
    }
}

private struct BrainWorkspaceCardView: View {
    let cardId: String
    @State private var card: BrainCard?
    @State private var error: String?
    @State private var retry = 0
    @ObservedObject private var store = BrainStore.shared
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let card, store.isConfigured {
                    Text(card.title).font(.title2.bold())
                    Text(card.body).textSelection(.enabled)
                    ForEach(Array(card.sources.enumerated()), id: \.offset) { _, source in
                        NavigationLink {
                            BrainFileDetailView(fileId: source.fileId, title: "来源资料", privacy: .general, initialLocator: source.locator)
                        } label: { Label(source.locator ?? "查看来源", systemImage: "doc.text.magnifyingglass") }
                    }
                } else if let error {
                    Text(error).foregroundStyle(.secondary)
                    Button("重试") { retry += 1 }
                } else { ProgressView("读取知识卡…") }
            }.padding(20).frame(maxWidth: 880, alignment: .leading).frame(maxWidth: .infinity)
        }.navigationTitle("知识卡").navigationBarTitleDisplayMode(.inline)
        .task(id: "\(cardId)|\(retry)|\(store.isConfigured)|\(store.baseURLString)|\(store.connectionRevision)") {
            card = nil; error = nil
            do {
                let value = try await store.requireClient().generalCard(cardId)
                guard !Task.isCancelled, store.isConfigured else { return }
                card = value
            } catch { if !Task.isCancelled { self.error = (error as? BrainError)?.message ?? BrainError.network.message } }
        }
    }
}
