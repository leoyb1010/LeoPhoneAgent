import SwiftUI

// MARK: - 头部

/// 详情页紧凑头部：状态胶囊、编号、实时状态、标题、负责人。
struct PaperclipIssueHeader: View {
    let issue: PaperclipIssue
    let assignee: PaperclipAgent?
    let client: PaperclipClient
    let liveState: PaperclipLiveConnection.State?
    let runActive: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                PaperclipStatusCapsule(status: issue.status)
                if let identifier = issue.identifier {
                    Text(identifier)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
                if issue.priority == "high" || issue.priority == "critical" {
                    Label(PaperclipLabels.priority(issue.priority), systemImage: "flag.fill")
                        .labelStyle(.titleAndIcon)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(issue.priority == "critical" ? LeoTheme.ColorToken.destructive : LeoTheme.ColorToken.warning)
                }
                Spacer(minLength: 0)
                PaperclipLiveBadge(state: liveState)
            }
            Text(issue.title)
                .font(.title3.weight(.semibold))
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .accessibilityAddTraits(.isHeader)
            HStack(spacing: 8) {
                if let assignee {
                    PaperclipAvatar(client: client, path: PaperclipAvatarPath.normalized(assignee.avatarUrl, origin: client.profile.origin),
                                    name: assignee.name, size: 22)
                    Text(assignee.name).font(.subheadline.weight(.medium))
                    if runActive {
                        Text("· 正在处理").font(.subheadline).foregroundStyle(LeoTheme.ColorToken.accent)
                    }
                } else {
                    Image(systemName: "person.crop.circle.dashed").foregroundStyle(.tertiary)
                    Text("尚未分配执行者").font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if let updated = PaperclipTimeText.relative(issue.updatedAt) {
                    Text(updated).font(.caption).foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.top, 8)
        .padding(.bottom, 4)
    }
}

// MARK: - 消息

/// 任务说明：作为对话的第一条，整宽卡片渲染 Markdown。
struct PaperclipDescriptionCard: View {
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("任务说明", systemImage: "text.alignleft")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            PaperclipMarkdown(text: text)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(LeoTheme.ColorToken.surface, in: RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
    }
}

/// 智能体消息：左侧 24pt 头像 + 名字，正文整宽 Markdown，无气泡（与端侧助手消息一致）。
struct PaperclipAgentMessage: View {
    let comment: PaperclipComment
    let agent: PaperclipAgent?
    let client: PaperclipClient
    let showsHeader: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if showsHeader {
                HStack(spacing: 8) {
                    PaperclipAvatar(client: client, path: PaperclipAvatarPath.normalized(agent?.avatarUrl, origin: client.profile.origin),
                                    name: agent?.name ?? "智能体", size: 24)
                    Text(agent?.name ?? "智能体").font(.subheadline.weight(.semibold))
                    if let time = PaperclipTimeText.short(comment.createdAt) {
                        Text(time).font(.caption).foregroundStyle(.tertiary)
                    }
                }
            }
            PaperclipMarkdown(text: comment.body)
                .padding(.leading, 32)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .id(comment.id)
    }
}

/// 人类消息：右侧用户气泡（tertiarySystemFill、圆角 18），与端侧用户消息一致。
struct PaperclipHumanMessage: View {
    let comment: PaperclipComment
    let mine: Bool
    let showsFooter: Bool

