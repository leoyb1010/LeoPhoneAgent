//
//  BrainStewardSheet.swift
//  LeoPhoneAgent
//
//  [brain-space] 管家:今天的提醒、需要你点头的事(Face ID 后同意 / 不同意)、做过的事。
//

import SwiftUI

struct BrainStewardSheet: View {
    @EnvironmentObject private var model: BrainSpaceModel
    @Environment(\.dismiss) private var dismiss
    @State private var butler: BrainButler?
    @State private var steward: BrainSteward?
    @State private var error: String?
    @State private var busy: String?

    var body: some View {
        NavigationStack {
            List {
                if let b = butler {
                    Section {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(b.title ?? "今天一切都好").font(.headline)
                            if let t = b.brief?.text { Text(t).font(.subheadline).foregroundStyle(.secondary) }
                        }
                    }
                }
                let items = steward?.brief ?? []
                if !items.isEmpty {
                    Section("提醒") {
                        ForEach(items, id: \.self) { item in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.title).font(.subheadline.weight(.medium))
                                if let d = item.detail { Text(d).font(.footnote).foregroundStyle(.secondary) }
                            }
                        }
                    }
                }
                let proposals = steward?.proposals ?? []
                if !proposals.isEmpty {
                    Section {
                        ForEach(proposals) { p in proposal(p) }
                    } header: { Text("需要你点头") } footer: {
                        Text("同意前会用 Face ID 确认;管家按当时看到的情况执行,情况变了需要重新决定。")
                    }
                }
                if let log = butler?.log, !log.isEmpty {
                    Section("做过的") {
                        ForEach(log.prefix(8), id: \.self) { l in
                            VStack(alignment: .leading, spacing: 2) {
                                HStack {
                                    Text(BrainFormat.niceName(l.title)).font(.subheadline)
                                    Spacer()
                                    if let s = l.state, !s.isEmpty {
                                        Text(s).font(.caption).foregroundStyle(l.tone == "failed" ? Color.red : Color.secondary)
                                    }
                                }
                                if let sub = l.sub { Text(sub).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                            }
                        }
                    }
                }
                if let error { BrainErrorRow(message: error) { Task { await load() } } }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("管家")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .refreshable { await load() }
            .task { await load() }
        }
    }

    private func proposal(_ p: BrainSteward.Proposal) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(p.title).font(.subheadline.weight(.semibold))
            if let d = p.detail { Text(d).font(.footnote) }
            if let i = p.impact { Text("影响:" + i).font(.caption).foregroundStyle(.secondary) }
            if let u = p.undo { Text("撤销:" + u).font(.caption).foregroundStyle(.secondary) }
            if let h = p.how { Text(h).font(.caption).foregroundStyle(.tertiary) }
            HStack {
                Button("不同意") { Task { await decide(p, "reject") } }.buttonStyle(.bordered)
                Button(busy == p.id ? "正在执行…" : "用 Face ID 同意") { Task { await decide(p, "approve") } }
                    .buttonStyle(.borderedProminent)
            }
            .controlSize(.small)
            .disabled(busy != nil || model.manifest?.can.steward != true)
            if model.manifest?.can.steward != true {
                Text("这台设备没有审批权限(write:steward)").font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 4)
    }

    private func load() async {
        error = nil
        async let s: BrainSteward = BrainSpaceAPI.shared.get("/steward")
        do { butler = try await BrainSpaceAPI.shared.get("/butler") } catch { self.error = error.localizedDescription }
        steward = try? await s
        model.stewardNeedsYou = !(steward?.proposals ?? []).isEmpty
    }

    private func decide(_ p: BrainSteward.Proposal, _ action: String) async {
        guard await BrainAuth.confirm(action == "approve" ? "同意管家执行「\(p.title)」" : "拒绝「\(p.title)」") else { return }
        busy = p.id
        defer { busy = nil }
        do {
            let _: BrainOK = try await BrainSpaceAPI.shared.post("/steward/decide", ["id": p.id, "version": p.version, "action": action])
            model.say(action == "approve" ? "已同意,管家开始执行" : "已记下:不做")
            await load()
        } catch { model.say(error.localizedDescription) }
    }
}
