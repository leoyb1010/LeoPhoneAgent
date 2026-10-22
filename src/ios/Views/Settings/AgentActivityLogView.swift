import SwiftUI
import UIKit

/// Human-readable execution history for the owner of this device.
/// The underlying log intentionally contains metadata only.
struct AgentActivityLogView: View {
    @ObservedObject private var log = AgentActivityLog.shared
    @Environment(\.dismiss) private var dismiss
    @State private var events: [AgentActivityEvent] = []
    @State private var usage: (count: Int, capacity: Int) = (0, 5000)
    @State private var showClearConfirmation = false
    let sessionId: String?
    let showsPrivacyHeader: Bool
    let canResume: Bool
    let recoveryAction: AgentRecoveryAction?
    let onRecovery: (() -> Void)?

    init(
        sessionId: String? = nil,
        showsPrivacyHeader: Bool = true,
        canResume: Bool = false,
        recoveryAction: AgentRecoveryAction? = nil,
        onRecovery: (() -> Void)? = nil
    ) {
        self.sessionId = sessionId
        self.showsPrivacyHeader = showsPrivacyHeader
        self.canResume = canResume
        self.recoveryAction = recoveryAction
        self.onRecovery = onRecovery
    }

    var body: some View {
        List {
            if showsPrivacyHeader {
                Section {
                    HStack {
                        Label("Device only", systemImage: "iphone")
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text("\(usage.count) / \(usage.capacity)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    if !events.isEmpty {
                        Button("Clear Activity", role: .destructive) {
                            showClearConfirmation = true
                        }
                        // [ipad-anchors] 挂在按钮上:iPad 上确认框从这个按钮弹出,不再从右栏左边缘冒出来盖住设置侧栏。
                        .confirmationDialog(
                            "Clear device activity?",
                            isPresented: $showClearConfirmation,
                            titleVisibility: .visible
                        ) {
                            Button("Clear Activity", role: .destructive) {
                                AgentActivityLog.shared.clearAll()
                                reload()
                            }
                            Button("Cancel", role: .cancel) {}
                        } message: {
                            Text("This removes the local execution history. Conversations are not affected.")
                        }
                    }
                } footer: {
                    Text("Stores run phase, time and tool name on this device. Prompts, tool inputs and outputs are never included or synced to iCloud.")
                }
            }

            if canResume {
                Section {
                    Label("This run can be resumed", systemImage: "arrow.clockwise.circle.fill")
                        .foregroundStyle(LeoTheme.ColorToken.warning)
                } footer: {
                    Text("Close Activity and use Resume in the conversation to continue from the saved interruption point.")
                }
            }

            if let recoveryAction, let onRecovery {
                Section {
                    Button {
                        LeoHaptics.impact(.medium)
                        dismiss()
                        // "Check the provider" presents Settings; asked for while this
                        // sheet is still closing, it never appears.
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { onRecovery() }
                    } label: {
                        Label(recoveryTitle(recoveryAction), systemImage: recoverySymbol(recoveryAction))
                            .font(.body.weight(.semibold))
                    }
                } footer: {
                    Text(recoveryDescription(recoveryAction))
                }
            }

            if events.isEmpty {
                LeoEmptyState(systemImage: "waveform.path.ecg",
                              title: AppLocalized("No Activity Yet"),
                              message: AppLocalized("New agent runs will appear here."))
            } else {
                Section("Recent Events") {
                    ForEach(events) { event in
                        eventRow(event)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .onAppear(perform: reload)
        .onChange(of: log.revision) { _ in reload() }
    }

    private func reload() {
        events = AgentActivityLog.shared.recent(limit: 300, sessionId: sessionId)
        usage = AgentActivityLog.shared.usage()
    }

    private func eventRow(_ event: AgentActivityEvent) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol(for: event))
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(color(for: event.phase))
                .frame(width: 28, height: 28)
                .background(color(for: event.phase).opacity(0.12), in: Circle())
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                Text(title(for: event))
                    .font(.subheadline.weight(.medium))
                HStack(spacing: 6) {
                    Text(event.sessionId.hasPrefix("__new__") ? AppLocalized("新对话") : String(event.sessionId.prefix(8)))
                    Text("•")
                    Text(event.at, style: .relative)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                if let reason = event.reason {
                    Text(reasonDescription(reason))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText(for: event))
    }

    private func accessibilityText(for event: AgentActivityEvent) -> String {
        let timestamp = event.at.formatted(date: .abbreviated, time: .shortened)
        if let reason = event.reason {
            return "\(title(for: event)), \(reasonDescription(reason)), \(timestamp)"
        }
        return "\(title(for: event)), \(timestamp)"
    }

    private func title(for event: AgentActivityEvent) -> String {
        if let toolName = event.toolName {
            return AgentToolPresentation.displayName(for: toolName)
        }
        return event.phase.activityTitle
    }

    private func symbol(for event: AgentActivityEvent) -> String {
        if let toolName = event.toolName {
            return AgentToolPresentation.symbol(for: toolName)
        }
        return switch event.phase {
        case .idle: "circle"
        case .preparing: "sparkles"
        case .thinking: "lightbulb.max"
        case .usingTool: "wrench.and.screwdriver"
        case .waitingForPermission: "lock.shield"
        case .waitingForUser: "pause.fill"
        case .suspended: "hourglass"
        case .completed: "checkmark"
        case .failed: "exclamationmark"
        case .cancelled: "xmark"
        case .unverified: "questionmark"
        }
    }

    private func color(for phase: AgentActivityPhase) -> Color {
        return switch phase {
        case .completed: .green
        case .failed: .red
        case .cancelled, .unverified: .secondary
        case .waitingForPermission, .waitingForUser, .suspended: .orange
        case .idle: .secondary
        case .preparing, .thinking, .usingTool: LeoTheme.ColorToken.accent
        }
    }

    private func reasonDescription(_ reason: AgentActivityReason) -> String {
        reason.activityDescription
    }

    private func recoveryTitle(_ action: AgentRecoveryAction) -> String {
        switch action {
        case .retry: AppLocalized("Retry from Last Safe Step")
        case .resume: AppLocalized("Resume Task")
        case .reviewProvider: AppLocalized("Review Provider Settings")
        case .retryKernel: AppLocalized("Retry Local Environment")
        }
    }

    private func recoverySymbol(_ action: AgentRecoveryAction) -> String {
        switch action {
        case .retry: "arrow.clockwise"
        case .resume: "play.fill"
        case .reviewProvider: "key.horizontal"
        case .retryKernel: "terminal.fill"
        }
    }

    private func recoveryDescription(_ action: AgentRecoveryAction) -> String {
        switch action {
        case .retry: AppLocalized("Keeps completed steps and retries from the last safe conversation state.")
        case .resume: AppLocalized("Continues from the interruption point already saved in this conversation.")
        case .reviewProvider: AppLocalized("Check the selected provider, credentials and model before retrying.")
        case .retryKernel: AppLocalized("Attempts to start the on-device Linux environment again.")
        }
    }
}

/// Compact, session-scoped status surface mounted above the chat composer.
/// It stays in the hierarchy while hidden so an open timeline is not dismissed
/// when the run reaches a terminal state in the background.
struct AgentCurrentStatusCard: View {
    @ObservedObject private var tracker = SessionActivityTracker.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dismiss) private var dismiss

    let sessionId: String?
    let isProcessing: Bool
    let isSuspended: Bool
    let canResume: Bool
    let failureReason: AgentActivityReason?
    let onRetry: () -> Void
    let onResume: () -> Void
    let onReviewProvider: () -> Void
    let onRetryKernel: () -> Void
    /// [chat-chrome] Shares the line with the tool strip: title only, no subtitle.
    var compact = false

    @State private var showTimeline = false

    private var resolvedSessionId: String? {
        guard let sessionId else { return nil }
        return tracker.draftAliases[sessionId] ?? sessionId
    }

    private var toolName: String? {
        guard let resolvedSessionId else { return nil }
        let name = tracker.sessionToolInfo[resolvedSessionId]?.toolName ?? ""
        return name.isEmpty ? nil : name
    }

    private var derivedSnapshot: AgentActivitySnapshot {
        AgentActivitySnapshot(
            isProcessing: isProcessing,
            isSuspended: isSuspended,
            canResume: canResume,
            toolName: toolName
        )
    }

    private var phase: AgentActivityPhase {
        if failureReason != nil { return .failed }
        if canResume { return .waitingForUser }
        if let resolvedSessionId,
           let tracked = tracker.sessionActivityPhases[resolvedSessionId],
           !tracked.isTerminal {
            return tracked
        }
        return derivedSnapshot.phase
    }

    private var reason: AgentActivityReason? {
        if let failureReason { return failureReason }
        guard let resolvedSessionId else { return nil }
        return tracker.sessionActivityReasons[resolvedSessionId]
    }

    private var isVisible: Bool {
        isProcessing || isSuspended || canResume || failureReason != nil
    }

    /// [B3] 正在自动重试打开模型流:第几次;恢复后为 nil,卡片回到原状态。
    private var reconnectAttempt: Int? {
        guard isProcessing, let resolvedSessionId else { return nil }
        return tracker.reconnectAttempts[resolvedSessionId]
    }

    var body: some View {
        Group {
            if isVisible {
                Button {
                    LeoHaptics.selection()
                    showTimeline = true
                } label: {
                    // [chat-chrome] One 36pt line (was a two-line 44pt+ card with
                    // its own outer padding): icon · title · subtitle · chevron.
                    // The subtitle gives way first; in `compact` it is omitted so
                    // the tool strip beside it keeps its room.
                    HStack(spacing: 6) {
                        Image(systemName: symbol)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(tint)
                            .frame(width: 22, height: 22)
                            .background(tint.opacity(0.12), in: Circle())
                            .accessibilityHidden(true)

                        LeoWidthCap(cap: compact ? 150 : .greatestFiniteMagnitude) {
                            Text(title)
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(LeoTheme.ColorToken.primaryText)
                                .lineLimit(1)
                        }
                        .layoutPriority(1)

                        if !compact {
                            Text(subtitle)
                                .font(.caption)
                                .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                                .lineLimit(1)
                        }

                        if !compact { Spacer(minLength: 0) }

                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(LeoTheme.ColorToken.tertiaryText)
                            .accessibilityHidden(true)
                    }
                    .padding(.leading, 7)
                    .padding(.trailing, 10)
                    .frame(maxWidth: compact ? nil : .infinity, minHeight: LeoChromeMetrics.activityRowHeight,
                           alignment: .leading)
                    .background(LeoTheme.ColorToken.surface, in: RoundedRectangle(cornerRadius: LeoTheme.Radius.field, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: LeoTheme.Radius.field, style: .continuous)
                            .stroke(tint.opacity(0.18), lineWidth: 1)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(title). \(subtitle)")
                .accessibilityHint("Shows this conversation's activity timeline")
                .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(LeoMotion.standardEase(reduceMotion: reduceMotion), value: isVisible)
        .onChange(of: phase) { newPhase in
            announceImportantPhase(newPhase)
        }
        .sheet(isPresented: $showTimeline) {
            NavigationStack {
                AgentActivityLogView(
                    sessionId: resolvedSessionId,
                    showsPrivacyHeader: false,
                    canResume: canResume,
                    recoveryAction: recoveryAction,
                    onRecovery: performRecovery
                )
                .navigationTitle("Activity")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { showTimeline = false }
                    }
                }
            }
            .presentationDetents([.medium, .large])
        }
    }

    private func announceImportantPhase(_ phase: AgentActivityPhase) {
        guard UIAccessibility.isVoiceOverRunning else { return }
        let message: String
        switch phase {
        case .waitingForPermission, .waitingForUser, .suspended, .completed, .failed, .cancelled, .unverified:
            message = "\(title). \(subtitle)"
        case .idle, .preparing, .thinking, .usingTool:
            return
        }
        UIAccessibility.post(notification: .announcement, argument: message)
    }

    private var recoveryAction: AgentRecoveryAction? {
        if canResume { return .resume }
        guard let failureReason else { return nil }
        return AgentActivityFailureClassifier.recoveryAction(for: failureReason)
    }

    private func performRecovery() {
        guard let recoveryAction else { return }
        switch recoveryAction {
        case .retry: onRetry()
        case .resume: onResume()
        case .reviewProvider: onReviewProvider()
        case .retryKernel: onRetryKernel()
        }
    }

    private var title: String {
        if let reconnectAttempt { return LLMRetryPolicy.reconnectingLabel(attempt: reconnectAttempt) }
        if let toolName, phase == .usingTool {
            return AgentToolPresentation.displayName(for: toolName)
        }
        // [T-ask-user] Waiting for the answer to a question, not for a Resume tap.
        if phase == .waitingForUser, reason == .userQuestion { return AppLocalized("等你回答") }
        return switch phase {
        case .waitingForUser: AppLocalized("Ready to Resume")
        case .suspended: AppLocalized("Waiting for a Slot")
        case .thinking: AppLocalized("Thinking…")
        case .preparing: AppLocalized("Preparing")
        case .usingTool: AppLocalized("Using a Tool")
        case .waitingForPermission: AppLocalized("Permission Required")
        case .completed: AppLocalized("Completed")
        case .failed: AppLocalized("Run failed")
        case .cancelled: AppLocalized("Cancelled")
        case .unverified: AppLocalized("Result unverified")
        case .idle: AppLocalized("Idle")
        }
    }

    private var subtitle: String {
        if reconnectAttempt != nil { return AppLocalized("连接中断，正在自动重试；恢复后接着做") }
        if let reason {
            return switch reason {
            case .permissionApproval: AppLocalized("Review the device capability request")
            case .autoApproved: AppLocalized("Approved automatically (full auto), no prompt shown")
            case .browserTakeover: AppLocalized("Finish browsing to return control")
            case .backgroundTimeExpired: AppLocalized("Return to LeoBot to continue")
            case .unexpectedTermination: AppLocalized("The saved interruption point can be resumed")
            case .concurrencyLimit: AppLocalized("Queued behind another task")
            case .userInterruption: AppLocalized("The interruption point was saved")
            case .responseLimit: AppLocalized("Resume to continue the response")
            case .connectionDropped: AppLocalized("Resume when the connection is stable")
            case .toolFailure: AppLocalized("Review the failed tool step")
            case .providerFailure: AppLocalized("Review the provider error")
            case .authenticationRequired: AppLocalized("Check the selected provider credentials")
            case .rateLimited: AppLocalized("Wait briefly, then retry from the last safe step")
            case .kernelUnavailable: AppLocalized("Restart the local execution environment")
            case .userQuestion: AppLocalized("回答问题后接着做")
            }
        }
        return switch phase {
        case .waitingForUser: AppLocalized("The interruption point was saved")
        case .suspended: AppLocalized("Queued behind another task")
        case .thinking, .preparing, .usingTool: AppLocalized("View current agent activity")
        case .waitingForPermission: AppLocalized("Review the pending request")
        case .completed: AppLocalized("The run finished")
        case .failed: AppLocalized("The run needs attention")
        case .cancelled: AppLocalized("The run was stopped")
        case .unverified: AppLocalized("Check the result before trying the action again")
        case .idle: AppLocalized("No active run")
        }
    }

    private var symbol: String {
        if reconnectAttempt != nil { return "arrow.triangle.2.circlepath" }
        if let toolName, phase == .usingTool {
            return AgentToolPresentation.symbol(for: toolName)
        }
        return switch phase {
        case .waitingForUser: "arrow.clockwise"
        case .suspended: "hourglass"
        case .thinking: "lightbulb.max"
        case .preparing: "sparkles"
        case .usingTool: "wrench.and.screwdriver"
        case .waitingForPermission: "lock.shield"
        case .completed: "checkmark"
        case .failed: "exclamationmark"
        case .cancelled: "xmark"
        case .unverified: "questionmark"
        case .idle: "circle"
        }
    }

    private var tint: Color {
        if reconnectAttempt != nil { return LeoTheme.ColorToken.warning }
        return switch phase {
        case .waitingForUser, .suspended, .waitingForPermission: LeoTheme.ColorToken.warning
        case .failed: LeoTheme.ColorToken.destructive
        case .completed: LeoTheme.ColorToken.success
        case .cancelled, .idle, .unverified: LeoTheme.ColorToken.secondaryText
        case .preparing, .thinking, .usingTool: LeoTheme.ColorToken.accent
        }
    }
}

// 活动记录、Agent 时间线共用的阶段名 / 原因说明(以前一边是英文原文,一边直接显示枚举原始值)。
extension AgentActivityPhase {
    var activityTitle: String {
        switch self {
        case .idle: AppLocalized("Idle")
        case .preparing: AppLocalized("Preparing")
        case .thinking: AppLocalized("Thinking…")
        case .usingTool: AppLocalized("Using a tool")
        case .waitingForPermission: AppLocalized("Waiting for permission")
        case .waitingForUser: AppLocalized("Paused, ready to resume")
        case .suspended: AppLocalized("Waiting for an execution slot")
        case .completed: AppLocalized("Completed")
        case .failed: AppLocalized("Run failed")
        case .cancelled: AppLocalized("Cancelled")
        case .unverified: AppLocalized("Result unverified")
        }
    }
}

extension AgentActivityReason {
    var activityDescription: String {
        switch self {
        case .permissionApproval: AppLocalized("Waiting for device permission approval")
        case .autoApproved: AppLocalized("Auto-approved (full auto)")
        case .browserTakeover: AppLocalized("Waiting for browser control to return")
        case .backgroundTimeExpired: AppLocalized("Paused after iOS background time expired")
        case .unexpectedTermination: AppLocalized("Recovered after LeoBot stopped unexpectedly")
        case .concurrencyLimit: AppLocalized("Waiting for an execution slot")
        case .userInterruption: AppLocalized("Paused by the user")
        case .responseLimit: AppLocalized("The response reached its token limit")
        case .connectionDropped: AppLocalized("The provider connection ended early")
        case .toolFailure: AppLocalized("A tool step failed")
        case .providerFailure: AppLocalized("The model provider request failed")
        case .authenticationRequired: AppLocalized("Provider authentication needs attention")
        case .rateLimited: AppLocalized("The provider rate limit was reached")
        case .kernelUnavailable: AppLocalized("The local execution environment is unavailable")
        case .userQuestion: AppLocalized("等你回答一个问题")
        }
    }
}