    var body: some View {
        HStack {
            Spacer(minLength: 48)
            VStack(alignment: .trailing, spacing: 4) {
                if !mine {
                    Text("团队成员").font(.caption).foregroundStyle(.secondary)
                }
                Text(comment.body)
                    .font(.body)
                    .foregroundStyle(ChatColors.primaryText)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(ChatColors.userBubble, in: RoundedRectangle(cornerRadius: LeoTheme.Radius.bubble, style: .continuous))
                if showsFooter, let time = PaperclipTimeText.short(comment.createdAt) {
                    Text(time).font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .id(comment.id)
    }
}

// MARK: - 运行

/// 运行中卡片的展示数据（来自 live-runs，或 runs 中仍在运行的记录）。
struct PaperclipActiveRunDisplay: Identifiable, Equatable {
    let id: String
    let status: String
    let agentID: String
    let agentName: String
    let avatarPath: String?
    let startedAt: Date?
}

/// 运行轮次卡片（运行中）：头像、执行中 · 当前工具、实时计时、最近一句输出、可展开实时日志。
struct PaperclipRunCard: View {
    let run: PaperclipActiveRunDisplay
    let progress: PaperclipRunProgress?
    let log: PaperclipRunStream.LogState?
    let expanded: Bool
    let telemetryAvailable: Bool
    let client: PaperclipClient
    let onToggleLog: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var queued: Bool { run.status == "queued" }
    private var activityLine: String {
        if queued { return "排队中，等待执行" }
        if let tool = progress?.currentToolName, !tool.isEmpty { return "执行中 · \(tool)" }
        if let message = progress?.message, !message.isEmpty { return "执行中 · \(message)" }
        return "执行中"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                PaperclipAvatar(client: client, path: run.avatarPath, name: run.agentName, size: 24)
                Text(run.agentName).font(.subheadline.weight(.semibold)).lineLimit(1)
                Spacer(minLength: 8)
                if let started = run.startedAt, !queued {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(PaperclipDates.clock(context.date.timeIntervalSince(started)))
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityLabel(Text("已运行"))
                }
            }
            HStack(spacing: 7) {
                Circle()
                    .fill(queued ? LeoTheme.ColorToken.secondaryText : LeoTheme.ColorToken.accent)
                    .frame(width: 7, height: 7)
                    .leoPulse(active: !queued)
                Text(activityLine)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(queued ? LeoTheme.ColorToken.secondaryText : LeoTheme.ColorToken.accent)
                    .lineLimit(1)
                    .contentTransition(.opacity)
                    .animation(LeoMotion.smooth(reduceMotion: reduceMotion, duration: 0.25), value: activityLine)
                    .accessibilityIdentifier("paperclip.runActivity")
            }
            if let snippet = progress?.lastAssistantSnippet?.trimmingCharacters(in: .whitespacesAndNewlines), !snippet.isEmpty {
                PaperclipMarkdown(text: snippet, streaming: true)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .transition(.opacity)
                    .id(snippet)
                    .accessibilityIdentifier("paperclip.runSnippet")
            } else if !queued {
                PaperclipTypingDots()
            }
            if telemetryAvailable {
                Button(action: onToggleLog) {
                    HStack(spacing: 6) {
                        Image(systemName: "terminal").font(.caption.weight(.semibold))
                        Text(expanded ? "收起实时日志" : "查看实时日志").font(.caption.weight(.semibold))
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.down")
                            .font(.caption2.weight(.bold))
                            .rotationEffect(.degrees(expanded ? 180 : 0))
                    }
                    .foregroundStyle(.secondary)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("paperclip.toggleLog")
                if expanded {
                    PaperclipLogConsole(log: log, live: true, height: 220)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
        .padding(14)
        .background {
            RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous)
                .fill(LeoTheme.ColorToken.surface)
                .overlay(PaperclipShimmer().clipShape(RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous)))
        }
        .overlay {
            RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous)
                .strokeBorder(LeoTheme.ColorToken.accent.opacity(queued ? 0.12 : 0.28), lineWidth: 1)
        }
        .animation(LeoMotion.smooth(reduceMotion: reduceMotion), value: expanded)
        .animation(LeoMotion.smooth(reduceMotion: reduceMotion), value: progress?.lastAssistantSnippet)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("paperclip.runCard.\(run.id)")
    }
}

/// 三个呼吸点（与端侧“正在回复”一致，文案中文化）。
struct PaperclipTypingDots: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var on = false
    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { index in
                Circle().fill(.secondary).frame(width: 5, height: 5)
                    .opacity(reduceMotion ? 0.6 : (on ? 1 : 0.25))
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.5).repeatForever(autoreverses: true).delay(Double(index) * 0.18), value: on)
            }
        }
        .padding(.vertical, 4)
        .onAppear { on = true }
        .accessibilityLabel(Text("正在思考"))
    }
}

/// 已结束运行的摘要：已完成 · 耗时 · 状态；失败显示中文错误摘要。点按查看日志。
struct PaperclipRunSummaryRow: View {
    let run: PaperclipRun
    let agentName: String

    private var succeeded: Bool { run.status == "succeeded" }
    private var duration: String? {
        guard let start = PaperclipDates.parse(run.startedAt), let end = PaperclipDates.parse(run.finishedAt) else { return nil }
        return PaperclipDates.duration(end.timeIntervalSince(start))
    }
    private var title: String {
        let outcome = succeeded ? "已完成" : PaperclipLabels.status(run.status)
        return [outcome, duration].compactMap { $0 }.joined(separator: " · ")
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: succeeded ? "checkmark.circle.fill" : (run.status == "cancelled" ? "stop.circle.fill" : "exclamationmark.circle.fill"))
                .font(.subheadline)
                .foregroundStyle(succeeded ? LeoTheme.ColorToken.success : PaperclipStatusStyle.color(run.status))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(title).font(.footnote.weight(.semibold)).foregroundStyle(.primary)
                    Text(agentName).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                }
                if !succeeded, let reason = PaperclipLabels.runError(run.errorCode) {
                    Text(reason).font(.caption).foregroundStyle(PaperclipStatusStyle.color(run.status))
                }
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(.tertiary).padding(.top, 3)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: LeoTheme.Radius.field, style: .continuous))
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("paperclip.runSummary.\(run.runId)")
    }
}

