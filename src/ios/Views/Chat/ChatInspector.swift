//
//  ChatInspector.swift
//  MinisApp
//
//  [T-ipad-inspector] iPad split layout: what the agent is doing, beside the
//  conversation instead of on top of it. On iPhone the same views stay sheets.
//
//  Lives in a small container around AIChatView (not on AIChatView's own
//  modifier chain, which is already near the runtime's metadata-depth limit —
//  see the camera cover note in AIChatView).
//

import SwiftUI

private let inspectorLog = AppLogger(category: "Inspector")

/// [WP-43] A request from this window's ⌘K palette to show the third column
/// in a mode. The nonce makes asking twice for the same mode count.
struct ChatContextRequest: Equatable {
    let mode: ChatContextColumnPolicy.Mode
    let nonce: Int
}

/// Wraps the chat in the iPad detail column and owns the inspector column
/// (WP-43: the third column, 文件/工具详情 or Mac 画面).
struct ChatDetailContainer<Content: View>: View {
    let sessionId: String?
    /// [WP-43] The window's width: the column opens by itself at ≥ 1100 pt.
    /// [duo-shell] …and, once the user pinned it, at ≥ 900 pt (iPhone Duo inner
    /// landscape is 951 and never reaches 1100).
    var windowWidth: CGFloat = 0
    var contextRequest: ChatContextRequest? = nil
    @ViewBuilder let content: Content

    /// Per window: two windows side by side each keep their own.
    @SceneStorage("leo.ipad.inspectorVisible") private var inspectorVisible = false
    @SceneStorage("leo.ipad.contextMode") private var contextModeRaw = ChatContextColumnPolicy.Mode.details.rawValue
    /// Width the ≥ 1100 pt rule last ran at; the container is rebuilt on every
    /// session switch, so this keeps a hand-closed column closed until the
    /// window actually crosses the threshold.
    @SceneStorage("leo.ipad.contextRuleWidth") private var contextRuleWidth: Double = 0
    /// [duo-shell] The user showed the column by hand (toolbar button, ⌥⌘I / ⇧⌘M)
    /// in a window ≥ 900 pt: it then reopens whenever a window is that wide —
    /// e.g. every time an iPhone Duo is unfolded — and survives shrinking from
    /// ≥ 1100 to 900–1100. Hiding it by hand there unpins it. App-wide, so a
    /// new window picks it up too.
    @AppStorage("leo.ipad.inspectorPinned") private var inspectorPinned = false
    /// [F8] Shared with ChatInspectorPanel so the chat's "…" menu can open a tab.
    @AppStorage("leo.ipad.inspectorTab") private var inspectorTab = ChatInspectorPanel.Tab.run.rawValue
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var contentFrame: CGRect = .zero
    @State private var inspectorFrame: CGRect = .zero
    /// [ipad-chat] Detail width including the inspector column (= nav bar width).
    @State private var barWidth: CGFloat = 0
    /// [leo] 宽度规则只认「稳定下来」的窗口宽度,且不推翻用户刚刚的手动开关。
    @State private var lastHandToggle: Date = .distantPast
    @State private var pendingWidthRule: Task<Void, Never>?

    private var headerBarGeometry: ChatHeaderBarGeometry {
        let width = max(barWidth, contentFrame.width)
        let squeezed = inspectorVisible ? max(0, width - contentFrame.width) : 0
        return ChatHeaderBarGeometry(width: width, coveredTrailing: max(coveredTrailing, squeezed))
    }

    /// In a portrait split view the system floats the inspector OVER the
    /// detail instead of narrowing it, which hid the composer's send button.
    /// Whatever it covers becomes trailing safe area, so the chat lays out
    /// beside it either way (0 when the column squeezes the chat).
    private var coveredTrailing: CGFloat {
        guard inspectorVisible, !usesSheet else { return 0 }
        return LeoWorkspaceLayoutPolicy.coveredTrailing(content: contentFrame, inspector: inspectorFrame)
    }

