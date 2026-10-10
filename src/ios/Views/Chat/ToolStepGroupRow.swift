//
//  ToolStepGroupRow.swift
//  MinisApp
//
//  [T-tool-step-collapse] The row that stands for a run of finished tool
//  calls: "已运行 3 个工具 · 9 秒 · <last step>". Tapping it shows / hides the
//  capsules. Grouping rules: `ToolStepGrouping` (pure, tested).
//

import SwiftUI

extension ToolStep {
    /// How a chat block takes part in tool-step grouping.
    @MainActor
    init(block: AssistantBlock) {
        let role: Role
        switch block.kind {
        case .text:
            role = block.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .transparent : .barrier
        case .thinking:
            role = .transparent
        case .info, .delegateTool:
            role = .barrier
        default:
            if block.isAskUserBlock || block.imageFilePath != nil {
                role = .barrier   // a card / an image is output, never folded
            } else {
                switch block.toolStatus {
                case .success: role = .completedTool
                case .running, .streaming: role = .liveTool
                case .failed: role = .failedTool
                case .cancelled: role = .cancelledTool
                case nil: role = .barrier
                }
            }
        }
        let summary = block.toolSummary.flatMap { $0.isEmpty ? nil : $0 } ?? block.toolDescription
        self.init(id: block.id, role: role, toolUseId: block.toolUseId,
                  summary: summary.isEmpty ? nil : summary,
                  startTime: block.toolStartTime, duration: block.toolDuration)
    }
}

/// Which tool-step rows the user opened. Lives with the list (per message,
/// while the session is open), keyed by the run's first saved tool id.
final class ToolGroupFoldState: ObservableObject {
    @Published var expanded: Set<String> = []
}

struct ToolStepGroupRow: View {
    /// One footnote line + 7+7 capsule padding + 2+2 row padding.
    static let estimatedHeight: CGFloat = 34

    @ObservedObject var message: ChatMessage
    let firstBlockId: UUID
    @ObservedObject var state: ToolGroupFoldState
    var maxWidth: CGFloat = 0
    let onToggle: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let group = ToolStepGrouping.groups(message.blocks.map(ToolStep.init(block:)))
            .first { $0.firstId == firstBlockId }
        let count = group?.toolCount ?? 0
        let seconds = group?.elapsed ?? 0
        let expanded = group.map { state.expanded.contains($0.expansionKey) } ?? false
        let headline = seconds > 0
            ? String(localized: "已运行 \(count) 个工具 · \(LeoDuration.short(seconds))")
            : String(localized: "已运行 \(count) 个工具")
        Button(action: onToggle) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.circle")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(ChatColors.secondaryText)
                Text(headline)
                    .font(.footnote.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(ChatColors.secondaryText)
                    .layoutPriority(1)
                if let summary = group?.lastSummary {
                    Text(summary)
                        .font(.footnote)
                        .foregroundStyle(ChatColors.tertiaryText)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
                    .animation(reduceMotion ? nil : .easeInOut(duration: LeoMotion.quick), value: expanded)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .frame(minHeight: 30)
            .background(Color.primary.opacity(0.045), in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(maxWidth: maxWidth > 0 ? maxWidth : .infinity, alignment: .leading)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 16)
        .opacity(message.isCompactedHistory ? 0.5 : 1.0)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(group?.lastSummary.map { String(localized: "\(headline)。最后一步：\($0)") } ?? headline))
        .accessibilityHint(expanded ? Text("收起这些步骤") : Text("展开这些步骤"))
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("assistantToolGroupRow")
    }
}
