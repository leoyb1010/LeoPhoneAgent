//
//  BrainLibraryView.swift
//  LeoPhoneAgent
//
//  [brain-space] 资料:统一检索(文档、知识卡、照片)、手机收藏入口、阅读页
//  (原件在哪、文字识别页状态和只补读失败页、正文)、低频页面的网页兜底。
//

import SwiftUI

struct BrainDocTarget: Hashable { let id: String; let title: String }

struct BrainLibraryView: View {
    @EnvironmentObject private var model: BrainSpaceModel
    @ObservedObject private var store = BrainStore.shared
    /// 搜索状态与任务归 BrainSearchModel 所有(见 BrainSpaceModels.swift);这里只绑定输入和显示。
    @StateObject private var search = BrainSearchModel(load: BrainLibraryView.loadSearch)
    @State private var uploads: [BrainUploadState] = []

    private let webPages: [(String, String, String)] = [
        ("devices", "设备与存储", "internaldrive"), ("protection", "保护与备份", "lock.shield"),
        ("cards", "知识卡", "rectangle.stack"), ("review", "待审阅", "checkmark.rectangle.stack"),
        ("pipeline", "新资料处理", "gearshape.2"), ("timeline", "时间线", "clock"), ("system", "系统", "gearshape"),
    ]

    var body: some View {
        List {
            if search.query.isEmpty {
                Section {
                    Button { model.showPhoneCollections = true } label: {
                        Label { VStack(alignment: .leading) { Text("手机收藏"); Text("分享进来的链接、语音和文件,不联网也能用").font(.caption).foregroundStyle(.secondary) } }
                        icon: { Image(systemName: "star.square.on.square") }
                    }
                }
                Section {
                    Button { model.showWorkspace = true } label: {
                        Label { VStack(alignment: .leading) { Text("分类检索"); Text("全库、文件、图片、视频、知识卡;私密影像解锁后在本机看").font(.caption).foregroundStyle(.secondary) } }
                        icon: { Image(systemName: "square.grid.2x2") }
                    }
                    .accessibilityIdentifier("brain.workspace")
                }
                if !uploads.isEmpty {
                    Section("最近发到资料库的") {
                        ForEach(uploads.prefix(5), id: \.id) { u in
                            HStack {
                                Image(systemName: u.state == "received" ? "checkmark.circle" : "arrow.up.circle").foregroundStyle(.secondary)
                                Text(u.receipt?.name ?? u.name ?? "文件").lineLimit(1)
                                Spacer()
                                Text(u.state == "received" ? "已收到" : "未传完").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                Section("更多") {
                    ForEach(webPages, id: \.0) { page in
                        Button { model.webPage = BrainWebPage(id: page.0, title: page.1) } label: {
                            Label { HStack { Text(page.1); Spacer(); Text("网页").font(.caption).foregroundStyle(.tertiary) } }
                            icon: { Image(systemName: page.2) }
                        }
                    }
                }
            } else {
                Section(search.searching ? "正在搜…" : "找到 \(search.total) 项") {
                    ForEach(search.results) { item in resultRow(item) }
                }
                if let error = search.error { BrainErrorRow(message: error) { search.submit() } }
            }
        }
        .listStyle(.insetGrouped)
        .buttonStyle(.plain)
        .searchable(text: $search.query, placement: .navigationBarDrawer(displayMode: .always), prompt: "搜文档、知识卡、照片")
        // Typing is debounced inside the model (query didSet); submit is immediate.
        .onSubmit(of: .search) { search.submit() }
        // 换了连接:旧结果立即失效;页面隐藏时只作废,不发新搜索,回来再按 revision 补一次。
        .onChange(of: store.connectionRevision) { _, revision in search.connectionChanged(to: revision) }
        .onAppear { search.appear(revision: store.connectionRevision) }
        .onDisappear { search.disappear() }
        .task(id: store.connectionRevision) {
            let revision = store.connectionRevision
            uploads = []
            let list = (try? await BrainSpaceAPI.shared.get("/uploads", query: [("limit", "10")], as: BrainUploadList.self).items) ?? []
            guard !Task.isCancelled, revision == store.connectionRevision else { return }
            uploads = list
        }
        .navigationDestination(for: BrainDocTarget.self) { BrainDocView(target: $0) }
        .navigationDestination(for: BrainSpaceMediaRow.self) { BrainSpaceMediaDetailView(row: $0) }
    }

    @ViewBuilder private func resultRow(_ item: BrainSearchPage.Item) -> some View {
        let kind = item.storedKind ?? item.kind ?? ""
        let isMedia = kind == "media" || item.mediaKind != nil
        let content = HStack(alignment: .top, spacing: 12) {
            if isMedia {
                BrainRemoteImage(path: item.thumbnailUrl ?? "/api/media/\(item.id)/thumbnail")
                    .frame(width: 44, height: 44).clipShape(RoundedRectangle(cornerRadius: 6))
            } else {
                Image(systemName: kind == "card" ? "rectangle.stack" : "doc.text")
                    .frame(width: 44, height: 44).background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 6))
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title ?? "资料").font(.subheadline.weight(.medium)).lineLimit(2)
                let excerpt = item.match?.excerpt ?? BrainFormat.plain(item.summary)
                if !excerpt.isEmpty { Text(excerpt).font(.footnote).foregroundStyle(.secondary).lineLimit(2) }
                Text([item.category, item.match?.locator].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.tertiary)
            }
        }
        if isMedia {
            NavigationLink(value: BrainSpaceMediaRow(id: item.id, title: item.title, ext: item.ext, mediaKind: item.mediaKind)) { content }
        } else if kind == "card" {
            Button { model.webPage = BrainWebPage(id: "card/" + item.id, title: item.title ?? "知识卡") } label: { content }.buttonStyle(.plain)
        } else {
            NavigationLink(value: BrainDocTarget(id: item.id, title: item.title ?? "资料")) { content }
        }
    }

    /// Production loader for BrainSearchModel. A cancelled URLSession request surfaces as a cancellation, not a network error.
    @MainActor private static func loadSearch(_ q: String) async throws -> BrainSearchPage {
        do {
            return try await BrainSpaceAPI.shared.get("/search", query: [("q", q), ("limit", "30")])
        } catch {
            if Task.isCancelled { throw CancellationError() }
            throw error
        }
    }
}

// MARK: - Reader

struct BrainDocView: View {
    @EnvironmentObject private var model: BrainSpaceModel
    @ObservedObject private var store = BrainStore.shared
    let target: BrainDocTarget
    /// 读取周期、分页与身份校验归 BrainReaderModel(BrainSpaceModels.swift);这里只显示和驱动生命周期。
    @StateObject private var reader = BrainReaderModel(makeLoaders: BrainDocView.makeLoaders)
    /// The OCR retry in flight. Leaving or switching connection clears it; an older retry's cleanup never clears a newer one.
    @State private var ocrRetry: UUID?
    private var retrying: Bool { ocrRetry != nil }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(reader.info?.title ?? target.title).font(.title3.weight(.semibold))
                    Text([reader.info?.category, reader.info?.ext, reader.info.map { BrainFormat.bytes($0.size) }].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Button { model.ask("这份资料讲了什么?有哪些关键结论?", fileIds: [target.id]) } label: {
                    Label("问这份资料", systemImage: "bubble.left")
                }
                if let infoError = reader.infoError { BrainErrorRow(message: infoError) { reader.retry() } }
            }
            if let locs = reader.provenance?.locations, !locs.isEmpty {
                Section("原件在哪") {
                    ForEach(locs) { l in
                        HStack(alignment: .top) {
                            Image(systemName: l.available == true ? "checkmark.circle" : "exclamationmark.circle")
                                .foregroundStyle(l.available == true ? Color.secondary : Color.orange)
                            VStack(alignment: .leading, spacing: 2) {
                                Text((l.role == "original" ? "原件 · " : "备份 · ") + (l.sourceName ?? "位置") + (l.available == true ? " · 当前可达" : " · 现在取不到"))
                                    .font(.subheadline)
                                if let p = l.relativePath { Text(p).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                                if let v = l.contentVerifiedAt { Text("内容核对过 \(BrainFormat.day(v))").font(.caption2).foregroundStyle(.tertiary) }
                            }
                        }
                    }
                }
            }
            if let o = reader.ocr, let required = o.requiredPages, !required.isEmpty { ocrSection(o, required: required) }
            Section(reader.chunkTotal > 0 ? "正文 · 共 \(reader.chunkTotal) 段" : "正文") {
                if let bodyError = reader.bodyError {
                    BrainErrorRow(message: bodyError) { reader.retry() }
                } else if reader.bodyLoading {
                    HStack(spacing: 8) { ProgressView(); Text("正在读正文…").font(.subheadline).foregroundStyle(.secondary) }
                } else if !reader.bodyLoaded {
                    // Not loading and not loaded (e.g. the read was cancelled): offer a way back instead of a stuck spinner.
                    Button("重新读取正文") { reader.retry() }
                } else if reader.chunks.isEmpty {
                    Text(reader.info?.summary.flatMap { $0.isEmpty ? nil : $0 } ?? "还没有可读的正文").font(.subheadline).foregroundStyle(.secondary)
                }
                ForEach(reader.chunks) { c in
                    VStack(alignment: .leading, spacing: 4) {
                        if let l = c.locator { Text(l).font(.caption).foregroundStyle(.tertiary) }
                        Text(c.text).font(.subheadline).textSelection(.enabled)
                    }
                }
                if let moreError = reader.moreError {
                    Text(moreError).font(.footnote).foregroundStyle(.secondary)
                }
                if reader.hasMore {
                    Button(reader.moreLoading ? "正在读…" : (reader.moreError == nil ? "再读 12 段" : "重试读取下一批")) { reader.loadMore() }
                        .disabled(reader.moreLoading)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("阅读")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { reader.appear(docId: target.id, revision: store.connectionRevision) }
        .onDisappear { reader.disappear(); ocrRetry = nil }
        .onChange(of: store.connectionRevision) { _, revision in ocrRetry = nil; reader.connectionChanged(to: revision) }
    }

    /// One reading cycle = one BrainClient (memory only): pages reuse its session; a new cycle or connection gets a new one.
    /// Body pages keep going through BrainClient.chunks (the existing access path), not the raw app API.
    @MainActor private static func makeLoaders() throws -> BrainReaderModel.Loaders {
        guard let client = BrainStore.shared.client() else { throw BrainSpaceError.notConfigured }
        let api = BrainSpaceAPI.shared
        // The cycle's metadata reads use one captured configuration, like its chunk pages use one client.
        let cfg = try api.config()
        return BrainReaderModel.Loaders(
            info: { id in try await api.get("/files/\(id)", config: cfg) },
            provenance: { id in try await api.get("/files/\(id)/provenance", config: cfg) },
            ocr: { id in try await api.get("/files/\(id)/ocr", config: cfg) },
            chunks: { id, offset in try await client.chunks(id, offset: offset).0 })
    }

    private func ocrSection(_ o: BrainOCRStatus, required: [Int]) -> some View {
        let missing = Array(Set((o.pendingPages ?? []) + (o.failedPages ?? []))).sorted()
        return Section {
            Text("需要识别的 \(required.count) 页里,已读出 \(o.completedPages?.count ?? 0) 页").font(.subheadline)
            if !missing.isEmpty {
                ForEach(missing.prefix(20), id: \.self) { page in
                    Button {
                        if reader.pickedPages.contains(page) { reader.pickedPages.remove(page) } else { reader.pickedPages.insert(page) }
                    } label: {
                        Label("第 \(page) 页 · \((o.failedPages ?? []).contains(page) ? "没读出来" : "待识别")",
                              systemImage: reader.pickedPages.contains(page) ? "checkmark.circle.fill" : "circle")
                    }
                }
                Button(retrying ? "正在补读…" : "只补读选中的 \(reader.pickedPages.count) 页") { Task { await retry(o) } }
                    .disabled(reader.pickedPages.isEmpty || retrying || model.manifest?.can.upload != true)
            }
        } header: { Text("文字识别") } footer: {
            Text("补读只处理选中的页;已读好的页、正文和笔记都保留。")
        }
    }

    private func retry(_ o: BrainOCRStatus) async {
        // Freeze everything this write acts on before the first await: cycle (doc + connection + generation),
        // connection configuration, sha and the chosen pages. Later changes on screen never feed into it.
        guard ocrRetry == nil, let cycle = reader.currentCycle, cycle.docId == target.id,
              let sha = o.sha256 ?? reader.info?.sha256 else { return }
        let pages = reader.pickedPages.sorted()
        guard !pages.isEmpty else { return }
        let cfg: BrainSpaceAPI.Config
        do { cfg = try BrainSpaceAPI.shared.config() } catch { model.say(error.localizedDescription); return }
        let op = UUID()
        ocrRetry = op
        defer { if ocrRetry == op { ocrRetry = nil } }
        do {
            let _: BrainOK = try await BrainSpaceAPI.shared.post("/files/\(cycle.docId)/ocr/retry", ["sha256": sha, "pages": pages], config: cfg)
            guard ocrRetry == op, reader.isCurrent(cycle) else { return }
            model.say("已开始补读 \(pages.count) 页")
            await reader.reloadOCR(for: cycle)
        } catch {
            guard ocrRetry == op, reader.isCurrent(cycle), !(error is CancellationError) else { return }
            model.say(error.localizedDescription)
        }
    }
}