    /// [leo] 窗口不到 900 pt 时右栏放不下三栏:我们自己用弹出面板展示,不交给 `.inspector` 临场改成
    /// 弹出面板(那时它的几何会让对话忽塌忽回,就是「点一下无限折叠展开」)。≥ 900 才用右栏。
    private var usesSheet: Bool { !LeoWorkspaceLayoutPolicy.canPinContextColumn(width: windowWidth) }

    /// 两种展示共用同一个开关;系统关掉(下滑、空间不够收起)一律照办,不拦。
    private var columnPresented: Binding<Bool> {
        Binding(get: { inspectorVisible && !usesSheet }, set: { shown in
            guard !shown, inspectorVisible else { return }
            inspectorLog.info("[Inspector] system closed column width=\(Int(windowWidth))")
            inspectorVisible = false
        })
    }

    private var sheetPresented: Binding<Bool> {
        Binding(get: { inspectorVisible && usesSheet }, set: { shown in
            guard !shown, inspectorVisible else { return }
            inspectorVisible = false
        })
    }

    /// ⌥⌘I / ⇧⌘M: show the column in that mode, or hide it when it already shows it.
    private func toggleContext(_ mode: ChatContextColumnPolicy.Mode) {
        let current = ChatContextColumnPolicy.effective(contextModeRaw, macFleetEnabled: MacFleetFeature.isEnabled())
        if inspectorVisible && current == mode {
            setInspectorByHand(false)
        } else {
            contextModeRaw = mode.rawValue
            setInspectorByHand(true)
        }
    }

    /// An explicit show/hide of the column. Wide enough to pin → it also pins
    /// or unpins; narrower windows only show it for now.
    private func setInspectorByHand(_ visible: Bool) {
        inspectorLog.info("[Inspector] by hand visible=\(visible) width=\(Int(windowWidth)) sheet=\(usesSheet)")
        lastHandToggle = Date()
        if LeoWorkspaceLayoutPolicy.canPinContextColumn(width: windowWidth) { inspectorPinned = visible }
        withAnimation(LeoMotion.standardEase(reduceMotion: reduceMotion)) { inspectorVisible = visible }
    }

    /// 窗口宽度变了:等它稳定 0.35 秒再按阈值规则开 / 关(展开右栏本身引起的布局抖动不算窗口变宽变窄)。
    private func scheduleWidthRule(_ width: CGFloat) {
        pendingWidthRule?.cancel()
        pendingWidthRule = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled, width == windowWidth else { return }
            applyWidthRule(width)
        }
    }

    private func applyWidthRule(_ width: CGFloat) {
        guard width > 0 else { return }
        let old = CGFloat(contextRuleWidth)
        contextRuleWidth = Double(width)
        // 用户 1.5 秒内刚手动开 / 关过:记下宽度,但不推翻他的选择。
        if Date().timeIntervalSince(lastHandToggle) < LeoWorkspaceLayoutPolicy.handToggleGrace {
            inspectorLog.info("[Inspector] width rule skipped (just toggled by hand) \(Int(old))→\(Int(width))")
            return
        }
        let pinned = inspectorPinned
        guard let show = LeoWorkspaceLayoutPolicy.crossing(
            from: old, to: width,
            rule: { LeoWorkspaceLayoutPolicy.opensContextColumn(width: $0, pinned: pinned) }) else { return }
        inspectorLog.info("[Inspector] width rule visible=\(show) \(Int(old))→\(Int(width))")
        withAnimation(LeoMotion.standardEase(reduceMotion: reduceMotion)) { inspectorVisible = show }
    }

    var body: some View {
        content
            // [F8] The chat's "…" menu opens 用量 / 记忆 here instead of a sheet.
            .environment(\.chatInspectorRoute, ChatInspectorRoute { tab in
                inspectorTab = tab.rawValue
                contextModeRaw = ChatContextColumnPolicy.Mode.details.rawValue
                withAnimation(LeoMotion.standardEase(reduceMotion: reduceMotion)) { inspectorVisible = true }
            })
            .onAppear { applyWidthRule(windowWidth) }
            .onChange(of: windowWidth) { _, width in scheduleWidthRule(width) }
            .onChange(of: contextRequest) { _, request in
                guard let request else { return }
                contextModeRaw = request.mode.rawValue
                withAnimation(LeoMotion.standardEase(reduceMotion: reduceMotion)) { inspectorVisible = true }
            }
            // [ipad-chat] The nav bar spans the chat AND the inspector column
            // (whether the column squeezes the chat or floats over it), and the
            // principal is centered in that whole bar; the chat's title has to
            // know how much of the bar's trailing end is not chat.
            .environment(\.chatHeaderBar, headerBarGeometry)
            .modifier(ChatToolbarMinimization())
            .safeAreaPadding(.trailing, coveredTrailing)
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { contentFrame = $0 }
            .inspector(isPresented: columnPresented) {
                ChatInspectorPanel(sessionId: sessionId, modeRaw: $contextModeRaw)
                    .inspectorColumnWidth(min: 300, ideal: 360, max: 480)
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { inspectorFrame = $0 }
                    .onDisappear { inspectorFrame = .zero }
            }
            .sheet(isPresented: sheetPresented) {
                NavigationStack {
                    ChatInspectorPanel(sessionId: sessionId, modeRaw: $contextModeRaw)
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button("完成") { setInspectorByHand(false) }
                            }
                        }
                }
                .presentationDetents([.medium, .large])
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { barWidth = $0 }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        setInspectorByHand(!inspectorVisible)
                    } label: {
                        Image(systemName: "sidebar.right")
                    }
                    .help("文件/工具详情 ⌥⌘I")
                    .accessibilityLabel(inspectorVisible ? "隐藏右栏" : "显示右栏")
                }
            }
            // ⌘. and ⌥⌘I act on the chat in the window you're using.
            .focusedSceneValue(\.chatWindow, ChatWindowTarget(sessionId: sessionId, inspectorVisible: $inspectorVisible,
                                                               toggleContext: { toggleContext($0) }))
    }
}

