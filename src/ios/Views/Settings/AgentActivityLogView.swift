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
                        onRecovery()
                    } label: {
                        Label(recoveryTitle(recoveryAction), systemImage: recoverySymbol(recoveryAction))
                            .font(.body.weight(.semibold))
                    }
                } footer: {
                    Text(recoveryDescription(recoveryAction))
                }
            }

            if events.isEmpty {
                VStack(spacing: LeoTheme.Spacing.xs) {
                    Image(systemName: "waveform.path.ecg")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                    Text("No Activity Yet")
                        .font(.headline)
                    Text("New agent runs will appear here.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, LeoTheme.Spacing.xl)
                .listRowBackground(Color.clear)
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
                    Text(event.sessionId.hasPrefix("__new__") ? "New session" : String(event.sessionId.prefix(8)))
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
        case .retry: String(localized: "Retry from Last Safe Step")
        case .resume: String(localized: "Resume Task")
        case .reviewProvider: String(localized: "Review Provider Settings")
        case .retryKernel: String(localized: "Retry Local Environment")
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
        case .retry: String(localized: "Keeps completed steps and retries from the last safe conversation state.")
        case .resume: String(localized: "Continues from the interruption point already saved in this conversation.")
        case .reviewProvider: String(localized: "Check the selected provider, credentials and model before retrying.")
        case .retryKernel: String(localized: "Attempts to start the on-device Linux environment again.")
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

    var body: some View {
        Group {
            if isVisible {
                Button {
                    LeoHaptics.selection()
                    showTimeline = true
                } label: {
                    HStack(spacing: LeoTheme.Spacing.sm) {
                        Image(systemName: symbol)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(tint)
                            .frame(width: 30, height: 30)
                            .background(tint.opacity(0.12), in: Circle())
                            .accessibilityHidden(true)

                        VStack(alignment: .leading, spacing: 2) {
                            Text(title)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(LeoTheme.ColorToken.primaryText)
                            Text(subtitle)
                                .font(.caption)
                                .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                                .lineLimit(1)
                        }

                        Spacer(minLength: LeoTheme.Spacing.xs)

                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(LeoTheme.ColorToken.tertiaryText)
                            .accessibilityHidden(true)
                    }
                    .padding(.horizontal, LeoTheme.Spacing.sm)
                    .frame(minHeight: LeoTheme.TouchTarget.minimum)
                    .background(LeoTheme.ColorToken.surface, in: RoundedRectangle(cornerRadius: LeoTheme.Radius.field, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: LeoTheme.Radius.field, style: .continuous)
                            .stroke(tint.opacity(0.18), lineWidth: 1)
                    }
                    .padding(.horizontal, LeoTheme.Spacing.sm)
                    .padding(.bottom, LeoTheme.Spacing.xs)
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
        if let toolName, phase == .usingTool {
            return AgentToolPresentation.displayName(for: toolName)
        }
        return switch phase {
        case .waitingForUser: String(localized: "Ready to Resume")
        case .suspended: String(localized: "Waiting for a Slot")
        case .thinking: String(localized: "Thinking…")
        case .preparing: String(localized: "Preparing")
        case .usingTool: String(localized: "Using a Tool")
        case .waitingForPermission: String(localized: "Permission Required")
        case .completed: String(localized: "Completed")
        case .failed: String(localized: "Run failed")
        case .cancelled: String(localized: "Cancelled")
        case .unverified: String(localized: "Result unverified")
        case .idle: String(localized: "Idle")
        }
    }

    private var subtitle: String {
        if let reason {
            return switch reason {
            case .permissionApproval: String(localized: "Review the device capability request")
            case .autoApproved: String(localized: "Approved automatically (full auto), no prompt shown")
            case .browserTakeover: String(localized: "Finish browsing to return control")
            case .backgroundTimeExpired: String(localized: "Return to LeoPhoneAgent to continue")
            case .unexpectedTermination: String(localized: "The saved interruption point can be resumed")
            case .concurrencyLimit: String(localized: "Queued behind another task")
            case .userInterruption: String(localized: "The interruption point was saved")
            case .responseLimit: String(localized: "Resume to continue the response")
            case .connectionDropped: String(localized: "Resume when the connection is stable")
            case .toolFailure: String(localized: "Review the failed tool step")
            case .providerFailure: String(localized: "Review the provider error")
            case .authenticationRequired: String(localized: "Check the selected provider credentials")
            case .rateLimited: String(localized: "Wait briefly, then retry from the last safe step")
            case .kernelUnavailable: String(localized: "Restart the local execution environment")
            }
        }
        return switch phase {
        case .waitingForUser: String(localized: "The interruption point was saved")
        case .suspended: String(localized: "Queued behind another task")
        case .thinking, .preparing, .usingTool: String(localized: "View current agent activity")
        case .waitingForPermission: String(localized: "Review the pending request")
        case .completed: String(localized: "The run finished")
        case .failed: String(localized: "The run needs attention")
        case .cancelled: String(localized: "The run was stopped")
        case .unverified: String(localized: "Check the result before trying the action again")
        case .idle: String(localized: "No active run")
        }
    }

    private var symbol: String {
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
        case .idle: String(localized: "Idle")
        case .preparing: String(localized: "Preparing")
        case .thinking: String(localized: "Thinking…")
        case .usingTool: String(localized: "Using a tool")
        case .waitingForPermission: String(localized: "Waiting for permission")
        case .waitingForUser: String(localized: "Paused, ready to resume")
        case .suspended: String(localized: "Waiting for an execution slot")
        case .completed: String(localized: "Completed")
        case .failed: String(localized: "Run failed")
        case .cancelled: String(localized: "Cancelled")
        case .unverified: String(localized: "Result unverified")
        }
    }
}

extension AgentActivityReason {
    var activityDescription: String {
        switch self {
        case .permissionApproval: String(localized: "Waiting for device permission approval")
        case .autoApproved: String(localized: "Auto-approved (full auto)")
        case .browserTakeover: String(localized: "Waiting for browser control to return")
        case .backgroundTimeExpired: String(localized: "Paused after iOS background time expired")
        case .unexpectedTermination: String(localized: "Recovered after LeoPhoneAgent stopped unexpectedly")
        case .concurrencyLimit: String(localized: "Waiting for an execution slot")
        case .userInterruption: String(localized: "Paused by the user")
        case .responseLimit: String(localized: "The response reached its token limit")
        case .connectionDropped: String(localized: "The provider connection ended early")
        case .toolFailure: String(localized: "A tool step failed")
        case .providerFailure: String(localized: "The model provider request failed")
        case .authenticationRequired: String(localized: "Provider authentication needs attention")
        case .rateLimited: String(localized: "The provider rate limit was reached")
        case .kernelUnavailable: String(localized: "The local execution environment is unavailable")
        }
    }
}
