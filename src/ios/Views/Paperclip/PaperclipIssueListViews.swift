import SwiftUI

/// 任务行：行首状态符号 · 编号与相对时间 · 标题 · 负责人头像与名字、运行中、优先级。
/// 只比较展示数据（Equatable）：轮询拿回相同内容时整行跳过重绘。
struct PaperclipIssueRow: View, @MainActor Equatable {
    let issue: PaperclipIssue
    let assignee: PaperclipAgent?
    let running: Bool
    let selected: Bool
    let timeText: String?
    let position: PaperclipRowPosition
    let client: PaperclipClient
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .footnote) private var avatarSize: CGFloat = 18

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.issue == rhs.issue && lhs.assignee == rhs.assignee && lhs.running == rhs.running && lhs.selected == rhs.selected
            && lhs.timeText == rhs.timeText && lhs.position == rhs.position && lhs.client === rhs.client
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            PaperclipStatusGlyph(status: issue.status, running: running)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if let identifier = issue.identifier {
                        Text(identifier)
                            .font(.caption.monospaced().weight(.medium))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    if let timeText {
                        Text(timeText)
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
                Text(issue.title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(typeSize.isAccessibilitySize ? 4 : 2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                meta.padding(.top, 2)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, minHeight: LeoTheme.TouchTarget.minimum, alignment: .leading)
        .background(selected ? LeoTheme.ColorToken.accent.opacity(0.14) : Color(uiColor: .secondarySystemGroupedBackground))
        .overlay(alignment: .bottom) {
            if position.showsSeparator && !selected {
                Rectangle().fill(LeoTheme.ColorToken.separator).frame(height: 0.5).padding(.leading, 50)
            }
        }
        .clipShape(position.shape)
        .contentShape(.hoverEffect, position.shape)
        .contentShape(position.shape)
        .hoverEffect(.highlight)
    }

    /// 整行一次读完（由外层链接/按钮使用，替换逐个子元素朗读）。
    var accessibilityText: String {
        PaperclipIssueRowText.accessibilityLabel(issue: issue, assigneeName: assignee?.name, running: running, time: timeText)
    }

    @ViewBuilder private var meta: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
            : AnyLayout(HStackLayout(spacing: 8))
        layout {
            HStack(spacing: 6) {
                if let assignee {
                    PaperclipAvatar(client: client, path: PaperclipAvatarPath.normalized(assignee.avatarUrl, origin: client.profile.origin),
                                    name: assignee.name, size: avatarSize)
                    Text(assignee.name).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                } else {
                    Image(systemName: "person.crop.circle.dashed").font(.footnote).foregroundStyle(.tertiary)
                    Text("未分配").font(.footnote).foregroundStyle(.tertiary)
                }
            }
            .layoutPriority(1)
            if running {
                HStack(spacing: 5) {
                    PaperclipLivePulse(active: true, diameter: 6)
                    Text("运行中").font(.footnote.weight(.semibold)).foregroundStyle(LeoTheme.ColorToken.accent).lineLimit(1)
                }
                .accessibilityIdentifier("paperclip.running.\(issue.id)")
            }
            if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
            // 「中」是默认优先级，行里不显示，避免每行一个无信息的横线。
            if PaperclipPriorityLook.rank(issue.priority) != 1 { PaperclipPriorityGlyph(priority: issue.priority) }
        }
    }
}

/// 吸顶分组标题：符号、名称、数量；轻点折叠或展开本组。
struct PaperclipSectionHeader: View {
    let group: PaperclipIssueGroup
    let count: Int
    let collapsed: Bool
    let toggle: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 6) {
                Image(systemName: group.symbol).font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                Text(group.title).font(.footnote.weight(.semibold)).foregroundStyle(.primary)
                Text("\(count)")
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .contentTransition(.numericText(value: Double(count)))
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(Color.primary.opacity(0.06), in: Capsule())
                Spacer(minLength: 0)
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(collapsed ? -90 : 0))
            }
            .padding(.horizontal, 4)
            .frame(minHeight: 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .animation(LeoMotion.snappy(reduceMotion: reduceMotion), value: collapsed)
        .animation(LeoMotion.smooth(reduceMotion: reduceMotion, duration: LeoMotion.standard), value: count)
        .padding(.top, LeoTheme.Spacing.xs)
        .padding(.bottom, LeoTheme.Spacing.xxs)
        .frame(maxWidth: .infinity)
        .background(LeoTheme.ColorToken.groupedBackground)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("\(group.title)，\(count) 个任务"))
        .accessibilityValue(Text(collapsed ? "已折叠" : "已展开"))
        .accessibilityHint(Text("轻点两下折叠或展开"))
        .accessibilityAddTraits([.isHeader, .isButton])
        .accessibilityIdentifier("paperclip.section.\(group.rawValue)")
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 14) {
            ZStack {
                Circle().fill(LeoTheme.ColorToken.accent.opacity(0.12)).frame(width: 64, height: 64)
                Image(systemName: "server.rack").font(.title2.weight(.semibold)).foregroundStyle(LeoTheme.ColorToken.accent)
                    .symbolEffect(.pulse, options: .repeating, isActive: busy && !reduceMotion)
            }
            .accessibilityHidden(true)
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
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: LeoTheme.Radius.surface + 6, style: .continuous))
    }
}