/// [F8] How the chat reaches the inspector beside it. Only set inside
/// ChatDetailContainer (iPad split); nil on iPhone, where the same views
/// stay sheets.
struct ChatInspectorRoute {
    let open: @MainActor (ChatInspectorPanel.Tab) -> Void
}

extension EnvironmentValues {
    @Entry var chatInspectorRoute: ChatInspectorRoute? = nil
    @Entry var chatHeaderBar = ChatHeaderBarGeometry()
}

/// [ipad-chat] Width of the navigation bar above the chat and how much of its
/// trailing end the inspector covers. Zero outside ChatDetailContainer.
struct ChatHeaderBarGeometry: Equatable {
    var width: CGFloat = 0
    var coveredTrailing: CGFloat = 0
}

/// [F8] Three fixed tabs: the tool timeline (every tool call, live), usage
/// (model, context, tokens, what feeds the session) and memory hits.
/// Artifacts and files stay in the chat's "…" menu.
struct ChatInspectorPanel: View {
    let sessionId: String?
    /// [WP-43] 文件/工具详情 or Mac 画面 (the container's per-window choice).
    @Binding var modeRaw: String
    @AppStorage("leo.ipad.inspectorTab") private var tabRaw = Tab.run.rawValue
    @AppStorage(MacFleetFeature.defaultsKey) private var macFleetEnabled = false
    /// Prior #2: a Face ID-locked chat shows nothing here until unlocked.
    @ObservedObject private var lockStore = SessionLockStore.shared

    private var isLocked: Bool {
        guard let sessionId, !sessionId.isEmpty else { return false }
        return lockStore.isVisuallyLocked(sessionId)
    }

    enum Tab: String, CaseIterable, Identifiable {
        case run, files, usage, memory
        var id: String { rawValue }
        var title: String {
            switch self {
            case .run: AppLocalized("工具")
            case .files: AppLocalized("文件")
            case .usage: AppLocalized("用量")
            case .memory: AppLocalized("记忆命中")
            }
        }
    }

    private var tab: Binding<Tab> {
        Binding(get: { Tab(rawValue: ChatInspectorTabPolicy.resolve(tabRaw)) ?? .run },
                set: { tabRaw = $0.rawValue })
    }

