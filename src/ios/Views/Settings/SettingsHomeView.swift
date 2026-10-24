//
//  SettingsHomeView.swift
//  MinisApp
//
//  [T-settings-ia] 设置首页:常用方块 + 8 组始终展开 + 分类跳转条 + 搜索(1.86 去掉折叠)。
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
    /// 一句话说清这一项管什么。只给容易混淆的条目写(远程机器 vs Mac 控制台),
    /// 其余保持一行一个对象。
    let hint: String?
    let destination: () -> AnyView

    init(_ title: String, keywords: String, icon: String, color: Color, hint: String? = nil,
         @ViewBuilder destination: @escaping () -> some View) {
        self.id = title
        self.title = title
        self.keywords = keywords
        self.icon = icon
        self.color = color
        self.hint = hint
        let build = destination
        self.destination = { AnyView(build()) }
    }
}

extension SettingsEntry {
    func matches(_ query: String) -> Bool {
        let haystack = (title + " " + keywords).lowercased()
        return query.lowercased().split(separator: " ").allSatisfy { haystack.contains($0) }
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
    /// 分类跳转条:点胶囊滚到该组;滚动时高亮当前组(scrollPosition 只在跨组时变一次,不逐帧算)。
    @State private var currentGroup: String?
    @Namespace private var chipNamespace
    /// 只为在开关变化时重画(groups 是静态的,直接读 UserDefaults)。
    @AppStorage(MacFleetFeature.defaultsKey) private var macFleetEnabled = false
    @AppStorage("appearanceMode") private var appearanceMode: Int = 0
    @ObservedObject private var providers = ProviderConfigStore.shared
    @ObservedObject private var hosts = GatewayHostStore.shared
    @ObservedObject private var fullAuto = FullAutoStore.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var tileSize: CGFloat = 29

    private var groups: [SettingsGroup] { Self.groups }
    /// 分组列表的卡片色:浅色下是白、深色下比底色亮一档。LeoTheme.surface(secondarySystemBackground)
    /// 在浅色下和 groupedBackground 一模一样,卡片会「消失」。
    static let card = Color(uiColor: .secondarySystemGroupedBackground)

    /// [F-mac-fleet-advanced] Mac 舰队没打开时不显示「Mac 控制台」。
    private static var macConsoleEntries: [SettingsEntry] {
        guard MacFleetFeature.isEnabled() else { return [] }
        return [SettingsEntry("Mac 控制台", keywords: "控制台 console 编码 任务 遥控",
                              icon: "terminal.fill", color: .teal,
                              hint: "在已连接的 Mac 上发任务、看进度、审批") { GatewayEntryView() }]
    }

    // ── 分组数据(个人版信息架构)────────────────────────────────────────
    /// 单列首页和 iPad 双栏的侧栏共用这一份。[1.86] 每一项只在一个分组里(常用改成首页顶部的
    /// 快捷方块,不再从别的组「偷」条目);条目标题即 id(iPad 侧栏按标题记选中项),不能改。
    static var groups: [SettingsGroup] {
        [
            SettingsGroup(id: "models", title: "模型与推理", entries: [
                SettingsEntry("AI 服务商", keywords: "provider api key oauth 模型 llm 模型供应商",
                              icon: "key.fill", color: .indigo) { ProviderInstancesView() },
                SettingsEntry("模型分组", keywords: "model group 回退 负载",
                              icon: "square.stack.3d.up.fill", color: .indigo) { ModelGroupsView() },
                SettingsEntry("推理与模型", keywords: "thinking 推理 读图 压缩 标题 vision compact 上下文 裁剪 精简 context trim",
                              icon: "brain.head.profile", color: .indigo,
                              hint: "思考深度、读图、压缩与标题用哪个模型") { ThinkingAndModelSlotsView() },
                SettingsEntry("快速判断模型", keywords: "jev 快速判断 typesafe system one 快速判断 分类 打分",
                              icon: "bolt.horizontal.fill", color: .indigo,
                              hint: "TypeSafe 的快判断模型,填 Key 后 Agent 多一个 jev_decide 工具") { JevSettingsView() },
                SettingsEntry("本机模型", keywords: "本机 端上 离线 apple intelligence foundation models 改写 摘要 隐私",
                              icon: "cpu.fill", color: .indigo) { LocalBrainSettingsView() },
            ]),
            SettingsGroup(id: "abilities", title: "能力与工具", entries: [
                SettingsEntry("技能", keywords: "skills 技能包",
                              icon: "sparkles", color: .purple) { SkillsManagementView() },
                SettingsEntry("MCP 集成", keywords: "mcp server 集成 工具",
                              icon: "puzzlepiece.extension.fill", color: .purple) { MCPIntegrationsView() },
                SettingsEntry("工具开关", keywords: "tools 工具 开关 浏览器 browser 子代理 定时跟进 关闭",
                              icon: "switch.2", color: .purple,
                              hint: "浏览器、子代理、定时跟进可以分别关掉") { ToolTogglesSettingsView() },
                SettingsEntry("手机能力与授权", keywords: "能力中心 capabilities 权限 能干什么",
                              icon: "square.grid.2x2.fill", color: .purple,
                              hint: "Agent 能调用哪些手机能力，系统授权到哪一步") { CapabilitiesView() },
                SettingsEntry("子代理", keywords: "sub agent subagent helper 子代理 委派 角色 并行",
                              icon: "person.2.fill", color: .purple,
                              hint: "让 Agent 把独立任务交给后台子代理并行完成") { HelperSettingsView() },
                SettingsEntry("邮箱账户", keywords: "mail email imap 邮箱 邮件 gmail qq 163 126 icloud",
                              icon: "envelope.fill", color: .purple,
                              hint: "授权 Gmail / QQ / 163 等邮箱,对话里直接读邮件") { MailAccountsView() },
                SettingsEntry("环境变量", keywords: "environment env 变量",
                              icon: "chevron.left.forwardslash.chevron.right", color: .purple) { EnvironmentVariablesView() },
            ]),
            SettingsGroup(id: "knowledge", title: "记忆与资料", entries: [
                SettingsEntry("记忆", keywords: "memory 记忆库",
                              icon: "brain", color: .pink) { MemoryManagementView() },
                SettingsEntry("资料库", keywords: "brain archive 资料库 第二大脑 知识卡 文件 mini 网关 令牌",
                              icon: "books.vertical.fill", color: .pink,
                              hint: "连接 Mac 上的资料库,藏宝阁和 Agent 都能查你的旧资料") { BrainSettingsView() },
                SettingsEntry("人设", keywords: "灵魂 soul 人格 性格",
                              icon: "heart.fill", color: .pink,
                              hint: "Agent 的说话风格和性格") { SoulSettingsView() },
                SettingsEntry("Leo藏宝阁", keywords: "藏宝阁 收藏 笔记 note collect 分享 小红书 favorite 星标 附件 扫描",
                              icon: "star.square.on.square.fill", color: .pink) { CollectionsView() },
            ]),
            SettingsGroup(id: "automation", title: "自动化", entries: [
                SettingsEntry("快捷任务", keywords: "quick task 捷径 快速任务",
                              icon: "bolt.fill", color: .orange) { QuickTaskSettingsView() },
                SettingsEntry("自动化", keywords: "automation 触发 位置 日历 充电",
                              icon: "bolt.badge.clock.fill", color: .orange) { AutomationSettingsView() },
                SettingsEntry("定时任务", keywords: "schedule cron 定时",
                              icon: "clock.fill", color: .orange) { ScheduledTaskSettingsView() },
                SettingsEntry("快捷指令模板", keywords: "配方 shortcuts 快捷指令 自动化 配方 siri 到家 车载 蓝牙 晨报 recipe",
                              icon: "square.on.square.fill", color: .orange,
                              hint: "到家、上车、按一下按钮，让 Agent 自己动起来") { ShortcutRecipesView() },
                SettingsEntry("Siri 指挥中心", keywords: "siri 语音 快捷指令 shortcuts 审批 action button 自动化",
                              icon: "mic.fill", color: .orange) { SiriCommandCenterView() },
            ]),
            SettingsGroup(id: "devices", title: "设备与连接", entries: macConsoleEntries + [
                SettingsEntry("远程机器", keywords: "mac android 舰队 中继 relay 密钥 macbook cortex studio fold ipad",
                              icon: "desktopcomputer", color: .teal,
                              hint: "连接哪几台 Mac、中继地址与密钥") { GatewaySettingsView() },
                SettingsEntry("Apple Watch", keywords: "手表 watch 蜂窝 直连 独立 模型 cellular",
                              icon: "applewatch", color: .teal,
                              hint: "手表用哪个模型、离开 iPhone 能不能自己回答") { WatchSettingsView() },
                SettingsEntry("iCloud 同步", keywords: "icloud sync 同步 云",
                              icon: "icloud.fill", color: .teal) { CloudSyncSettingsV2View() },
                SettingsEntry("远程主机(SSH·备用)", keywords: "ssh remote host 备用",
                              icon: "server.rack", color: .teal,
                              hint: "旧通道，只在中继不可用时使用") { RemoteHostSettingsView() },
            ]),
            SettingsGroup(id: "general", title: "通用", entries: [
                SettingsEntry("权限", keywords: "permission 审批 offload 全自动 自动批准 不再询问 yolo",
                              icon: "hand.raised.fill", color: .blue,
                              hint: "全自动开关；Agent 动用某项能力前，是直接放行还是先问你") { OffloadPermissionSettingsView() },
                SettingsEntry("外观", keywords: "appearance 深色 浅色 主题 语言 字体 字号 图标 启动 回车 复制 language font icon mac 进行中",
                              icon: "paintbrush.fill", color: .blue) { AppearanceSettingsView() },
                // 以前只能从 权限 → 后台 进去,搜「后台」「通知」「灵动岛」都搜不到。
                SettingsEntry("后台与通知", keywords: "background 后台 保活 keep alive 通知 notification 实时活动 灵动岛 live activity 定位 位置追踪 朗读 语音 音色 隐私模式",
                              icon: "bell.badge.fill", color: .blue) { EnhancedBackgroundSettingsView() },
                // 1.57 的实时出字、自动改字、热词、语音度量都在这一页;以前只能从 AI 服务商里翻到。
                SettingsEntry("语音识别", keywords: "语音 识别 听写 实时出字 改字 热词 度量 离线 语言资源 speech",
                              icon: "waveform", color: .blue,
                              hint: "实时出字、自动改字、热词与离线语言包") { SystemSpeechResourcesView() },
                SettingsEntry("生物识别保护", keywords: "face id touch id 解锁 保护 spotlight 聚焦 搜索",
                              icon: "faceid", color: .blue) { FaceIDProtectionSettingsView() },
                SettingsEntry("隐私与数据", keywords: "privacy 隐私",
                              icon: "lock.shield.fill", color: .blue) { LeoPrivacyView() },
            ]),
            SettingsGroup(id: "data", title: "数据与诊断", entries: [
                SettingsEntry("存储", keywords: "storage 空间 清理",
                              icon: "internaldrive.fill", color: .gray) { StorageManagementView() },
                SettingsEntry("共享文件夹", keywords: "shared folder 文件",
                              icon: "folder.fill.badge.person.crop", color: .gray) { SharedFoldersSettingsView() },
                SettingsEntry("挂载外部文件夹", keywords: "mount 外部 folder",
                              icon: "externaldrive.fill", color: .gray) { MountedFoldersSettingsView() },
                SettingsEntry("备份与恢复", keywords: "backup restore 备份 恢复 导出 导入 迁移 换机 minisbak",
                              icon: "archivebox.fill", color: .gray,
                              hint: "把数据打包成一个文件，换机或出问题时合并恢复") { BackupSettingsView() },
                SettingsEntry("Token 用量", keywords: "usage token 统计 花费",
                              icon: "chart.bar.fill", color: .gray) { UsageStatsView() },
                SettingsEntry("Agent 时间线", keywords: "timeline 今天 做了什么",
                              icon: "list.bullet.rectangle.portrait.fill", color: .gray) { AgentTimelineView() },
                SettingsEntry("能力自检", keywords: "自检 测试 能力 诊断 health check selftest",
                              icon: "checklist.checked", color: .gray,
                              hint: "把每项能力按 Agent 的路径只读跑一遍") { CapabilitySelfTestView() },
                SettingsEntry("日志", keywords: "logs 日志 反馈 诊断",
                              icon: "doc.text.fill", color: .gray) { LogManagementView() },
            ]),
            SettingsGroup(id: "about", title: "关于", entries: [
                SettingsEntry("更新记录", keywords: "更新 版本 release notes changelog 新功能",
                              icon: "sparkles.rectangle.stack.fill", color: .gray) {
                    LeoReleaseNotesView(mode: .history)
                },
                SettingsEntry("新手引导", keywords: "onboarding 引导 新手 入门 帮助 help 连接模型 配对 mac 第一个任务",
                              icon: "figure.wave", color: .gray,
                              hint: "连接模型、配对 Mac、派第一个任务") {
                    OnboardingFlowView(presentation: .pushed) { prefill in
                        guard let prefill else { return }
                        NotificationCenter.default.post(name: .onboardingPrefillRequested, object: nil,
                                                        userInfo: ["prompt": prefill])
                    }
                },
                SettingsEntry("关于", keywords: "about 版本 version",
                              icon: "info.circle.fill", color: .gray) { AboutView() },
            ]),
        ]
    }

    /// 首页顶部的「常用」快捷方块(条目仍只属于各自分组;iPad 侧栏不渲染这一块,免得同一个选中标签出现两次)。
    static let pinnedTitles = ["AI 服务商", "远程机器", "权限", "外观"]


    private var searching: Bool {
        !query.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func matches(_ entry: SettingsEntry) -> Bool { entry.matches(query) }

    /// 行尾的当前值:一眼看到状态,不用点进去(系统设置的做法)。只给有明确状态的几项。
    private func value(for entry: SettingsEntry) -> String? {
        switch entry.title {
        case "外观": return appearanceMode == 1 ? "浅色" : appearanceMode == 2 ? "深色" : "跟随系统"
        case "权限":
            switch fullAuto.mode {
            case .full: return "全自动"
            case .smart: return "智能批准"
            case .ask: return "逐项确认"
            }
        case "AI 服务商":
            let count = providers.config.instances.filter(\.isEnabled).count
            return count == 0 ? "未添加" : "\(count) 个"
        case "远程机器":
            let count = hosts.hosts.count
            return count == 0 ? "未连接" : "\(count) 台"
        default: return nil
        }
    }

    var body: some View {
        ScrollView {
            // 普通 VStack:45 行很轻,LazyVStack 里跳到还没建出来的分组会滚不到位。
            VStack(spacing: 0) {
                settingsSearchField
                    .padding(.bottom, 16)
                if searching {
                    searchResults
                        .transition(.opacity)
                } else {
                    pinnedTiles
                        .padding(.bottom, 8)
                    ForEach(groups) { group in
                        groupSection(group)
                    }
                }
            }
            .scrollTargetLayout()
            .frame(maxWidth: 720)
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 32)
            .frame(maxWidth: .infinity)
        }
        .scrollPosition(id: $currentGroup, anchor: .top)
        .safeAreaInset(edge: .top, spacing: 0) {
            if !searching { categoryBar }
        }
        .background(LeoTheme.ColorToken.groupedBackground)
        .scrollDismissesKeyboard(.interactively)
        .animation(LeoMotion.smooth(reduceMotion: reduceMotion), value: searching)
    }

    // MARK: 分类跳转条

    private var categoryBar: some View {
        ScrollViewReader { chips in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(groups) { group in
                        let active = currentGroup == group.id
                        Button {
                            LeoHaptics.selection()
                            withAnimation(LeoMotion.smooth(reduceMotion: reduceMotion)) { currentGroup = group.id }
                        } label: {
                            Text(group.title)
                                .font(.subheadline.weight(active ? .semibold : .regular))
                                .foregroundStyle(active ? Color.white : Color.primary)
                                .padding(.horizontal, 12)
                                .frame(minHeight: 32)
                                .background {
                                    if active {
                                        Capsule().fill(Self.groupTint(group.id))
                                            .matchedGeometryEffect(id: "chip", in: chipNamespace)
                                    } else {
                                        Capsule().fill(Self.card)
                                    }
                                }
                                .contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .id(group.id)
                        .accessibilityAddTraits(active ? .isSelected : [])
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }
            .background(.bar)
            .onChange(of: currentGroup) { _, id in
                guard let id else { return }
                withAnimation(LeoMotion.snappy(reduceMotion: reduceMotion)) { chips.scrollTo(id, anchor: .center) }
            }
        }
    }

    private var settingsSearchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.body.weight(.medium))
                .foregroundStyle(.secondary)
            TextField("搜索设置、能力或设备", text: $query)
                .textInputAutocapitalization(.never)
                .submitLabel(.search)
            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("清除搜索")
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 40)
        .background(Self.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .id("search")
    }

