//
//  BrainTodayView.swift
//  LeoPhoneAgent
//
//  [brain-space] 今日:家庭照片封面、管家一句话、从这里接着做、那年今天、管家提醒、最近的问答。
//

import SwiftUI

struct BrainTodayView: View {
    @EnvironmentObject private var model: BrainSpaceModel
    @State private var wall: [BrainWall.Item] = []
    @State private var butler: BrainButler?
    @State private var steward: BrainSteward?
    @State private var continuations: [BrainContinuations.Item] = []
    @State private var otd: [BrainOnThisDay.Year] = []
    @State private var answers: [BrainAnswerList.Item] = []
    @State private var error: String?
    @State private var otdYear: BrainOnThisDay.Year?
    @State private var openDoc: BrainDocTarget?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                hero
                if let butler { butlerLine(butler) }
                if !continuations.isEmpty { continuationsSection }
                if !otd.isEmpty { onThisDay }
                stewardSection
                if !answers.isEmpty { answersSection }
                if let error { BrainErrorRow(message: error) { Task { await load() } } }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 32)
        }
        .refreshable { await load() }
        .task { if wall.isEmpty { await load() } }
        .navigationDestination(for: BrainSpaceMediaRow.self) { BrainSpaceMediaDetailView(row: $0) }
        .navigationDestination(item: $openDoc) { BrainDocView(target: $0) }
        .sheet(item: $otdYear) { year in BrainMediaGridSheet(title: "\(year.ago) 年前的今天", items: year.items).environmentObject(model) }
    }

    // MARK: Sections

    private var hero: some View {
        TabView {
            ForEach(wall.prefix(8)) { item in
                NavigationLink(value: BrainSpaceMediaRow(id: item.id, capturedAt: item.capturedAt, mediaKind: "photo")) {
                    ZStack(alignment: .bottomLeading) {
                        BrainRemoteImage(path: "/api/media/\(item.id)/preview")
                        LinearGradient(colors: [.clear, .black.opacity(0.55)], startPoint: .center, endPoint: .bottom)
                        VStack(alignment: .leading, spacing: 2) {
                            Text([BrainFormat.day(item.capturedAt), item.place ?? ""].filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(.caption).opacity(0.85)
                            Text(item.event.flatMap { $0.isEmpty ? nil : $0 } ?? "家庭影像").font(.title2.weight(.semibold))
                            if let names = item.names, !names.isEmpty {
                                Text(names.joined(separator: "、")).font(.footnote).opacity(0.85)
                            }
                        }
                        .foregroundStyle(.white).padding(.horizontal, 16).padding(.top, 16).padding(.bottom, 30)
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .automatic))
        .frame(height: 280)
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay {
            if wall.isEmpty && error == nil {
                RoundedRectangle(cornerRadius: 20).fill(Color(.secondarySystemFill)).overlay(ProgressView())
            }
        }
    }

    private func butlerLine(_ b: BrainButler) -> some View {
        Button { model.showSteward = true } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "bell").foregroundStyle(BrainTheme.accent).padding(.top, 2)
                VStack(alignment: .leading, spacing: 3) {
                    Text(b.title ?? "今天一切都好").font(.headline)
                    if let text = b.brief?.text ?? b.sub { Text(text).font(.subheadline).foregroundStyle(.secondary) }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.footnote).foregroundStyle(.tertiary)
            }
            .padding(14)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private var continuationsSection: some View {
        BrainSection(title: "从这里接着做") {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(continuations) { c in
                        Button { open(c) } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(c.detail ?? "").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                Text(c.title).font(.subheadline.weight(.medium)).lineLimit(2)
                                Spacer(minLength: 0)
                                Text((c.label ?? "打开") + " ›").font(.footnote).foregroundStyle(BrainTheme.accent)
                            }
                            .frame(width: 220, height: 96, alignment: .leading)
                            .padding(12)
                            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private var onThisDay: some View {
        BrainSection(title: "那年今天", action: ("影像", { model.tab = .media })) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(otd) { year in
                        Button { otdYear = year } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                BrainRemoteImage(path: year.items.first?.thumbPath ?? "")
                                    .frame(width: 124, height: 156)
                                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                                Text("\(year.ago) 年前 · \(year.items.count) 项").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(Text("\(year.ago) 年前的今天,\(year.items.count) 项"))
                    }
                }
            }
        }
    }

    @ViewBuilder private var stewardSection: some View {
        let items = steward?.brief ?? []
        if !items.isEmpty {
            BrainSection(title: "管家", action: ("全部", { model.showSteward = true })) {
                VStack(spacing: 0) {
                    ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                        HStack(alignment: .top, spacing: 10) {
                            Circle().fill(item.glyph == "✕" ? Color.red : (item.glyph == "◐" ? Color.orange : Color.secondary))
                                .frame(width: 8, height: 8).padding(.top, 6)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.title).font(.subheadline.weight(.medium))
                                if let d = item.detail { Text(d).font(.footnote).foregroundStyle(.secondary) }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(12)
                        if i < items.count - 1 { Divider().padding(.leading, 30) }
                    }
                }
                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
        }
    }

    private var answersSection: some View {
        BrainSection(title: "最近的问答", action: ("新问题", { model.ask("") })) {
            VStack(spacing: 0) {
                ForEach(answers) { a in
                    Button { model.openAnswer(a.id, question: a.question) } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(a.question).font(.subheadline.weight(.medium)).lineLimit(1)
                            if let s = a.snippet { Text(s).font(.footnote).foregroundStyle(.secondary).lineLimit(2) }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                    }
                    .buttonStyle(.plain)
                    if a.id != answers.last?.id { Divider().padding(.leading, 12) }
                }
            }
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
    }

    // MARK: Data

    private func open(_ c: BrainContinuations.Item) {
        let href = c.href ?? ""
        if href.hasPrefix("#file/"), let id = href.dropFirst(6).split(separator: "?").first, !id.isEmpty {
            openDoc = BrainDocTarget(id: String(id), title: c.title)
        } else {
            model.webPage = BrainWebPage(id: String(href.drop(while: { $0 == "#" })), title: c.title)
        }
    }

    private func load() async {
        error = nil
        let api = BrainSpaceAPI.shared
        async let w: BrainWall = api.get("/home/wall", query: [("limit", "40")])
        async let b: BrainButler = api.get("/butler")
        async let s: BrainSteward = api.get("/steward")
        async let c: BrainContinuations = api.get("/continuations")
        async let o: BrainOnThisDay = api.get("/media/onthisday")
        async let a: BrainAnswerList = api.get("/answers", query: [("limit", "5")])
        do {
            wall = try await w.items.shuffled()
        } catch {
            self.error = error.localizedDescription
        }
        butler = try? await b
        steward = try? await s
        model.stewardNeedsYou = !(steward?.proposals ?? []).isEmpty
        continuations = (try? await c.items) ?? []
        otd = (try? await o.years) ?? []
        answers = (try? await a.items) ?? []
    }
}

/// A plain grid of media rows (on-this-day year, a family member's year…).
struct BrainMediaGridSheet: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let items: [BrainSpaceMediaRow]

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: 3), spacing: 2) {
                    ForEach(items) { row in
                        NavigationLink(value: row) {
                            BrainRemoteImage(path: row.thumbPath).aspectRatio(1, contentMode: .fill)
                                .overlay(alignment: .bottomTrailing) { if row.isVideo { Image(systemName: "play.fill").font(.caption).foregroundStyle(.white).padding(5) } }
                        }
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: BrainSpaceMediaRow.self) { BrainSpaceMediaDetailView(row: $0) }
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
    }
}
