//
//  BrainMediaView.swift
//  LeoPhoneAgent
//
//  [brain-space] 影像:按家人筛选、按月分组的照片视频网格(分页加载),详情、视频播放、
//  一次分享一组(最多 12 项,Face ID)和逐项/整组撤销。
//

import AVKit
import SwiftUI

struct BrainMediaView: View {
    @EnvironmentObject private var model: BrainSpaceModel
    @State private var query = ""
    @State private var kind = "all"
    @State private var family: [BrainFamilyMember] = []
    @State private var items: [BrainMediaRow] = []
    @State private var total = 0
    @State private var loading = false
    @State private var error: String?
    @State private var generation = 0
    @State private var selecting = false
    @State private var selected: [String] = []
    @State private var share: BrainShareResult?

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 2), count: 4)

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                filters
                ForEach(groups, id: \.0) { month, rows in
                    Section {
                        LazyVGrid(columns: columns, spacing: 2) {
                            ForEach(rows) { row in tile(row) }
                        }
                    } header: {
                        Text(BrainFormat.monthTitle(month)).font(.headline)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 16).padding(.vertical, 8)
                            .background(.bar)
                    }
                }
                if loading { ProgressView().frame(maxWidth: .infinity).padding() }
                if let error { BrainErrorRow(message: error) { Task { await reload() } } }
                if !loading, error == nil, items.isEmpty { BrainErrorRow(message: "没有符合条件的照片或视频") }
            }
        }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "去年夏天布布在海边")
        .onSubmit(of: .search) { Task { await reload() } }
        .onChange(of: query) { _, q in if q.isEmpty { Task { await reload() } } }
        .onChange(of: kind) { _, _ in Task { await reload() } }
        .onChange(of: model.mediaPerson) { _, _ in Task { await reload() } }
        .task {
            if family.isEmpty { family = (try? await BrainSpaceAPI.shared.get("/family", as: BrainFamilyList.self).items) ?? [] }
            if items.isEmpty { await reload() }
        }
        .refreshable { await reload() }
        .navigationDestination(for: BrainMediaRow.self) { BrainMediaDetailView(row: $0) }
        .toolbar {
            ToolbarItem(placement: .secondaryAction) {
                Button(selecting ? "取消选择" : "选择后分享") { selecting.toggle(); selected = [] }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if selecting {
                Button {
                    Task { await shareSelected() }
                } label: {
                    Text(selected.isEmpty ? "选择最多 12 项" : "分享 \(selected.count) 项给家人").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .disabled(selected.isEmpty || model.manifest?.can.share != true)
                .padding(.horizontal, 16).padding(.bottom, 8)
            }
        }
        .sheet(item: $share) { BrainShareResultSheet(result: $0).environmentObject(model).tint(BrainTheme.accent) }
    }

    private var groups: [(String, [BrainMediaRow])] {
        var order: [String] = []
        var map: [String: [BrainMediaRow]] = [:]
        for row in items {
            if map[row.month] == nil { order.append(row.month) }
            map[row.month, default: []].append(row)
        }
        return order.map { ($0, map[$0] ?? []) }
    }

    private var filters: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("类型", selection: $kind) {
                Text("全部").tag("all"); Text("照片").tag("photo"); Text("视频").tag("video")
            }
            .pickerStyle(.segmented)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 14) {
                    ForEach(family) { m in
                        Button { model.mediaPerson = model.mediaPerson == m ? nil : m } label: {
                            VStack(spacing: 4) {
                                BrainAvatar(path: m.avatar, name: m.name, size: 50)
                                    .overlay(Circle().stroke(model.mediaPerson == m ? BrainTheme.accent : .clear, lineWidth: 2.5))
                                Text(m.name).font(.caption2).foregroundStyle(model.mediaPerson == m ? .primary : .secondary)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(model.mediaPerson == m ? .isSelected : [])
                    }
                }
                .padding(.vertical, 2)
            }
            Text(total > 0 ? "\(total) 项" + (model.mediaPerson.map { " · \($0.name)" } ?? "") : " ")
                .font(.footnote).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 6)
    }

    @ViewBuilder private func tile(_ row: BrainMediaRow) -> some View {
        let picked = selected.contains(row.id)
        let cell = BrainRemoteImage(path: row.thumbPath)
            .aspectRatio(1, contentMode: .fill)
            .overlay(alignment: .bottomTrailing) {
                if row.isVideo { Image(systemName: "play.fill").font(.caption2).foregroundStyle(.white).padding(5).shadow(radius: 2) }
            }
            .overlay(alignment: .topTrailing) {
                if selecting {
                    Image(systemName: picked ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(picked ? BrainTheme.accent : .white).padding(5).shadow(radius: 2)
                }
            }
            .onAppear { if row.id == items.last?.id { Task { await more() } } }
        if selecting {
            Button {
                if picked { selected.removeAll { $0 == row.id } } else if selected.count < 12 { selected.append(row.id) }
            } label: { cell }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(picked ? "已选" : "未选"))
        } else {
            NavigationLink(value: row) { cell }.buttonStyle(.plain)
                .accessibilityLabel(Text("\(row.isVideo ? "视频" : "照片") \(BrainFormat.day(row.capturedAt))"))
        }
    }

    // MARK: Data

    private func params(offset: Int) -> [(String, String)] {
        var q: [(String, String)] = [("q", query), ("kind", kind), ("limit", "90"), ("offset", String(offset)), ("smart", "1")]
        if let p = model.mediaPerson { q.append(("people", p.id)) }
        return q
    }

    private func reload() async {
        generation += 1
        let gen = generation
        loading = true; error = nil
        defer { if gen == generation { loading = false } }
        do {
            let page: BrainMediaPage = try await BrainSpaceAPI.shared.get("/media/search", query: params(offset: 0))
            guard gen == generation else { return }
            items = page.items; total = page.total ?? page.items.count
        } catch {
            guard gen == generation else { return }
            items = []; self.error = error.localizedDescription
        }
    }

    private func more() async {
        guard !loading, items.count < total else { return }
        let gen = generation
        loading = true
        defer { if gen == generation { loading = false } }
        if let page = try? await BrainSpaceAPI.shared.get("/media/search", query: params(offset: items.count), as: BrainMediaPage.self),
           gen == generation {
            let known = Set(items.map(\.id))
            items += page.items.filter { !known.contains($0.id) }
        }
    }

    private func shareSelected() async {
        guard await BrainAuth.confirm("把选中的 \(selected.count) 项分享给家人") else { return }
        do {
            share = try await BrainSpaceAPI.shared.post("/shares", ["file_ids": selected, "days": 7, "audience": "family"])
            selecting = false; selected = []
        } catch {
            model.say(error.localizedDescription)
        }
    }
}