    // MARK: 常用

    private var pinnedTiles: some View {
        let entries = Self.pinnedTitles.compactMap { title in groups.flatMap(\.entries).first { $0.title == title } }
        return VStack(alignment: .leading, spacing: 6) {
            Text("常用")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.leading, 4)
                .accessibilityAddTraits(.isHeader)
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                ForEach(entries) { entry in
                    NavigationLink { entry.destination() } label: {
                        VStack(alignment: .leading, spacing: 10) {
                            SettingsIconTile(icon: entry.icon, color: LeoTheme.ColorToken.accent, size: tileSize + 3)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(entry.title).font(.body.weight(.semibold)).foregroundStyle(.primary)
                                Text(value(for: entry) ?? " ").font(.footnote).foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                        .background(Self.card, in: RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
                        .contentShape(RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
                    }
                    .buttonStyle(LeoSquishButtonStyle())
                    .accessibilityLabel(Text([entry.title, value(for: entry)].compactMap { $0 }.joined(separator: "，")))
                }
            }
        }
        .padding(.bottom, 16)
        .id("pinned")
    }

    // MARK: 分组

    private func groupSection(_ group: SettingsGroup) -> some View {
        let tint = Self.groupTint(group.id)
        return VStack(alignment: .leading, spacing: 6) {
            Text(group.title)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.leading, 4)
                .accessibilityAddTraits(.isHeader)
            VStack(spacing: 0) {
                ForEach(Array(group.entries.enumerated()), id: \.element.id) { index, entry in
                    if index > 0 { rowDivider }
                    SettingsRow(entry: entry, tint: tint, tileSize: tileSize, value: value(for: entry))
                }
                if group.id == "abilities" {
                    rowDivider
                    orchestrationRow(tint: tint)
                }
                if group.id == "about" {
                    rowDivider
                    feedbackRow(tint: tint)
                }
            }
            .background(Self.card, in: RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
            .clipShape(RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
        }
        .padding(.bottom, 22)
        .id(group.id)
    }

    private var rowDivider: some View {
        Divider().padding(.leading, 16 + tileSize + 12)
    }

    private var searchResults: some View {
        let hits = groups.flatMap { group in group.entries.filter(matches).map { (group, $0) } }
        return VStack(spacing: 0) {
            if hits.isEmpty {
                LeoEmptyState(systemImage: "magnifyingglass", title: AppLocalized("没有匹配的设置项"),
                              message: AppLocalized("试试「模型」、「Mac」、「藏宝阁」或「权限」"))
            } else {
                ForEach(Array(hits.enumerated()), id: \.element.1.id) { index, hit in
                    if index > 0 { rowDivider }
                    SettingsRow(entry: hit.1, tint: Self.groupTint(hit.0.id), tileSize: tileSize,
                                value: value(for: hit.1), context: hit.0.title)
                }
            }
        }
        .background(Self.card, in: RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
    }

    private func orchestrationRow(tint: Color) -> some View {
        Toggle(isOn: $orchestrationEnabled) {
            HStack(spacing: 12) {
                SettingsIconTile(icon: "person.3.sequence.fill", color: tint, size: tileSize)
                VStack(alignment: .leading, spacing: 2) {
                    Text("多 Agent 编排").font(.body).foregroundStyle(.primary)
                    Text("让多个 Agent 分工协作").font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(minHeight: 52)
        .onChange(of: orchestrationEnabled) { _, _ in LeoHaptics.selection() }
    }

    private func feedbackRow(tint: Color) -> some View {
        Button(action: onFeedback) {
            HStack(spacing: 12) {
                SettingsIconTile(icon: "bubble.left.and.bubble.right.fill", color: tint, size: tileSize)
                Text("反馈与建议").font(.body).foregroundStyle(.primary)
                Spacer()
                // Feedback is saved locally, so no external-link arrow.
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
    }

    static func groupSymbol(_ id: String) -> String {
        switch id {
        case "models": return "sparkles"
        case "abilities": return "wrench.and.screwdriver"
        case "knowledge": return "books.vertical"
        case "automation": return "bolt.badge.clock"
        case "devices": return "macbook.and.iphone"
        case "general": return "gearshape"
        case "data": return "externaldrive"
        default: return "info.circle"
        }
    }

    /// 每组一个色系(5 个色相 + 中性灰),颜色只出现在图标块上,不再给整条分组头上色。
    static func groupTint(_ id: String) -> Color {
        switch id {
        case "models": return .indigo
        case "abilities": return .purple
        case "knowledge": return .pink
        case "automation": return .orange
        case "devices": return .teal
        case "general": return .blue
        default: return .gray
        }
    }
}

/// 系统设置式的实色圆角图标块(白色符号)。
struct SettingsIconTile: View {
    let icon: String
    let color: Color
    var size: CGFloat = 29

    var body: some View {
        Image(systemName: icon)
            .font(.system(size: size * 0.5, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(color.gradient, in: RoundedRectangle(cornerRadius: size * 0.26, style: .continuous))
            .accessibilityHidden(true)
    }
}

private struct SettingsRow: View {
    let entry: SettingsEntry
    let tint: Color
    let tileSize: CGFloat
    var value: String?
    /// 搜索结果里显示所属分组,告诉用户它平时在哪。
    var context: String?

    var body: some View {
        NavigationLink {
            entry.destination()
        } label: {
            HStack(spacing: 12) {
                SettingsIconTile(icon: entry.icon, color: tint, size: tileSize)
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.title)
                        .font(.body)
                        .foregroundStyle(.primary)
                    if let hint = entry.hint {
                        Text(hint)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 8)
                if let trailing = value ?? context {
                    Text(trailing)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, entry.hint == nil ? 0 : 9)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .accessibilityValue(Text(value ?? ""))
    }
}

struct ThinkingAndModelSlotsView: View {
    @State private var rules: [ThinkingRule] = ThinkingRuleStore.load()
    @State private var editing: ThinkingRule?
    @State private var creating = false
    @ObservedObject private var store = ProviderConfigStore.shared
    @AppStorage(AgentModelSlots.compactKey) private var compactId = ""
    @AppStorage(IncrementalContextTrimmer.enabledKey) private var incrementalTrim = true

    var body: some View {
        List {
            // [WP-40] 规则改成「列表 + 编辑页」:行里只显示摘要,点开编辑(命中预览、请求预览、
            // 作用范围都在编辑页);顺序即优先级,可拖动排序。
            Section {
                ForEach(rules) { rule in
                    Button { editing = rule } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(rule.label).foregroundStyle(.primary)
                            Text(summary(rule)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .onDelete { rules.remove(atOffsets: $0) }
                .onMove { rules.move(fromOffsets: $0, toOffset: $1) }
                Button {
                    creating = true
                } label: {
                    Label("添加规则", systemImage: "plus")
                }
            } header: {
                HStack {
                    Text("推理强度规则")
                    Spacer()
                    if rules.count > 1 { EditButton().font(.caption) }
                }
            } footer: {
                Text("一行一个模型家族(前缀,支持 * 通配),从上往下先匹配先用。读不到内置档时在这里写最高档,否则界面显示未知,不会默默降级。")
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

            Section {
                Toggle("精简旧上下文", isOn: $incrementalTrim)
            } footer: {
                Text("发送时把较早轮次的思考过程清空、过长的工具输出只留开头结尾、很早的工具调用折成一行，只影响发给模型的内容，聊天记录不变。省 token、推迟压缩。")
            }
        }
        .navigationTitle("推理与模型")
        .onChange(of: rules) { _ in ThinkingRuleStore.save(rules) }
        .sheet(item: $editing) { rule in
            ThinkingRuleEditorView(existing: rule) { updated in
                if let next = try? ThinkingRuleEdits.replacing(updated, in: rules) { rules = next }
            }
        }
        .sheet(isPresented: $creating) {
            ThinkingRuleEditorView(existing: nil) { rule in
                rules = ThinkingRuleEdits.inserting(rule, into: rules)
            }
        }
        // minis-config 可能在别处改了规则:回到这一页时重读。
        .onAppear { rules = ThinkingRuleStore.load() }
    }

    private func summary(_ rule: ThinkingRule) -> String {
        var parts = [rule.patternText]
        if let level = rule.maxLevel { parts.append("最高 \(level.displayName)") }
        if let wire = rule.wireFormat { parts.append(wire.displaySummary) }
        if let pid = rule.providerInstanceId {
            parts.append(store.instances.first { $0.id == pid }?.label ?? "指定服务商")
        }
        return parts.joined(separator: " · ")
    }
}

// MARK: - iPad 双栏

/// [T-ipad-settings-split] 宽窗口里的设置:左边分组、右边详情,和系统「设置」一样。
/// 条目、搜索词和首页同一份数据;窄窗口(iPhone、分屏窄栏)仍是单列首页。
struct SettingsSidebar: View {
    @Binding var selection: String?
    @Binding var orchestrationEnabled: Bool
    let onFeedback: () -> Void
    @State private var query = ""
    /// 只为在开关变化时重画(groups 是静态的,直接读 UserDefaults)。
    @AppStorage(MacFleetFeature.defaultsKey) private var macFleetEnabled = false

    private var visibleGroups: [SettingsGroup] {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return SettingsHomeView.groups }
        return SettingsHomeView.groups.compactMap { group in
            let hits = group.entries.filter { $0.matches(trimmed) }
            return hits.isEmpty ? nil : SettingsGroup(id: group.id, title: group.title, entries: hits)
        }
    }

    var body: some View {
        List(selection: $selection) {
            ForEach(visibleGroups) { group in
                Section {
                    ForEach(group.entries) { entry in
                        Label {
                            Text(entry.title)
                        } icon: {
                            SettingsIconTile(icon: entry.icon, color: SettingsHomeView.groupTint(group.id), size: 28)
                        }
                        .tag(entry.id)
                    }
                } header: {
                    Text(group.title)
                }
            }
            if query.isEmpty {
                Section {
                    Toggle(isOn: $orchestrationEnabled) {
                        Label("多 Agent 编排", systemImage: "person.3.sequence.fill")
                    }
                    Button(action: onFeedback) {
                        Label("反馈与建议", systemImage: "bubble.left.and.bubble.right.fill")
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .searchable(text: $query, placement: .sidebar, prompt: "搜索设置、能力或设备")
        .overlay {
            if visibleGroups.isEmpty {
                ContentUnavailableView.search(text: query)
            }
        }
    }
}

/// [T-thinking-rules-phase2] Wire shapes a user may pick for a rule — the subset that is
/// safe to choose without editing JSON. `.followBuiltIn` leaves the wire shape to the
/// built-in vendor rules (the rule then only carries a ceiling).
enum ThinkingWireChoice: Hashable, CaseIterable {
    case followBuiltIn
    case reasoningEffort
    case reasoningEffortNested
    case deepSeekSibling
    case qwenRootOnly
    /// enable_thinking + thinking_budget,根级和 extra_body 各一份:只给 DashScope 本身用。
    case qwenDual
    case omitEverything

    init(_ format: ThinkingWireFormat?) {
        switch format {
        case .reasoningEffort?: self = .reasoningEffort
        case .reasoningEffortNested?: self = .reasoningEffortNested
        case .deepSeekSibling?: self = .deepSeekSibling
        case .qwenRootOnly?: self = .qwenRootOnly
        case .qwenDual?: self = .qwenDual
        case .omitEverything?: self = .omitEverything
        default: self = .followBuiltIn
        }
    }

    var wireFormat: ThinkingWireFormat? {
        switch self {
        case .followBuiltIn: return nil
        case .reasoningEffort: return .reasoningEffort(offValue: nil)
        case .reasoningEffortNested: return .reasoningEffortNested(offValue: nil)
        case .deepSeekSibling: return .deepSeekSibling
        case .qwenRootOnly: return .qwenRootOnly
        case .qwenDual: return .qwenDual
        case .omitEverything: return .omitEverything
        }
    }

    var title: String {
        switch self {
        case .followBuiltIn: return "跟随内置"
        case .reasoningEffort: return "reasoning_effort"
        case .reasoningEffortNested: return "reasoning.effort（嵌套）"
        case .deepSeekSibling: return "DeepSeek（thinking + reasoning_effort）"
        case .qwenRootOnly: return "enable_thinking"
        case .qwenDual: return "enable_thinking + 预算(仅 DashScope)"
        case .omitEverything: return "不发送思考参数"
        }
    }
}
