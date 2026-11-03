//
//  BrainAskView.swift
//  LeoPhoneAgent
//
//  [brain-space] 问:和网页版同一条问答链路(/api/ask → /api/answers/<id>),
//  回答带引用;可保存为成果(知识卡草稿),可接着问。手机上问的,网页的历史里也有。
//

import SwiftUI

struct BrainAskView: View {
    @EnvironmentObject private var model: BrainSpaceModel
    @State private var turns: [Turn] = []
    @State private var history: [BrainAnswerList.Item] = []
    @State private var draft = ""
    @State private var fileIds: [String] = []
    @FocusState private var focused: Bool

    struct Turn: Identifiable {
        let id = UUID()
        var question: String
        var answerId: String?
        var answer: BrainArchiveAnswer?
        var error: String?
        var saved = false
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if turns.isEmpty { starter }
                    ForEach($turns) { $turn in turnView($turn).id(turn.id) }
                }
                .padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: turns.count) { _, _ in
                if let last = turns.last { withAnimation { proxy.scrollTo(last.id, anchor: .top) } }
            }
        }
        .safeAreaInset(edge: .bottom) { composer }
        .navigationDestination(for: BrainDocTarget.self) { BrainDocView(target: $0) }
        .task { history = (try? await BrainSpaceAPI.shared.get("/answers", query: [("limit", "12")], as: BrainAnswerList.self).items) ?? [] }
        .onAppear(perform: consumeSeed)
        .onChange(of: model.askSeed) { _, _ in consumeSeed() }
    }

    // MARK: Pieces

    private var starter: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("问资料库里的一切:照片、视频、文档、知识卡。回答会标出处。")
                .font(.subheadline).foregroundStyle(.secondary)
            ForEach(["布布最近一次去医院是什么时候?", "今年布布去过哪些城市?", "家里的照片备份到哪了?"], id: \.self) { q in
                Button { send(q) } label: {
                    Text(q).font(.subheadline).padding(.horizontal, 12).padding(.vertical, 8)
                        .background(Color(.secondarySystemFill), in: Capsule())
                }
                .buttonStyle(.plain)
            }
            if !history.isEmpty {
                Text("最近问过").font(.headline).padding(.top, 8)
                ForEach(history) { h in
                    Button { load(h) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(h.question).font(.subheadline.weight(.medium)).lineLimit(1)
                            if let s = h.snippet { Text(s).font(.footnote).foregroundStyle(.secondary).lineLimit(2) }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    Divider()
                }
            }
        }
    }

    private func turnView(_ turn: Binding<Turn>) -> some View {
        let t = turn.wrappedValue
        return VStack(alignment: .leading, spacing: 10) {
            Text(t.question)
                .font(.body).foregroundStyle(.white)
                .padding(.horizontal, 14).padding(.vertical, 9)
                .background(BrainTheme.accent, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .frame(maxWidth: .infinity, alignment: .trailing)
            if let e = t.error {
                Text(e).font(.subheadline).foregroundStyle(.secondary)
            } else if let a = t.answer, a.status == "completed", let text = a.result?.answer {
                Text(markdown(text)).font(.body).textSelection(.enabled)
                if let w = a.result?.warning, !w.isEmpty { Text(w).font(.footnote).foregroundStyle(.orange) }
                sources(a.result?.sources ?? [])
                HStack(spacing: 10) {
                    Button(t.saved ? "已保存为成果" : "保存成果") { Task { await save(turn) } }
                        .disabled(t.saved || a.result?.modelUsed != true || model.manifest?.can.save != true)
                    Button("接着问") { draft = ""; focused = true }
                }
                .buttonStyle(.bordered).controlSize(.small)
            } else {
                HStack(spacing: 8) { ProgressView(); Text("正在查资料库…").font(.subheadline).foregroundStyle(.secondary) }
            }
        }
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
                                .padding(.horizontal, 8).padding(.vertical, 4)
                                .background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 6))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private var composer: some View {
        HStack(spacing: 8) {
            if !fileIds.isEmpty {
                Button { fileIds = [] } label: { Label("\(fileIds.count)", systemImage: "paperclip") }
                    .font(.footnote).accessibilityLabel(Text("取消限定的资料"))
            }
            TextField("问资料库…", text: $draft, axis: .vertical)
                .lineLimit(1...4).focused($focused)
                .onSubmit { send(draft) }
            Button { send(draft) } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityLabel(Text("发送"))
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .padding(.horizontal, 12).padding(.bottom, 6)
    }

    // MARK: Actions

    /// Text renders inline Markdown only: turn block marks into readable lines (headings bold, bullets •, no rules).
    private func markdown(_ s: String) -> AttributedString {
        let lines = s.components(separatedBy: "\n").compactMap { raw -> String? in
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("---") || line == "***" { return nil }
            if let r = line.range(of: "^#{1,6}\\s+", options: .regularExpression) {
                let title = line[r.upperBound...].replacingOccurrences(of: "**", with: "")
                return "**\(title)**"
            }
            if let r = line.range(of: "^[*-]\\s+", options: .regularExpression) { return "• " + line[r.upperBound...] }
            return raw
        }
        let text = lines.joined(separator: "\n").replacingOccurrences(of: "\n\n\n", with: "\n\n")
        return (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }

    private func consumeSeed() {
        guard let seed = model.askSeed else { return }
        model.askSeed = nil
        fileIds = seed.fileIds
        if let id = seed.answerId {
            load(BrainAnswerList.Item(id: id, question: seed.question))
        } else if seed.question.isEmpty {
            focused = true
        } else {
            send(seed.question)
        }
    }

    private func load(_ h: BrainAnswerList.Item) {
        let turn = Turn(question: h.question, answerId: h.id)
        turns.append(turn)
        Task { await poll(turn.id, h.id) }
    }

    private func send(_ raw: String) {
        let q = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return }
        draft = ""
        let turn = Turn(question: q)
        turns.append(turn)
        let ids = fileIds
        Task {
            do {
                var body: [String: Any] = ["question": q, "mode": "answer"]
                if !ids.isEmpty { body["file_ids"] = ids }
                let r: BrainAskReceiptBody = try await BrainSpaceAPI.shared.post("/ask", body)
                update(turn.id) { $0.answerId = r.id }
                await poll(turn.id, r.id)
            } catch {
                update(turn.id) { $0.error = error.localizedDescription }
            }
        }
    }

    private func poll(_ turnId: UUID, _ answerId: String) async {
        for _ in 0..<150 {
            guard let a = try? await BrainSpaceAPI.shared.get("/answers/\(answerId)", as: BrainArchiveAnswer.self) else {
                try? await Task.sleep(for: .seconds(2)); continue
            }
            if a.status == "completed" { update(turnId) { $0.answer = a }; return }
            if ["failed", "interrupted", "cancelled"].contains(a.status) {
                update(turnId) { $0.error = a.error ?? "这次没答完,可以再问一次" }; return
            }
            try? await Task.sleep(for: .seconds(1.5))
        }
        update(turnId) { $0.error = "还在分析,稍后在「最近问过」里看结果" }
    }

    private func save(_ turn: Binding<Turn>) async {
        guard let id = turn.wrappedValue.answerId else { return }
        do {
            let _: BrainSavedCard = try await BrainSpaceAPI.shared.post("/answers/save", ["id": id, "title": String(turn.wrappedValue.question.prefix(80))])
            turn.wrappedValue.saved = true
            model.say("已保存为成果(知识卡草稿)")
        } catch { model.say(error.localizedDescription) }
    }

    private func update(_ id: UUID, _ change: (inout Turn) -> Void) {
        guard let i = turns.firstIndex(where: { $0.id == id }) else { return }
        change(&turns[i])
    }
}

struct BrainSavedCard: Decodable { var id: String? }
