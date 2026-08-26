//
//  SettingsHomeView.swift
//  MinisApp
//
//  [T-settings-ia] 设置首页:4 组折叠 + 搜索。
//
//  为什么是独立文件 + 数据驱动:旧设置页是 ContentView 里 400 行的单体
//  List,三次尝试就地加分层折叠都撞了 SwiftUI 类型检查超时(巨型表达式)。
//  这里每个条目是一条数据,视图逐行小表达式,编译器毫无压力。
//
//  搜索:.searchable,按标题+关键词过滤,命中扁平列出——设置项再多也
//  两秒内找到。分组展开状态用 @AppStorage 记住。
//

import SwiftUI

/// 一行设置项:纯数据。destination 用闭包延迟构建,不进类型推断的大表达式。
struct SettingsEntry: Identifiable {
    let id: String
    let title: String
    let keywords: String
    let icon: String
    let color: Color
    let destination: () -> AnyView

    init(_ title: String, keywords: String, icon: String, color: Color,
         @ViewBuilder destination: @escaping () -> some View) {
        self.id = title
        self.title = title
        self.keywords = keywords
        self.icon = icon
        self.color = color
        let build = destination
        self.destination = { AnyView(build()) }
    }
}

struct SettingsGroup: Identifiable {
    let id: String
    let title: String
    let entries: [SettingsEntry]
}

struct SettingsHomeView: View {
    @Binding var orchestrationEnabled: Bool
    let onFeedback: () -> Void

