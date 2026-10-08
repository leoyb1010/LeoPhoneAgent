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

/// Wraps the chat in the iPad detail column and owns the inspector column.
struct ChatDetailContainer<Content: View>: View {
    let sessionId: String?
    @ViewBuilder let content: Content

    /// Per window: two windows side by side each keep their own.
    @SceneStorage("leo.ipad.inspectorVisible") private var inspectorVisible = false
    /// [F8] Shared with ChatInspectorPanel so the chat's "…" menu can open a tab.
    @AppStorage("leo.ipad.inspectorTab") private var inspectorTab = ChatInspectorPanel.Tab.run.rawValue
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var contentFrame: CGRect = .zero
    @State private var inspectorFrame: CGRect = .zero

    /// In a portrait split view the system floats the inspector OVER the
    /// detail instead of narrowing it, which hid the composer's send button.
    /// Whatever it covers becomes trailing safe area, so the chat lays out
    /// beside it either way (0 when the column squeezes the chat).
    private var coveredTrailing: CGFloat {
        guard inspectorVisible, inspectorFrame.width > 0 else { return 0 }
        return max(0, contentFrame.maxX - inspectorFrame.minX)
    }

    var body: some View {
        content
            // [F8] The chat's "…" menu opens 用量 / 记忆 here instead of a sheet.
            .environment(\.chatInspectorRoute, ChatInspectorRoute { tab in
                inspectorTab = tab.rawValue
                withAnimation(LeoMotion.standardEase(reduceMotion: reduceMotion)) { inspectorVisible = true }
            })
            .modifier(ChatToolbarMinimization())
            .safeAreaPadding(.trailing, coveredTrailing)
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { contentFrame = $0 }
            .inspector(isPresented: $inspectorVisible) {
                ChatInspectorPanel(sessionId: sessionId)
                    .inspectorColumnWidth(min: 300, ideal: 360, max: 480)
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { inspectorFrame = $0 }
                    .onDisappear { inspectorFrame = .zero }
            }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        withAnimation(LeoMotion.standardEase(reduceMotion: reduceMotion)) { inspectorVisible.toggle() }
                    } label: {
                        Image(systemName: "sidebar.right")
                    }
                    .help("检查器 ⌥⌘I")
                    .accessibilityLabel(inspectorVisible ? "隐藏检查器" : "显示检查器")
                }
            }
            // ⌘. and ⌥⌘I act on the chat in the window you're using.
            .focusedSceneValue(\.chatWindow, ChatWindowTarget(sessionId: sessionId, inspectorVisible: $inspectorVisible))
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
}

/// [F8] Three fixed tabs: the tool timeline (every tool call, live), usage
/// (model, context, tokens, what feeds the session) and memory hits.
/// Artifacts and files stay in the chat's "…" menu.
struct ChatInspectorPanel: View {
    let sessionId: String?
    @AppStorage("leo.ipad.inspectorTab") private var tabRaw = Tab.run.rawValue
    /// Prior #2: a Face ID-locked chat shows nothing here until unlocked.
    @ObservedObject private var lockStore = SessionLockStore.shared

    private var isLocked: Bool {
        guard let sessionId, !sessionId.isEmpty else { return false }
        return lockStore.isVisuallyLocked(sessionId)
    }

    enum Tab: String, CaseIterable, Identifiable {
        case run, usage, memory
        var id: String { rawValue }
        var title: String {
            switch self {
            case .run: String(localized: "工具时间线")
            case .usage: String(localized: "用量")
            case .memory: String(localized: "记忆命中")
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

    private var panel: some View {
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
        if seconds < 10 { return String(format: String(localized: "%.1f 秒"), seconds) }
        let total = Int(seconds.rounded())
        if total < 60 { return String(localized: "\(total) 秒") }
        let minutes = total / 60
        let rest = total % 60
        return rest == 0 ? String(localized: "\(minutes) 分") : String(localized: "\(minutes) 分 \(rest) 秒")
    }
}

/// Keep the chat's back button and actions available even during scrolling.
/// Lives on the small wrappers, outside AIChatView's deep modifier chain.
struct ChatToolbarMinimization: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 27, *) {
            content.toolbarMinimizationBehavior(.never, for: .navigationBar)
        } else {
            content
        }
    }
}

/// iPadOS 27: a tool's detail docks at the trailing edge, over the inspector
/// it was opened from, instead of covering the conversation.
struct TrailingSheetPlacement: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 27, *) {
            content.presentationPlacement(.trailing)
        } else {
            content
        }
    }
}

/// iOS 27: dismissing a sheet that still holds unsent text asks first
/// (the swipe-down gesture included); nothing changes on iOS 26.
struct UnsentDraftDismissConfirmation: ViewModifier {
    let hasDraft: Bool

    func body(content: Content) -> some View {
        if #available(iOS 27, *) {
            content.dismissalConfirmationDialog("放弃还没发送的内容？", shouldPresent: hasDraft) {
                // The system finishes the dismissal after the action runs.
                Button("放弃", role: .destructive) { LeoHaptics.impact(.light) }
            }
        } else {
            content
        }
    }
}
