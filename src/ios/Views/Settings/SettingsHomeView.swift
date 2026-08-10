//
//  SettingsHomeView.swift
//  MinisApp
//
//  [T-settings-ia] 设置首页:5 组折叠 + 搜索。
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
    @AppStorage("settings.group.advanced") private var openAdvanced = false

    // ── 分组数据(个人版信息架构)────────────────────────────────────────
    private var groups: [SettingsGroup] {
        [
            SettingsGroup(id: "device", title: "我的设备", entries: [
                SettingsEntry("我的 Mac", keywords: "mac 舰队 中继 relay 密钥 macbook cortex studio",
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
            ]),
            SettingsGroup(id: "general", title: "外观与通用", entries: [
                SettingsEntry("外观", keywords: "appearance 深色 浅色 主题",
                              icon: "paintbrush.fill", color: .blue) { AppearanceSettingsView() },
            ]),
            SettingsGroup(id: "data", title: "数据", entries: [
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
                              icon: "sparkles.rectangle.stack", color: .blue) { ReleaseNotesView() },
                SettingsEntry("日志", keywords: "logs 日志 反馈 诊断",
                              icon: "doc.text.fill", color: .gray) { LogManagementView() },
            ]),
            SettingsGroup(id: "advanced", title: "高级", entries: [
                SettingsEntry("环境变量", keywords: "environment env 变量",
                              icon: "chevron.left.forwardslash.chevron.right", color: .gray) { EnvironmentVariablesView() },
                SettingsEntry("权限", keywords: "permission 审批 offload",
                              icon: "hand.raised.fill", color: .red) { OffloadPermissionSettingsView() },
                SettingsEntry("生物识别保护", keywords: "face id touch id 解锁 保护",
                              icon: "faceid", color: .red) { FaceIDProtectionSettingsView() },
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
        List {
            if searching {
                let hits = groups.flatMap(\.entries).filter(matches)
                if hits.isEmpty {
                    Text("没有匹配的设置项").foregroundStyle(.secondary)
                } else {
                    ForEach(hits) { entry in
                        SettingsRow(entry: entry)
                    }
                }
            } else {
                groupSection(groups[0], isOpen: $openDevice)
                groupSection(groups[1], isOpen: $openAgent)
                orchestrationRow
                groupSection(groups[2], isOpen: $openGeneral)
                groupSection(groups[3], isOpen: $openData)
                groupSection(groups[4], isOpen: $openAdvanced)
                feedbackRow
            }
        }
        .searchable(text: $query, prompt: "搜索设置")
    }

    private func groupSection(_ group: SettingsGroup, isOpen: Binding<Bool>) -> some View {
        Section {
            DisclosureGroup(isExpanded: isOpen) {
                ForEach(group.entries) { entry in
                    SettingsRow(entry: entry)
                }
            } label: {
                Text(group.title).font(.system(size: 15, weight: .semibold))
            }
        }
    }

    private var orchestrationRow: some View {
        Section {
            Toggle(isOn: $orchestrationEnabled) {
                Label {
                    Text("多代理编排")
                } icon: {
                    Image(systemName: "person.3.sequence.fill")
                        .font(.system(size: 9)).foregroundStyle(.white)
                        .frame(width: 21, height: 21)
                        .background(.purple, in: Circle())
                }
            }
        }
    }

    private var feedbackRow: some View {
        Section {
            Button(action: onFeedback) {
                Label {
                    Text("反馈")
                } icon: {
                    Image(systemName: "bubble.left.and.bubble.right.fill")
                        .font(.system(size: 9)).foregroundStyle(.white)
                        .frame(width: 21, height: 21)
                        .background(.indigo, in: Circle())
                }
            }
            .foregroundStyle(.primary)
        }
    }
}

private struct SettingsRow: View {
    let entry: SettingsEntry

    var body: some View {
        NavigationLink {
            entry.destination()
        } label: {
            Label {
                Text(entry.title)
            } icon: {
                Image(systemName: entry.icon)
                    .font(.system(size: 10)).foregroundStyle(.white)
                    .frame(width: 21, height: 21)
                    .background(entry.color, in: Circle())
            }
        }
    }
}