    @State private var query = ""
    @AppStorage("settings.group.device") private var openDevice = true
    @AppStorage("settings.group.agent") private var openAgent = true
    @AppStorage("settings.group.general") private var openGeneral = false
    @AppStorage("settings.group.data") private var openData = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    // ── 分组数据(个人版信息架构)────────────────────────────────────────
    private var groups: [SettingsGroup] {
        [
            SettingsGroup(id: "device", title: "我的设备", entries: [
                SettingsEntry("远程机器", keywords: "mac android 舰队 中继 relay 密钥 macbook cortex studio fold ipad",
                              icon: "desktopcomputer", color: .teal) { GatewaySettingsView() },
                SettingsEntry("Mac 控制台", keywords: "控制台 console 编码 任务 遥控",
                              icon: "terminal.fill", color: .teal) { GatewayEntryView() },
                SettingsEntry("Siri 指挥中心", keywords: "siri 语音 快捷指令 shortcuts 审批 action button 自动化",
                              icon: "mic.fill", color: .purple) { SiriCommandCenterView() },
                SettingsEntry("本机模型", keywords: "本机 端上 离线 apple intelligence foundation models 改写 摘要 隐私",
                              icon: "cpu.fill", color: .pink) { LocalBrainSettingsView() },
                SettingsEntry("远程主机(SSH·备用)", keywords: "ssh remote host 备用",
                              icon: "server.rack", color: .gray) { RemoteHostSettingsView() },
            ]),
            SettingsGroup(id: "agent", title: "Agent", entries: [
                SettingsEntry("模型供应商", keywords: "provider api key oauth 模型 llm",
                              icon: "key.circle.fill", color: .indigo) { ProviderInstancesView() },
                SettingsEntry("模型分组", keywords: "model group 回退 负载",
                              icon: "gearshape.circle.fill", color: .indigo) { ModelGroupsView() },
                SettingsEntry("推理与模型", keywords: "thinking 推理 读图 压缩 标题 vision compact",
                              icon: "brain.head.profile", color: .indigo) { ThinkingAndModelSlotsView() },
                SettingsEntry("快速任务", keywords: "quick task 捷径",
                              icon: "bolt.fill", color: .indigo) { QuickTaskSettingsView() },
                SettingsEntry("能力中心", keywords: "capabilities 权限 能干什么",
                              icon: "square.grid.2x2.fill", color: .cyan) { CapabilitiesView() },
                SettingsEntry("技能", keywords: "skills 技能包",
                              icon: "sparkles", color: .purple) { SkillsManagementView() },
                SettingsEntry("Soul", keywords: "soul 人格 性格",
                              icon: "heart.fill", color: .pink) { SoulSettingsView() },
                SettingsEntry("记忆", keywords: "memory 记忆库",
                              icon: "brain", color: .purple) { MemoryManagementView() },
                SettingsEntry("MCP 集成", keywords: "mcp server 集成 工具",
                              icon: "puzzlepiece.extension.fill", color: .orange) { MCPIntegrationsView() },
                SettingsEntry("自动化", keywords: "automation 触发 位置 日历 充电",
                              icon: "bolt.badge.clock", color: .orange) { AutomationSettingsView() },
                SettingsEntry("定时任务", keywords: "schedule cron 定时",
                              icon: "clock.badge", color: .orange) { ScheduledTaskSettingsView() },
                SettingsEntry("环境变量", keywords: "environment env 变量",
                              icon: "chevron.left.forwardslash.chevron.right", color: .gray) { EnvironmentVariablesView() },
            ]),
            SettingsGroup(id: "general", title: "外观与通用", entries: [
                SettingsEntry("外观", keywords: "appearance 深色 浅色 主题 主动卡 手电筒 待办",
                              icon: "paintbrush.fill", color: .blue) { AppearanceSettingsView() },
                SettingsEntry("权限", keywords: "permission 审批 offload",
                              icon: "hand.raised.fill", color: .red) { OffloadPermissionSettingsView() },
                SettingsEntry("生物识别保护", keywords: "face id touch id 解锁 保护",
                              icon: "faceid", color: .red) { FaceIDProtectionSettingsView() },
            ]),
            SettingsGroup(id: "data", title: "数据与关于", entries: [
                SettingsEntry("Leo藏宝阁", keywords: "藏宝阁 收藏 笔记 note collect 分享 小红书 favorite 星标 附件 扫描",
                              icon: "star.square.on.square", color: .yellow) { CollectionsView() },
                SettingsEntry("存储", keywords: "storage 空间 清理",
                              icon: "internaldrive.fill", color: .mint) { StorageManagementView() },
                SettingsEntry("共享文件夹", keywords: "shared folder 文件",
                              icon: "folder.fill.badge.person.crop", color: .mint) { SharedFoldersSettingsView() },
                SettingsEntry("挂载外部文件夹", keywords: "mount 外部 folder",
                              icon: "externaldrive.fill", color: .mint) { MountedFoldersSettingsView() },
                SettingsEntry("iCloud 同步", keywords: "icloud sync 同步 云",
                              icon: "icloud", color: .cyan) { CloudSyncSettingsV2View() },
                SettingsEntry("Token 用量", keywords: "usage token 统计 花费",
                              icon: "chart.line.uptrend.xyaxis.circle.fill", color: .green) { UsageStatsView() },
                SettingsEntry("Agent 时间线", keywords: "timeline 今天 做了什么",
                              icon: "list.bullet.rectangle.portrait", color: .mint) { AgentTimelineView() },
                SettingsEntry("更新记录", keywords: "更新 版本 release notes changelog 新功能",
                              icon: "sparkles.rectangle.stack", color: .blue) {
                    LeoReleaseNotesView(mode: .history)
                },
                SettingsEntry("日志", keywords: "logs 日志 反馈 诊断",
                              icon: "doc.text.fill", color: .gray) { LogManagementView() },
                SettingsEntry("隐私与数据", keywords: "privacy 隐私",
                              icon: "lock.shield.fill", color: .blue) { LeoPrivacyView() },
                SettingsEntry("关于", keywords: "about 版本 version",
                              icon: "info.circle.fill", color: .gray) { AboutView() },
            ]),
        ]
    }