// MARK: - Detail

struct BrainMediaDetailView: View {
    @EnvironmentObject private var model: BrainSpaceModel
    let row: BrainMediaRow
    @State private var detail: BrainMediaDetail?
    @State private var error: String?
    @State private var player: AVPlayer?
    @State private var share: BrainShareResult?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                visual
                if let d = detail { info(d) }
                if let error { BrainErrorRow(message: error) { Task { await load() } } }
            }
            .padding(.bottom, 24)
        }
        .navigationTitle(BrainFormat.day(detail?.capturedAt ?? row.capturedAt))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .onDisappear { player?.pause() }
        .sheet(item: $share) { BrainShareResultSheet(result: $0).environmentObject(model).tint(BrainTheme.accent) }
    }

    @ViewBuilder private var visual: some View {
        if let player {
            VideoPlayer(player: player).aspectRatio(aspect, contentMode: .fit).frame(maxWidth: .infinity)
        } else {
            BrainRemoteImage(path: "/api/media/\(row.id)/preview", contentMode: .fit)
                .aspectRatio(aspect, contentMode: .fit)
                .frame(maxWidth: .infinity)
                .overlay {
                    if detail?.isVideo == true || row.isVideo {
                        Button { startVideo() } label: {
                            Image(systemName: "play.circle.fill").font(.system(size: 64)).foregroundStyle(.white).shadow(radius: 6)
                        }
                        .accessibilityLabel(Text("播放视频"))
                    }
                }
        }
    }

    private var aspect: CGFloat {
        guard let w = detail?.width, let h = detail?.height, w > 0, h > 0 else { return 3.0 / 4.0 }
        return CGFloat(w / h)
    }

    private func info(_ d: BrainMediaDetail) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            let place = (d.place?.isEmpty == false ? d.place : d.placeGuess?.place.map { $0 + "(推测)" }) ?? ""
            Text([BrainFormat.day(d.capturedAt), place].filter { !$0.isEmpty }.joined(separator: " · "))
                .font(.subheadline).foregroundStyle(.secondary)
            if let who = d.who, !who.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(who, id: \.self) { w in
                            Text(w.name).font(.footnote).padding(.horizontal, 10).padding(.vertical, 4)
                                .background(Color(.secondarySystemFill), in: Capsule())
                        }
                    }
                }
            }
            if let text = d.ai?.description, !text.isEmpty {
                Text(text).font(.body)
                Text("画面描述由模型识别,可能有误").font(.caption).foregroundStyle(.tertiary)
            }
            HStack(spacing: 10) {
                Button { model.ask("这张\(d.isVideo ? "视频" : "照片")是在哪、什么时候拍的?当时在做什么?", fileIds: [row.id]) } label: {
                    Label("问这张", systemImage: "bubble.left").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                Button { Task { await shareOne() } } label: {
                    Label("分享给家人", systemImage: "person.2").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.manifest?.can.share != true)
            }
            .controlSize(.large)
        }
        .padding(.horizontal, 16)
    }

    private func load() async {
        error = nil
        do { detail = try await BrainSpaceAPI.shared.get("/media/\(row.id)") } catch { self.error = error.localizedDescription }
    }

    private func startVideo() {
        guard let url = try? BrainSpaceAPI.shared.apiURL("/media/\(row.id)/video") else { return }
        let asset = AVURLAsset(url: url, options: ["AVURLAssetHTTPHeaderFieldsKey": BrainSpaceAPI.shared.authorizedHeaders()])
        let p = AVPlayer(playerItem: AVPlayerItem(asset: asset))
        player = p
        p.play()
    }

    private func shareOne() async {
        guard await BrainAuth.confirm("把这张分享给家人") else { return }
        do { share = try await BrainSpaceAPI.shared.post("/shares", ["file_ids": [row.id], "days": 7, "audience": "family"]) }
        catch { model.say(error.localizedDescription) }
    }
}