    private var vm: AIChatViewModel? {
        sessionId.flatMap { ViewModelCache.shared.get(for: $0) }
    }

    var body: some View {
        if isLocked {
            LeoEmptyState(systemImage: "lock.fill", title: "这段对话已上锁",
                          message: "在对话里解锁后，这里才会显示它的工具、用量和记忆。")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            panel
        }
    }

    private var mode: Binding<ChatContextColumnPolicy.Mode> {
        Binding(get: { ChatContextColumnPolicy.effective(modeRaw, macFleetEnabled: macFleetEnabled) },
                set: { modeRaw = $0.rawValue })
    }

    private var panel: some View {
        VStack(spacing: 0) {
            if macFleetEnabled {
                Picker("右栏", selection: mode) {
                    ForEach(ChatContextColumnPolicy.Mode.allCases, id: \.self) { Text(AppLocalized(String.LocalizationValue($0.title))).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .padding(.horizontal, 12)
                .padding(.top, 8)
            }
            switch mode.wrappedValue {
            case .details: detailsPanel
            case .macScreen: macScreenPanel
            }
        }
        .animation(LeoMotion.standardEase(reduceMotion: UIAccessibility.isReduceMotionEnabled), value: mode.wrappedValue)
    }

    /// [WP-50 R0] The Mac's screen (polled snapshots while this column is on screen).
    private var macScreenPanel: some View {
        MacScreenColumn()
    }

    private var detailsPanel: some View {
        VStack(spacing: 0) {
            Picker("检查器", selection: tab) {
                ForEach(Tab.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            Divider()
            Group {
                switch tab.wrappedValue {
                case .run:
                    if let vm { InspectorRunList(vm: vm) } else { draftPlaceholder }
                case .files:
                    if let sessionId, !sessionId.isEmpty {
                        ArtifactTrayView(sessionId: sessionId, embedded: true)
                    } else { draftPlaceholder }
                case .usage:
                    if let vm { SessionInspectorView(vm: vm, embedded: true) } else { draftPlaceholder }
                case .memory:
                    if let vm { SessionMemoryView(vm: vm, embedded: true) } else { draftPlaceholder }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var draftPlaceholder: some View {
        LeoEmptyState(systemImage: "sparkles", title: "还没有开始",
                      message: "发出第一条消息后，这里会列出 Agent 的每一步、用量和用到的记忆。")
    }
}

/// Every tool call of the session, newest first, updating live. Tapping one
/// opens the same live view the chat's tool capsule opens.
private struct InspectorRunList: View {
    @ObservedObject var vm: AIChatViewModel
    @State private var selection: InspectorSelection?

    private struct InspectorSelection: Identifiable {
        let index: Int
        var id: Int { index }
    }

    private var toolBlocks: [AssistantBlock] {
        vm.messages
            .filter { $0.role == .assistant && !$0.isCompactedHistory }
            .flatMap { $0.blocks.filter { $0.toolStatus != nil } }
    }

    var body: some View {
        let blocks = toolBlocks
        if blocks.isEmpty {
            LeoEmptyState(systemImage: "wrench.and.screwdriver", title: "还没有工具调用",
                          message: "Agent 用到终端、文件、浏览器时，每一步都会列在这里。")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            List {
                Section {
                    InspectorRunSummary(blocks: blocks, isProcessing: vm.isProcessing)
                }
                Section("步骤") {
                    ForEach(Array(blocks.enumerated().reversed()), id: \.element.id) { index, block in
                        Button { selection = InspectorSelection(index: index) } label: {
                            InspectorToolRow(block: block)
                        }
                        .buttonStyle(.plain)
                        .hoverEffect(.highlight)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .sheet(item: $selection) { item in
                ToolLiveSheet(toolBlocks: blocks, initialIdx: item.index,
                              toolSnapshots: vm.toolSnapshots, browserPool: vm.browserTabPool)
                    .environment(\.chatSessionId, vm.sessionId)
                    .modifier(TrailingSheetPlacement())
            }
        }
    }
}

private struct InspectorRunSummary: View {
    let blocks: [AssistantBlock]
    let isProcessing: Bool

    var body: some View {
        let running = blocks.filter { if case .running = $0.toolStatus { return true }; if case .streaming = $0.toolStatus { return true }; return false }.count
        let failed = blocks.filter { if case .failed = $0.toolStatus { return true }; return false }.count
        let total = blocks.compactMap(\.toolDuration).reduce(0, +)
        HStack(spacing: 16) {
            metric("\(blocks.count)", "步")
            metric(running > 0 ? "\(running)" : "0", "进行中", tint: running > 0 ? .orange : .secondary)
            metric("\(failed)", "失败", tint: failed > 0 ? .red : .secondary)
            metric(LeoDuration.short(total), "工具用时")
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 4)
    }

    private func metric(_ value: String, _ label: String, tint: Color = .primary) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.title3.weight(.semibold).monospacedDigit())
                .foregroundStyle(tint)
                .contentTransition(.numericText())
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}

private struct InspectorToolRow: View {
    @ObservedObject var block: AssistantBlock

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: block.kind.inspectorSymbol)
                .font(.body)
                .foregroundStyle(.secondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(block.toolSummary ?? block.toolDescription)
                    .font(.subheadline)
                    .lineLimit(2)
                if !(block.toolSummary ?? "").isEmpty, !block.toolDescription.isEmpty {
                    Text(block.toolDescription)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: 8)
            statusBadge
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var statusBadge: some View {
        switch block.toolStatus {
        case .streaming, .running:
            ProgressView().controlSize(.small)
        case .success:
            Text(LeoDuration.short(block.toolDuration ?? 0))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                .accessibilityLabel("失败")
        case .cancelled:
            Image(systemName: "stop.circle").foregroundStyle(.secondary)
                .accessibilityLabel("已停止")
        case nil:
            EmptyView()
        }
    }
}

private extension AssistantBlockKind {
    var inspectorSymbol: String {
        switch self {
        case .shellTool: "terminal"
        case .fileReadTool: "doc.text"
        case .fileWriteTool: "doc.text.fill"
        case .fileEditTool: "square.and.pencil"
        case .browserTool: "globe"
        case .readImageTool: "photo"
        case .memoryTool: "brain.head.profile"
        case .delegateTool: "person.2.fill"
        case .info: "arrow.triangle.2.circlepath"
        case .text: "text.alignleft"
        case .thinking: "lightbulb"
        }
    }
}

/// "0.4 秒", "12 秒", "1 分 12 秒" — tabular-friendly short durations.
enum LeoDuration {
    static func short(_ seconds: TimeInterval) -> String {
        guard seconds > 0 else { return "—" }
        if seconds < 10 { return String(format: AppLocalized("%.1f 秒"), seconds) }
        let total = Int(seconds.rounded())
        if total < 60 { return AppLocalized("\(total) 秒") }
        let minutes = total / 60
        let rest = total % 60
        return rest == 0 ? AppLocalized("\(minutes) 分") : AppLocalized("\(minutes) 分 \(rest) 秒")
    }
}

/// Keep the chat's back button and actions available even during scrolling.
/// Lives on the small wrappers, outside AIChatView's deep modifier chain.
struct ChatToolbarMinimization: ViewModifier {
    func body(content: Content) -> some View {
        content.toolbarMinimizationBehavior(.never, for: .navigationBar)
    }
}

/// iPadOS 27: a tool's detail docks at the trailing edge, over the inspector
/// it was opened from, instead of covering the conversation.
struct TrailingSheetPlacement: ViewModifier {
    func body(content: Content) -> some View {
        content.presentationPlacement(.trailing)
    }
}

/// iOS 27: dismissing a sheet that still holds unsent text asks first
/// (the swipe-down gesture included); nothing changes on iOS 26.
struct UnsentDraftDismissConfirmation: ViewModifier {
    let hasDraft: Bool

    func body(content: Content) -> some View {
        content.dismissalConfirmationDialog("放弃还没发送的内容？", shouldPresent: hasDraft) {
            // The system finishes the dismissal after the action runs.
            Button("放弃", role: .destructive) { LeoHaptics.impact(.light) }
        }
    }
}