    private var searching: Bool {
        !query.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func matches(_ entry: SettingsEntry) -> Bool {
        let haystack = (entry.title + " " + entry.keywords).lowercased()
        return query.lowercased().split(separator: " ").allSatisfy { haystack.contains($0) }
    }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                settingsSearchField
                if searching {
                    searchResults
                } else {
                    controlCenterIntro
                    groupCard(groups[0], isOpen: $openDevice, index: 0)
                    groupCard(groups[1], isOpen: $openAgent, index: 1)
                    orchestrationCard
                    groupCard(groups[2], isOpen: $openGeneral, index: 2)
                    groupCard(groups[3], isOpen: $openData, index: 3)
                    feedbackCard
                }
            }
            .frame(maxWidth: 760)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity)
        }
        .background(LeoTheme.ColorToken.groupedBackground)
        .scrollDismissesKeyboard(.interactively)
    }

    private var settingsSearchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.secondary)
            TextField("搜索设置、能力或设备", text: $query)
                .textInputAutocapitalization(.never)
                .submitLabel(.search)
            if !query.isEmpty {
                Button {
                    withAnimation(LeoMotion.snappy(reduceMotion: reduceMotion)) { query = "" }
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("清除搜索")
            }
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 48)
        .background(LeoTheme.ColorToken.elevatedSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(LeoTheme.ColorToken.separator.opacity(0.25), lineWidth: 0.5)
        }
    }

    private var controlCenterIntro: some View {
        HStack(spacing: 13) {
            Image(systemName: "switch.2")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(.tint)
                .frame(width: 42, height: 42)
                .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text("控制中心")
                    .font(.headline.weight(.bold))
                Text("我的设备、Agent、外观与通用、数据与关于，按使用场景收纳在一处。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .background(LeoTheme.ColorToken.surface, in: RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
        .leoStaggerEntrance(index: 0)
    }

    private var searchResults: some View {
        let hits = groups.flatMap(\.entries).filter(matches)
        return VStack(spacing: 0) {
            if hits.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .font(.title2)
                        .foregroundStyle(.tertiary)
                    Text("没有匹配的设置项")
                        .font(.subheadline.weight(.semibold))
                    Text("试试「模型」、「Mac」、「藏宝阁」或「权限」")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 40)
            } else {
                ForEach(Array(hits.enumerated()), id: \.element.id) { index, entry in
                    SettingsRow(entry: entry)
                    if index < hits.count - 1 {
                        Divider().padding(.leading, 60)
                    }
                }
            }
        }
        .background(LeoTheme.ColorToken.surface, in: RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
        .transition(.opacity.combined(with: .move(edge: .top)))
    }

    private func groupCard(_ group: SettingsGroup, isOpen: Binding<Bool>, index: Int) -> some View {
        VStack(spacing: 0) {
            Button {
                withAnimation(LeoMotion.spring(reduceMotion: reduceMotion, dampingFraction: 0.86)) {
                    isOpen.wrappedValue.toggle()
                }
                LeoHaptics.selection()
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: groupSymbol(group.id))
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(groupTint(group.id))
                        .frame(width: 34, height: 34)
                        .background(groupTint(group.id).opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(group.title)
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(.primary)
                        Text("\(group.entries.count) 项")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.tertiary)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isOpen.wrappedValue ? 90 : 0))
                }
                .padding(.horizontal, 14)
                .frame(minHeight: 58)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(isOpen.wrappedValue ? Text("已展开") : Text("已折叠"))

            if isOpen.wrappedValue {
                Divider().padding(.leading, 60)
                ForEach(Array(group.entries.enumerated()), id: \.element.id) { rowIndex, entry in
                    SettingsRow(entry: entry)
                        .leoStaggerEntrance(index: rowIndex)
                    if rowIndex < group.entries.count - 1 {
                        Divider().padding(.leading, 60)
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .background(LeoTheme.ColorToken.surface, in: RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous)
                .stroke(LeoTheme.ColorToken.separator.opacity(0.2), lineWidth: 0.5)
        }
        .clipShape(RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
        .leoStaggerEntrance(index: index + 1)
    }

    private var orchestrationCard: some View {
        Toggle(isOn: $orchestrationEnabled) {
            HStack(spacing: 12) {
                Image(systemName: "person.3.sequence.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.purple)
                    .frame(width: 34, height: 34)
                    .background(Color.purple.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text("多代理编排").font(.subheadline.weight(.semibold))
                    Text("让多个 Agent 分工协作").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 62)
        .background(LeoTheme.ColorToken.surface, in: RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
        .onChange(of: orchestrationEnabled) { _, _ in LeoHaptics.selection() }
    }

    private var feedbackCard: some View {
        Button(action: onFeedback) {
            HStack(spacing: 12) {
                Image(systemName: "bubble.left.and.bubble.right.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.indigo)
                    .frame(width: 34, height: 34)
                    .background(Color.indigo.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                Text("反馈与建议").font(.subheadline.weight(.semibold))
                Spacer()
                Image(systemName: "arrow.up.right").font(.caption.weight(.bold)).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 58)
            .background(LeoTheme.ColorToken.surface, in: RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
        }
        .buttonStyle(LeoSquishButtonStyle())
        .foregroundStyle(.primary)
    }

    private func groupSymbol(_ id: String) -> String {
        switch id {
        case "device": return "macbook.and.iphone"
        case "agent": return "sparkles"
        case "general": return "paintbrush"
        case "data": return "externaldrive"
        default: return "lock.shield"
        }
    }

    private func groupTint(_ id: String) -> Color {
        switch id {
        case "device": return .teal
        case "agent": return .indigo
        case "general": return .blue
        case "data": return .mint
        default: return .orange
        }
    }
}

private struct SettingsRow: View {
    let entry: SettingsEntry

    var body: some View {
        NavigationLink {
            entry.destination()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: entry.icon)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(entry.color)
                    .frame(width: 34, height: 34)
                    .background(entry.color.opacity(0.11), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                Text(entry.title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 54)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
    }
}

struct ThinkingAndModelSlotsView: View {
    @State private var rules: [ThinkingRule] = ThinkingRuleStore.load()
    @State private var newPrefix = ""
    @State private var newMax: ThinkingLevel = .high
    @ObservedObject private var store = ProviderConfigStore.shared
    @AppStorage(AgentModelSlots.compactKey) private var compactId = ""

    var body: some View {
        List {
            Section {
                ForEach($rules) { $rule in
                    VStack(alignment: .leading, spacing: 8) {
                        TextField("模型 id 前缀", text: $rule.prefix)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Picker("最高档", selection: $rule.maxLevel) {
                            ForEach(ThinkingLevel.allCases.filter { $0 != .off }, id: \.self) { level in
                                Text(level.displayName).tag(level)
                            }
                        }
                        Picker("默认档", selection: $rule.defaultLevel) {
                            ForEach(ThinkingLevel.allCases.filter { $0 != .off && $0 <= rule.maxLevel }, id: \.self) { level in
                                Text(level.displayName).tag(level)
                            }
                        }
                    }
                    .padding(.vertical, 4)
                }
                .onDelete { rules.remove(atOffsets: $0); ThinkingRuleStore.save(rules) }
                HStack {
                    TextField("新前缀，如 gpt-5.7", text: $newPrefix)
                        .textInputAutocapitalization(.never)
                    Button("添加") {
                        let prefix = newPrefix.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !prefix.isEmpty else { return }
                        rules.append(ThinkingRule(prefix: prefix, maxLevel: newMax, defaultLevel: min(.medium, newMax)))
                        ThinkingRuleStore.save(rules)
                        newPrefix = ""
                    }
                }
            } header: {
                Text("推理强度规则")
            } footer: {
                Text("一行一个模型家族。读不到内置档时在这里写最高档，否则界面显示未知，不会默默降级。")
            }

            Section {
                Picker("压缩 / 标题", selection: $compactId) {
                    Text("跟当前会话模型").tag("")
                    ForEach(store.modelEntries.filter { !$0.isHidden }, id: \.id) { entry in
                        Text(entry.model.id).tag(entry.id)
                    }
                }
            } footer: {
                Text("只给压缩和标题用一个便宜模型。对话仍走当前会话模型。")
            }
        }
        .navigationTitle("推理与模型")
        .onChange(of: rules) { _ in ThinkingRuleStore.save(rules) }
    }
}
