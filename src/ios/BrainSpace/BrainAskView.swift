//
//  BrainAskView.swift
//  LeoPhoneAgent
//
//  [brain-space] 问:和网页版同一条问答链路(/api/ask → /api/answers/<id>),回答带引用;
//  可保存为成果(知识卡草稿),可在同一资料范围里接着问。请求、轮询、停止与重试归 BrainAskModel。
//  回答用主对话同一个 Markdown 渲染器(表格、代码块、链接)。
//

import SwiftUI

enum BrainAskStyle {
    /// Text on the brand-blue question bubble: white on the light blue, near-black on the dark-mode light blue.
    static let onAccent = Color(UIColor { trait in
        trait.userInterfaceStyle == .dark ? UIColor(white: 0.06, alpha: 1) : .white
    })
}

struct BrainAskView: View {
    @EnvironmentObject private var model: BrainSpaceModel
    @ObservedObject private var store = BrainStore.shared
    @StateObject private var ask = BrainAskModel(makeClient: BrainAskView.makeClient)
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var focused: Bool
    @State private var showSent: UUID?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if ask.turns.isEmpty { starter }
                    ForEach(ask.turns) { turn in turnView(turn).id(turn.id) }
                }
                .padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: ask.turns.count) { _, _ in
                guard let last = ask.turns.last else { return }
                withAnimation(LeoMotion.standardEase(reduceMotion: reduceMotion)) { proxy.scrollTo(last.id, anchor: .top) }
            }
        }
        .safeAreaInset(edge: .bottom) { composer }
        .navigationDestination(for: BrainDocTarget.self) { BrainDocView(target: $0) }
        .onAppear {
            ask.appear(revision: store.connectionRevision)
            consumeSeed()
        }
        .onDisappear { ask.disappear() }
        .onChange(of: store.connectionRevision) { _, revision in ask.connectionChanged(to: revision) }
        .onChange(of: model.askSeed) { _, _ in consumeSeed() }
    }

    /// One configuration snapshot per connection; every call of this client uses it.
    @MainActor private static func makeClient() throws -> BrainAskModel.Client {
        let api = BrainSpaceAPI.shared
        let cfg = try api.config()
        return BrainAskModel.Client(
            ask: { question, fileIds in
                var body: [String: Any] = ["question": question, "mode": "answer"]
                if !fileIds.isEmpty { body["file_ids"] = fileIds }
                let r: BrainAskReceiptBody = try await api.post("/ask", body, config: cfg)
                return r.id
            },
            answer: { id in try await api.get("/answers/\(id)", config: cfg) },
            history: { try await api.get("/answers", query: [("limit", "12")], config: cfg, as: BrainAnswerList.self).items },
            save: { id, title in
                let _: BrainSavedCard = try await api.post("/answers/save", ["id": id, "title": title], config: cfg)
            })
    }

    // MARK: Pieces

    private var starter: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("问资料库里的一切:照片、视频、文档、知识卡。回答会标出处。")
                .font(.subheadline).foregroundStyle(.secondary)
            ForEach(["最近一个月新增了哪些资料?", "帮我找关于体检报告的资料", "今年去过哪些地方?"], id: \.self) { q in
                Button { ask.send(q) } label: {
                    Text(q).font(.subheadline).padding(.horizontal, 14)
                        .frame(minHeight: LeoTheme.TouchTarget.minimum)
                        .background(Color(.secondarySystemFill), in: Capsule())
                }
                .buttonStyle(.plain)
            }
            if !ask.history.isEmpty {
                Text("最近问过").font(.headline).padding(.top, 8)
                ForEach(ask.history) { h in
                    let parsed = BrainAskContext.parse(h.question)
                    Button { ask.openHistory(id: h.id, question: h.question) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(parsed.question).font(.subheadline.weight(.medium)).lineLimit(1)
                            if parsed.hasContext { Text("接着上文问的").font(.caption).foregroundStyle(.secondary) }
                            if let s = h.snippet { Text(s).font(.footnote).foregroundStyle(.secondary).lineLimit(2) }
                        }
                        .frame(maxWidth: .infinity, minHeight: LeoTheme.TouchTarget.minimum, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Divider()
                }
            }
        }
    }

    private func turnView(_ t: BrainAskModel.Turn) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .trailing, spacing: 4) {
                Text(t.question)
                    .font(.body).foregroundStyle(BrainAskStyle.onAccent)
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(BrainTheme.accent, in: RoundedRectangle(cornerRadius: LeoTheme.Radius.bubble, style: .continuous))
                if t.hasContext {
                    Button(showSent == t.id ? "收起实际发送的内容" : "带了上文 · 查看实际发送的内容") {
                        showSent = showSent == t.id ? nil : t.id
                    }
                    .font(.caption).frame(minHeight: LeoTheme.TouchTarget.minimum)
                }
                if !t.fileIds.isEmpty {
                    Text("限定在 \(t.fileIds.count) 份资料内").font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            if showSent == t.id {
                Text(t.sent).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled)
                    .padding(10).background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: LeoTheme.Radius.field))
            }
            phaseView(t)
        }
    }

    @ViewBuilder private func phaseView(_ t: BrainAskModel.Turn) -> some View {
        switch t.phase {
        case .submitting, .waiting:
            HStack(spacing: 10) {
                ProgressView()
                Text(t.phase == .submitting ? "正在提交…" : "资料库在查找和生成…").font(.subheadline).foregroundStyle(.secondary)
                Spacer()
                Button("停止等待") { ask.stop(t.id) }
                    .buttonStyle(.bordered).frame(minHeight: LeoTheme.TouchTarget.minimum)
            }
        case .paused:
            Text("回到这里后会继续等待结果").font(.subheadline).foregroundStyle(.secondary)
        case .stopped:
            retryRow("已停止等待。服务器那边可能仍在生成,可以继续等待,或稍后在「最近问过」里看。", label: "继续等待", t)
        case .timedOut:
            retryRow("等了很久还没有结果,可能仍在分析。", label: "继续等待", t)
        case .failed(let message, let resumable):
            retryRow(message, label: resumable ? "继续等待" : (t.fromHistory ? "重新查看" : "重试"), t)
        case .completed:
            if let a = t.answer, let text = a.result?.answer { completed(t, a, text) }
        }
    }

    private func retryRow(_ message: String, label: String, _ t: BrainAskModel.Turn) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(message).font(.subheadline).foregroundStyle(.secondary)
            Button(label) { ask.retry(t.id) }
                .buttonStyle(.bordered).frame(minHeight: LeoTheme.TouchTarget.minimum)
        }
    }

    @ViewBuilder private func completed(_ t: BrainAskModel.Turn, _ a: BrainArchiveAnswer, _ text: String) -> some View {
        // Same Markdown renderer as the main chat: tables, code blocks and links survive.
        SelectableMarkdownView(markdown: text)
            .fixedSize(horizontal: false, vertical: true)
            .modifier(MinisOpenURLHandler())
            .frame(maxWidth: .infinity, alignment: .leading)
        if let w = a.result?.warning, !w.isEmpty { Text(w).font(.footnote).foregroundStyle(LeoTheme.ColorToken.warning) }
        sources(a.result?.sources ?? [])
        HStack(spacing: 10) {
            Button(t.saved ? "已保存为成果" : (ask.savingId == t.id ? "正在保存…" : "保存成果")) {
                Task { if let message = await ask.save(t.id) { model.say(message) } }
            }
            .disabled(t.saved || ask.savingId != nil || a.result?.modelUsed != true || model.manifest?.can.save != true)
            if ask.canFollowUp(t) {
                Button(ask.followUp == t.id ? "正在接着问" : "接着问") { ask.startFollowUp(t.id); focused = true }
            }
        }
        .buttonStyle(.bordered).controlSize(.regular)
        .frame(minHeight: LeoTheme.TouchTarget.minimum)
    }

    @ViewBuilder private func sources(_ list: [BrainArchiveAnswer.Source]) -> some View {
        let shown = list.filter { $0.fileId != nil }.prefix(8)
        if !shown.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Array(shown), id: \.self) { s in
                        NavigationLink(value: BrainDocTarget(id: s.fileId ?? "", title: s.title ?? "资料")) {
                            Text("\(s.number.map { "[\($0)] " } ?? "")\(s.title ?? "资料")\(s.locator.map { " · \($0)" } ?? "")")
                                .font(.caption).lineLimit(1)
                                .padding(.horizontal, 10).frame(minHeight: LeoTheme.TouchTarget.minimum)
                                .background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 8))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let t = ask.followUpTurn {
                HStack(spacing: 6) {
                    Image(systemName: "arrowshape.turn.up.left").font(.caption)
                    Text("接着「\(t.question)」问,会附上本页上文帮助理解指代").font(.caption).lineLimit(1)
                    Spacer()
                    Button("不带上文") { ask.cancelFollowUp() }.font(.caption).frame(minHeight: LeoTheme.TouchTarget.minimum)
                }
                .foregroundStyle(.secondary)
            }
            if let e = ask.composeError { Text(e).font(.caption).foregroundStyle(LeoTheme.ColorToken.destructive) }
            HStack(spacing: 8) {
                if !ask.fileIds.isEmpty {
                    Button { ask.clearScope() } label: { Label("\(ask.fileIds.count)", systemImage: "paperclip") }
                        .font(.footnote).frame(minWidth: LeoTheme.TouchTarget.minimum, minHeight: LeoTheme.TouchTarget.minimum)
                        .accessibilityLabel(Text("取消限定的资料"))
                }
                TextField("问资料库…", text: $ask.draft, axis: .vertical)
                    .lineLimit(1...4).focused($focused)
                    .onSubmit { ask.send(ask.draft) }
                Button { ask.send(ask.draft) } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                    .frame(minWidth: LeoTheme.TouchTarget.minimum, minHeight: LeoTheme.TouchTarget.minimum)
                    .disabled(ask.draftLength == 0 || ask.draftLength > BrainAskContext.limit)
                    .accessibilityLabel(Text("发送"))
            }
            if ask.draftLength > BrainAskContext.limit - 200 {
                Text("\(ask.draftLength) / \(BrainAskContext.limit)").font(.caption2.monospacedDigit())
                    .foregroundStyle(ask.draftLength > BrainAskContext.limit ? LeoTheme.ColorToken.destructive : .secondary)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 6)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: LeoTheme.Radius.composer, style: .continuous))
        .padding(.horizontal, 12).padding(.bottom, 6)
    }

    // MARK: Seeds

    private func consumeSeed() {
        // The seed is set just before the tab switches here; keep it until this page is actually visible.
        guard ask.isVisible, let seed = model.askSeed else { return }
        model.askSeed = nil
        ask.setScope(seed.fileIds)
        if let id = seed.answerId {
            ask.openHistory(id: id, question: seed.question)
        } else if seed.question.isEmpty {
            focused = true
        } else {
            ask.send(seed.question)
        }
    }
}

struct BrainSavedCard: Decodable { var id: String? }