// MARK: - Share result

struct BrainShareResultSheet: View {
    @EnvironmentObject private var model: BrainSpaceModel
    @Environment(\.dismiss) private var dismiss
    let result: BrainShareResult
    @State private var revoked = false

    private var link: URL? {
        guard let base = BrainSpaceAPI.shared.webBase else { return nil }
        return URL(string: base.absoluteString + "/family" + result.path)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label(revoked ? "已撤销,链接不能再打开" : "家人账户登录后可以看,\(BrainFormat.day(result.expiresAt)) 前有效",
                          systemImage: revoked ? "xmark.circle" : "checkmark.circle")
                    if let link, !revoked {
                        ShareLink(item: link) { Label("发送链接", systemImage: "square.and.arrow.up") }
                        Button { UIPasteboard.general.url = link; model.say("链接已复制") } label: { Label("复制链接", systemImage: "doc.on.doc") }
                        Button { preview() } label: {
                            Label("先看对方看到的样子", systemImage: "eye")
                        }
                    }
                }
                if !revoked {
                    Section {
                        Button(role: .destructive) { Task { await revoke() } } label: { Label("撤销这次分享", systemImage: "xmark") }
                    } footer: {
                        Text("撤销后新的访问立刻失效;已经下载或缓存的内容收不回来。")
                    }
                }
            }
            .navigationTitle(result.count.map { "已分享 \($0) 项" } ?? "已分享")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
    }

    private func preview() {
        // The owner's preview of the receiver page lives under the web UI's share preview route.
        model.webPage = BrainWebPage(id: "/api/shares/preview/" + result.token, title: "对方看到的样子")
        dismiss()
    }

    private func revoke() async {
        guard await BrainAuth.confirm("撤销这次分享") else { return }
        do {
            let _: BrainOK = try await BrainSpaceAPI.shared.post("/shares/revoke", ["ref": String(result.token.prefix(8))])
            revoked = true
        } catch { model.say(error.localizedDescription) }
    }
}

struct BrainOK: Decodable { var ok: Bool? }
