import SwiftUI

// [T-subagent] A sub agent's `<agent_callback>` message rendered as a result
// card instead of a right-aligned user bubble (upstream iOS 1.14
// `[T-p3-agent-callback-cell]`, rebuilt on LeoBot tokens). The model still
// receives the full envelope; this is presentation only.

struct AgentCallbackCellView: View {
    let callback: AgentCallback
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(tint)
                Text(headline)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(ChatColors.primaryText)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text(AgentCallback.localizedStatus(callback.status))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(tint)
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(tint.opacity(0.12)).clipShape(Capsule())
            }
            if !callback.title.isEmpty {
                Text(callback.title)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(ChatColors.primaryText)
                    .lineLimit(2)
            }
            if !callback.body.isEmpty {
                Text(callback.body)
                    .font(.system(size: 13))
                    .foregroundStyle(ChatColors.secondaryText)
                    .lineLimit(expanded ? nil : 6)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) {
                if let elapsed = callback.elapsed {
                    Text(elapsed).font(.system(size: 11, design: .monospaced)).foregroundStyle(ChatColors.tertiaryText)
                }
                if let model = callback.modelIdentity?.actualModelLabel {
                    Text(model).font(.system(size: 11)).foregroundStyle(ChatColors.tertiaryText).lineLimit(1)
                }
                Spacer(minLength: 0)
                if callback.body.count > 280 || callback.body.filter({ $0 == "\n" }).count > 5 {
                    Button(expanded ? String(localized: "收起") : String(localized: "展开全部")) {
                        expanded.toggle()
                    }
                    .font(.system(size: 12, weight: .medium))
                    .buttonStyle(.borderless)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ChatColors.toolBg)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(tint.opacity(0.25), lineWidth: 0.5))
        .padding(.horizontal, 12)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("agentCallback")
    }

    private var headline: String {
        let base = callback.kind == .finished ? String(localized: "子代理结果") : String(localized: "子代理进度")
        guard let agent = callback.agent, !agent.isEmpty, agent != SubAgentDefinition.builtInName else { return base }
        return "\(base) · \(agent)"
    }

    private var icon: String {
        switch callback.status {
        case "done", "completed": return "checkmark.circle.fill"
        case "failed", "timeout": return "exclamationmark.triangle.fill"
        case "cancelled": return "stop.circle.fill"
        default: return "person.2.fill"
        }
    }

    private var tint: Color {
        switch callback.status {
        case "done", "completed": return .green
        case "failed", "timeout": return .orange
        case "cancelled", "no_deliverable": return .secondary
        default: return ChatColors.accent
        }
    }
}
