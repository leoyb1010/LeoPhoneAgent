//
//  BrainFamilyView.swift
//  LeoPhoneAgent
//
//  [brain-space] 家人:本月月报(每人一段 + 几张代表照片)、家人列表和个人档案。
//

import SwiftUI

struct BrainFamilyView: View {
    @EnvironmentObject private var model: BrainSpaceModel
    @State private var report: BrainFamilyReport?
    @State private var members: [BrainFamilyMember] = []
    @State private var error: String?

    var body: some View {
        List {
            if let people = report?.people, !people.isEmpty {
                Section {
                    ForEach(people) { p in reportRow(p) }
                } header: {
                    Text(report?.month.map { "\(BrainFormat.monthTitle($0))月报" } ?? "月报")
                }
            }
            Section("家人") {
                ForEach(members) { m in
                    NavigationLink(value: m) {
                        HStack(spacing: 12) {
                            BrainAvatar(path: m.avatar, name: m.name, size: 44)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(m.name).font(.body.weight(.medium))
                                Text("\(m.photos ?? 0) 张照片 · \(m.videos ?? 0) 段视频").font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            if let error { BrainErrorRow(message: error) { Task { await load() } } }
        }
        .listStyle(.insetGrouped)
        .refreshable { await load() }
        .task { if members.isEmpty { await load() } }
        .navigationDestination(for: BrainFamilyMember.self) { BrainFamilyProfileView(member: $0) }
        .navigationDestination(for: BrainMediaRow.self) { BrainMediaDetailView(row: $0) }
    }

    private func reportRow(_ p: BrainFamilyReport.Person) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                BrainAvatar(path: p.avatar, name: p.name, size: 34)
                VStack(alignment: .leading, spacing: 0) {
                    Text(p.name).font(.subheadline.weight(.semibold))
                    Text("\(p.photos ?? 0) 张 · \(p.videos ?? 0) 段 · \(p.days ?? 0) 天").font(.caption).foregroundStyle(.secondary)
                }
            }
            if let story = p.story, !story.isEmpty { Text(story).font(.subheadline) }
            if let picks = p.picks, !picks.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) {
                        ForEach(picks) { pick in
                            NavigationLink(value: BrainMediaRow(id: pick.id, capturedAt: pick.capturedAt, thumbnailUrl: pick.thumbnailUrl)) {
                                BrainRemoteImage(path: pick.thumbnailUrl ?? "/api/media/\(pick.id)/thumbnail")
                                    .frame(width: 72, height: 72).clipShape(RoundedRectangle(cornerRadius: 8))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func load() async {
        error = nil
        async let r: BrainFamilyReport = BrainSpaceAPI.shared.get("/family/report")
        do { members = try await BrainSpaceAPI.shared.get("/family", as: BrainFamilyList.self).items }
        catch { self.error = error.localizedDescription }
        report = try? await r
    }
}

struct BrainFamilyProfileView: View {
    @EnvironmentObject private var model: BrainSpaceModel
    let member: BrainFamilyMember
    @State private var profile: BrainFamilyProfile?
    @State private var error: String?

    var body: some View {
        List {
            Section {
                HStack(spacing: 14) {
                    BrainAvatar(path: member.avatar, name: member.name, size: 64)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(member.name).font(.title3.weight(.semibold))
                        if let a = member.aliases, !a.isEmpty { Text(a).font(.footnote).foregroundStyle(.secondary).lineLimit(2) }
                        Text("\(BrainFormat.day(profile?.first ?? member.first)) – \(BrainFormat.day(profile?.last ?? member.last))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                if let body = profile?.body ?? member.body, !body.isEmpty { Text(body).font(.subheadline) }
                Button { model.photos(of: member) } label: {
                    Label("看 \(member.name) 的 \(member.photos ?? 0) 张照片、\(member.videos ?? 0) 段视频", systemImage: "photo.on.rectangle")
                }
            }
            ForEach(profile?.years ?? []) { y in
                Section("\(y.year) 年 · \(y.photos ?? 0) 张 · \(y.videos ?? 0) 段") {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 4), spacing: 3) {
                        ForEach(y.picks ?? []) { pick in
                            NavigationLink(value: BrainMediaRow(id: pick.id, capturedAt: pick.capturedAt, thumbnailUrl: pick.thumbnailUrl)) {
                                BrainRemoteImage(path: pick.thumbnailUrl ?? "/api/media/\(pick.id)/thumbnail")
                                    .aspectRatio(1, contentMode: .fill).clipShape(RoundedRectangle(cornerRadius: 6))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
                }
            }
            if let c = profile?.companions, !c.isEmpty {
                Section("常在一起") {
                    ForEach(c) { m in
                        HStack(spacing: 10) {
                            BrainAvatar(path: m.avatar, name: m.name, size: 30)
                            Text(m.name)
                            Spacer()
                            Text("\(m.photos ?? 0) 张").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            if let places = profile?.places, !places.isEmpty {
                Section("常去的地方") {
                    ForEach(places, id: \.self) { p in
                        HStack { Text(p.name); Spacer(); Text("\(p.count) 次").font(.footnote).foregroundStyle(.secondary) }
                    }
                }
            }
            if let error { BrainErrorRow(message: error) { Task { await load() } } }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(member.name)
        .navigationBarTitleDisplayMode(.inline)
        .task { if profile == nil { await load() } }
    }

    private func load() async {
        error = nil
        do { profile = try await BrainSpaceAPI.shared.get("/family/\(member.id)") } catch { self.error = error.localizedDescription }
    }
}
