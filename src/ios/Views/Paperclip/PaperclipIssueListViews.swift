import SwiftUI

/// 列表按状态分组：进行中（含待审核、受阻与有运行中 run 的任务）/ 待处理 / 已完成。
enum PaperclipIssueGroup: String, CaseIterable, Identifiable {
    case active, pending, finished
    var id: String { rawValue }
    var title: String {
        switch self {
        case .active: return "进行中"
        case .pending: return "待处理"
        case .finished: return "已完成"
        }
    }

    static func group(_ issue: PaperclipIssue, running: Bool) -> PaperclipIssueGroup {
        if running { return .active }
        switch issue.status {
        case "in_progress", "in_review", "blocked": return .active
        case "done", "cancelled": return .finished
        default: return .pending
        }
    }
}

/// 任务卡片：状态、编号、运行中标识、相对更新时间、标题、一行摘要、负责人。
struct PaperclipIssueCard: View {
    let issue: PaperclipIssue
    let assignee: PaperclipAgent?
    let running: Bool
    let client: PaperclipClient

    private var summary: String? {
        guard let description = issue.description else { return nil }
        let line = description.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "#>*- ")) }
            .first { !$0.isEmpty }
        return line
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                PaperclipStatusCapsule(status: issue.status, compact: true)
                if let identifier = issue.identifier {
                    Text(identifier).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                }
                if running {
                    HStack(spacing: 4) {
                        Circle().fill(LeoTheme.ColorToken.accent).frame(width: 6, height: 6).leoPulse(active: true)
                        Text("运行中").font(.caption2.weight(.semibold)).foregroundStyle(LeoTheme.ColorToken.accent)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("paperclip.running.\(issue.id)")
                }
                Spacer(minLength: 4)
                if let time = PaperclipTimeText.relative(issue.updatedAt) {
                    Text(time).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                }
            }
            Text(issue.title)
                .font(.body.weight(.semibold))
                .foregroundStyle(.primary)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            if let summary {
                Text(summary).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
            }
            HStack(spacing: 6) {
                if let assignee {
                    PaperclipAvatar(client: client, path: PaperclipAvatarPath.normalized(assignee.avatarUrl, origin: client.profile.origin),
                                    name: assignee.name, size: 20)
                    Text(assignee.name).font(.caption.weight(.medium)).foregroundStyle(.secondary).lineLimit(1)
                } else {
                    Image(systemName: "tray").font(.caption).foregroundStyle(.tertiary)
                    Text("未分配").font(.caption).foregroundStyle(.tertiary)
                }
                Spacer(minLength: 0)
                if issue.priority == "high" || issue.priority == "critical" {
                    Image(systemName: "flag.fill")
                        .font(.caption2)
                        .foregroundStyle(issue.priority == "critical" ? LeoTheme.ColorToken.destructive : LeoTheme.ColorToken.warning)
                        .accessibilityLabel(Text("优先级\(PaperclipLabels.priority(issue.priority))"))
                }
                Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(.quaternary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
        .overlay {
            if running {
                RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous)
                    .strokeBorder(LeoTheme.ColorToken.accent.opacity(0.35), lineWidth: 1)
            }
        }
        .contentShape(RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
    }
}

/// 列表顶部紧凑工具条：公司切换胶囊 + 实时状态 + 搜索框。
struct PaperclipListToolbar: View {
    @ObservedObject var store: PaperclipWorkspaceStore
    @Binding var query: String
    var searching: FocusState<Bool>.Binding

    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                companyControl
                Spacer(minLength: 4)
                if store.busy {
                    ProgressView().controlSize(.small).accessibilityLabel(Text("正在同步"))
                }
                PaperclipLiveBadge(state: store.liveState)
            }
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("搜索已加载的任务", text: $query)
                    .focused(searching).submitLabel(.search)
                    .textInputAutocapitalization(.never)
                    .accessibilityIdentifier("paperclip.search")
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                        .buttonStyle(.borderless).accessibilityLabel(Text(verbatim: "清除搜索"))
                }
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 40)
            .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: LeoTheme.Radius.field, style: .continuous))
        }
    }

    @ViewBuilder private var companyControl: some View {
        let name = store.companies.first(where: { $0.id == store.companyID })?.name ?? "尚未加入公司"
        if store.companies.count > 1 {
            Menu {
                Picker("公司", selection: Binding(get: { store.companyID }, set: { id in Task { await store.selectCompany(id) } })) {
                    ForEach(store.companies) { Text($0.name).tag($0.id) }
                }
            } label: {
                companyLabel(name, menu: true)
            }
            .disabled(store.busy)
            .accessibilityIdentifier("paperclip.companyPicker")
        } else {
            companyLabel(name, menu: false)
        }
    }

    private func companyLabel(_ name: String, menu: Bool) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "building.2.fill").font(.caption).foregroundStyle(LeoTheme.ColorToken.accent)
            VStack(alignment: .leading, spacing: 0) {
                Text(name).font(.subheadline.weight(.semibold)).foregroundStyle(.primary).lineLimit(1)
                Text(store.selectedProfile?.name ?? "服务器").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            if menu { Image(systemName: "chevron.up.chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(.secondary) }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.primary.opacity(0.05), in: Capsule())
        .contentShape(Capsule())
    }
}

/// 未连接时的引导卡片。
struct PaperclipConnectCard: View {
    let title: String
    let busy: Bool
    let hasProfile: Bool
    let action: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            ZStack {
                Circle().fill(LeoTheme.ColorToken.accent.opacity(0.12)).frame(width: 64, height: 64)
                Image(systemName: "server.rack").font(.title2.weight(.semibold)).foregroundStyle(LeoTheme.ColorToken.accent)
            }
            Text(title).font(.title3.weight(.semibold)).multilineTextAlignment(.center)
            Text(busy ? "正在验证连接…" : "登录后即可查看和处理服务器任务，过程实时同步到手机。")
                .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button(action: action) {
                Label(hasProfile ? "登录与连接" : "添加服务器", systemImage: "network")
                    .font(.body.weight(.semibold))
                    .padding(.horizontal, 8)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .accessibilityIdentifier("paperclip.openConnection")
        }
        .padding(LeoTheme.Spacing.lg)
        .frame(maxWidth: .infinity)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
}