/// 解析后的日志：等宽小字，stderr 用警示色，新内容到达时滚到底部。
struct PaperclipLogConsole: View {
    let log: PaperclipRunStream.LogState?
    let live: Bool
    var height: CGFloat? = nil

    var body: some View {
        let lines = log?.parser.lines ?? []
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    if lines.isEmpty {
                        Text(log?.loading == true ? "正在读取日志…" : (log?.error ?? "暂无日志输出"))
                            .foregroundStyle(.secondary)
                    }
                    ForEach(lines) { line in
                        Text(line.text.isEmpty ? " " : line.text)
                            .foregroundStyle(line.stream == .stderr ? LeoTheme.ColorToken.warning : Color.primary.opacity(0.85))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .id(line.id)
                    }
                    if let error = log?.error, !lines.isEmpty {
                        Text(error).foregroundStyle(LeoTheme.ColorToken.destructive)
                    }
                    Color.clear.frame(height: 1).id("paperclip.log.end")
                }
                .font(.system(size: 11, design: .monospaced))
                .textSelection(.enabled)
                .padding(10)
            }
            // 内联时随内容增高，最多到给定高度，避免几行日志下面留出大片空白。
            .frame(height: height.map { min($0, CGFloat(max(lines.count, 1)) * 16 + 28) })
            .frame(maxHeight: height == nil ? .infinity : nil)
            .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: LeoTheme.Radius.field, style: .continuous))
            .onAppear { proxy.scrollTo("paperclip.log.end", anchor: .bottom) }
            .onChange(of: lines.last?.id) { _, _ in
                guard live else { return }
                proxy.scrollTo("paperclip.log.end", anchor: .bottom)
            }
            .onChange(of: lines.last?.text) { _, _ in
                guard live else { return }
                proxy.scrollTo("paperclip.log.end", anchor: .bottom)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("paperclip.logConsole")
    }
}

// MARK: - 审批

/// 待处理审批的内联卡片。批准/拒绝仍走二次确认与提交前重新核对内容的安全流程。
struct PaperclipApprovalCard: View {
    let approval: PaperclipApproval
    let requester: String
    @Binding var note: String
    var noteFocus: FocusState<Bool>.Binding
    let busy: Bool
    let onDecide: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.shield.fill").foregroundStyle(Color(uiColor: .systemIndigo))
                Text(approval.title).font(.subheadline.weight(.semibold))
                Spacer(minLength: 0)
                PaperclipStatusCapsule(status: approval.status, compact: true)
            }
            Text("申请者：\(requester)").font(.caption).foregroundStyle(.secondary)
            Text("以下内容由服务器提供，请完整核对后再决定。").font(.caption).foregroundStyle(.secondary)
            Text(approval.payloadText)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: LeoTheme.Radius.field, style: .continuous))
            TextField("决定说明（可选）", text: $note, axis: .vertical)
                .lineLimit(1...4)
                .font(.subheadline)
                .padding(10)
                .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: LeoTheme.Radius.field, style: .continuous))
                .focused(noteFocus)
                .disabled(busy)
            HStack(spacing: 10) {
                Button(role: .destructive) { onDecide(false) } label: {
                    Text("拒绝").font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity).frame(minHeight: 30)
                }
                .buttonStyle(.bordered)
                Button { onDecide(true) } label: {
                    Text("批准").font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity).frame(minHeight: 30)
                }
                .buttonStyle(.borderedProminent)
            }
            .disabled(busy)
        }
        .padding(14)
        .background(LeoTheme.ColorToken.surface, in: RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous)
                .strokeBorder(Color(uiColor: .systemIndigo).opacity(0.3), lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("paperclip.approval.\(approval.id)")
    }
}

/// 已处理审批的单行回执。
struct PaperclipResolvedApprovalRow: View {
    let approval: PaperclipApproval
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: approval.status == "approved" ? "checkmark.seal.fill" : "xmark.seal.fill")
                .foregroundStyle(PaperclipStatusStyle.color(approval.status))
                .accessibilityHidden(true)
            Text("\(approval.title) · \(PaperclipLabels.status(approval.status))")
                .font(.footnote.weight(.medium))
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: LeoTheme.Radius.field, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}
