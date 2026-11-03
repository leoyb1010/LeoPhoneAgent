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
    @State private var query = ""
    @State private var results: [BrainSearchPage.Item] = []
    @State private var total = 0
    @State private var searching = false
    @State private var error: String?
    @State private var uploads: [BrainUploadState] = []

    private let webPages: [(String, String, String)] = [
        ("devices", "设备与存储", "internaldrive"), ("protection", "保护与备份", "lock.shield"),
        ("cards", "知识卡", "rectangle.stack"), ("review", "待审阅", "checkmark.rectangle.stack"),
        ("pipeline", "新资料处理", "gearshape.2"), ("timeline", "时间线", "clock"), ("system", "系统", "gearshape"),
    ]

    var body: some View {
        List {
            if query.isEmpty {
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
                Section(searching ? "正在搜…" : "找到 \(total) 项") {
                    ForEach(results) { item in resultRow(item) }
                }
                if let error { BrainErrorRow(message: error) { Task { await search() } } }
            }
        }
        .listStyle(.insetGrouped)
        .buttonStyle(.plain)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "搜文档、知识卡、照片")
        .onSubmit(of: .search) { Task { await search() } }
        .task(id: query) {
            // Search as you type, after a short pause.
            if query.trimmingCharacters(in: .whitespaces).isEmpty { results = []; total = 0; error = nil; return }
            try? await Task.sleep(for: .milliseconds(400))
            if !Task.isCancelled { await search() }
        }
        .task { uploads = (try? await BrainSpaceAPI.shared.get("/uploads", query: [("limit", "10")], as: BrainUploadList.self).items) ?? [] }
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

    private func search() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        searching = true; error = nil
        defer { searching = false }
        do {
            let page: BrainSearchPage = try await BrainSpaceAPI.shared.get("/search", query: [("q", q), ("limit", "30")])
            results = page.items; total = page.total ?? page.items.count
        } catch {
            results = []; self.error = error.localizedDescription
        }
    }
}

// MARK: - Reader

struct BrainDocView: View {
    @EnvironmentObject private var model: BrainSpaceModel
    let target: BrainDocTarget
    @State private var info: BrainFileInfo?
    @State private var provenance: BrainProvenance?
    @State private var ocr: BrainOCRStatus?
    @State private var chunks: [BrainChunk] = []
    @State private var chunkTotal = 0
    @State private var error: String?
    @State private var retrying = false
    @State private var pickedPages: Set<Int> = []

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(info?.title ?? target.title).font(.title3.weight(.semibold))
                    Text([info?.category, info?.ext, info.map { BrainFormat.bytes($0.size) }].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Button { model.ask("这份资料讲了什么?有哪些关键结论?", fileIds: [target.id]) } label: {
                    Label("问这份资料", systemImage: "bubble.left")
                }
            }
            if let locs = provenance?.locations, !locs.isEmpty {
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
            if let o = ocr, let required = o.requiredPages, !required.isEmpty { ocrSection(o, required: required) }
            Section(chunkTotal > 0 ? "正文 · 共 \(chunkTotal) 段" : "正文") {
                if chunks.isEmpty && error == nil { Text(info?.summary.flatMap { $0.isEmpty ? nil : $0 } ?? "还没有可读的正文").font(.subheadline).foregroundStyle(.secondary) }
                ForEach(chunks) { c in
                    VStack(alignment: .leading, spacing: 4) {
                        if let l = c.locator { Text(l).font(.caption).foregroundStyle(.tertiary) }
                        Text(c.text).font(.subheadline).textSelection(.enabled)
                    }
                }
                if chunks.count < chunkTotal { Button("再读 12 段") { Task { await moreChunks() } } }
            }
            if let error { BrainErrorRow(message: error) { Task { await load() } } }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("阅读")
        .navigationBarTitleDisplayMode(.inline)
        .task { if info == nil { await load() } }
    }

    private func ocrSection(_ o: BrainOCRStatus, required: [Int]) -> some View {
        let missing = Array(Set((o.pendingPages ?? []) + (o.failedPages ?? []))).sorted()
        return Section {
            Text("需要识别的 \(required.count) 页里,已读出 \(o.completedPages?.count ?? 0) 页").font(.subheadline)
            if !missing.isEmpty {
                ForEach(missing.prefix(20), id: \.self) { page in
                    Button {
                        if pickedPages.contains(page) { pickedPages.remove(page) } else { pickedPages.insert(page) }
                    } label: {
                        Label("第 \(page) 页 · \((o.failedPages ?? []).contains(page) ? "没读出来" : "待识别")",
                              systemImage: pickedPages.contains(page) ? "checkmark.circle.fill" : "circle")
                    }
                }
                Button(retrying ? "正在补读…" : "只补读选中的 \(pickedPages.count) 页") { Task { await retry(o) } }
                    .disabled(pickedPages.isEmpty || retrying || model.manifest?.can.upload != true)
            }
        } header: { Text("文字识别") } footer: {
            Text("补读只处理选中的页;已读好的页、正文和笔记都保留。")
        }
    }

    private func load() async {
        error = nil
        let api = BrainSpaceAPI.shared
        async let p: BrainProvenance = api.get("/files/\(target.id)/provenance")
        async let o: BrainOCRStatus = api.get("/files/\(target.id)/ocr")
        do {
            info = try await api.get("/files/\(target.id)")
        } catch {
            self.error = error.localizedDescription
        }
        provenance = try? await p
        ocr = try? await o
        pickedPages = Set(((ocr?.pendingPages ?? []) + (ocr?.failedPages ?? [])).prefix(20))
        await moreChunks()
    }

    private func moreChunks() async {
        guard let client = BrainStore.shared.client(),
              let page = try? await client.chunks(target.id, offset: chunks.count) else { return }
        chunkTotal = page.0.total
        chunks += page.0.chunks
    }

    private func retry(_ o: BrainOCRStatus) async {
        guard let sha = o.sha256 ?? info?.sha256 else { return }
        retrying = true
        defer { retrying = false }
        do {
            let _: BrainOK = try await BrainSpaceAPI.shared.post("/files/\(target.id)/ocr/retry", ["sha256": sha, "pages": pickedPages.sorted()])
            model.say("已开始补读 \(pickedPages.count) 页")
            ocr = try? await BrainSpaceAPI.shared.get("/files/\(target.id)/ocr")
        } catch { model.say(error.localizedDescription) }
    }
}

