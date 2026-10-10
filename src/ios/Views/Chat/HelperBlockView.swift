import SwiftUI

// [T-subagent] The parent conversation's card for one `subagent_task` call
// (ported in spirit from upstream iOS 1.14 HelperBlockView, rebuilt on
// LeoBot's chat tokens and kept compact). Everything it shows comes from the
// block's JSON payload (persisted, so it survives a restart) plus the live
// registry (running / queued / interrupted is decided against the in-memory
// jobs, exactly like `SubAgentRecovery.state`).

/// Parsed view of a `subagent_task` block.
struct HelperBlockInfo {
    let action: SubAgentTool.Action
    let payload: [String: Any]?
    let title: String
    let agent: String?
    let status: String
    let childSessionId: String?
    let jobId: String?
    let result: String?
    let modelLabel: String?
    let errorKind: String?
    let elapsedSeconds: Int?
    let toolUseId: String?

    @MainActor
    init(block: AssistantBlock) {
        toolUseId = block.toolUseId
        let parsed = Self.parsed(block)
        let args = parsed.args
        action = SubAgentTool.Action.parse(args["action"])
        payload = parsed.payload
        let argTitle = (args["tool_title"] as? String) ?? ""
        let payloadTitle = (payload?["title"] as? String) ?? ""
        let summaryTitle = block.toolSummary ?? ""
        if !payloadTitle.isEmpty { title = payloadTitle }
        else if !argTitle.isEmpty { title = argTitle }
        else if !summaryTitle.isEmpty { title = summaryTitle }
        else { title = String(((args["task"] as? String) ?? "").prefix(40)) }
        agent = (payload?["agent"] as? String) ?? (args["agent"] as? String)
        status = (payload?["status"] as? String) ?? (block.toolStatus == .running ? "running" : "starting")
        childSessionId = payload?["child_session_id"] as? String
        jobId = payload?["job_id"] as? String
        result = payload?["result"] as? String
        modelLabel = (payload?["model_effective_name"] as? String)
            ?? (payload?["model_resolved_name"] as? String)
            ?? (payload?["model_used"] as? String)
        errorKind = payload?["error_kind"] as? String
        elapsedSeconds = payload?["elapsed_s"] as? Int
    }

    var isControlOnly: Bool { action != .delegate }

    // MARK: Parse cache [T-r3-P2]

    /// The card and its sheet re-evaluate on every block / registry change;
    /// both JSON documents only change when their strings do. Entry is
    /// reused while the exact strings are unchanged (`==` hits the identity
    /// fast path for the same storage), so a body pass costs no parsing.
    private struct ParsedEntry {
        let content: String
        let argsRaw: String?
        let payload: [String: Any]?
        let args: [String: Any]
    }
    @MainActor private static var parseCache: [UUID: ParsedEntry] = [:]
    @MainActor private static let parseCacheCap = 256

    @MainActor
    static func parsed(_ block: AssistantBlock) -> (payload: [String: Any]?, args: [String: Any]) {
        if let hit = parseCache[block.id], hit.content == block.content, hit.argsRaw == block.toolInputArgs {
            return (hit.payload, hit.args)
        }
        let entry = ParsedEntry(content: block.content,
                                argsRaw: block.toolInputArgs,
                                payload: SubAgentRecovery.parseJSON(block.content),
                                args: AIChatViewModel.subAgentInputArgs(block))
        if parseCache.count >= parseCacheCap { parseCache.removeAll(keepingCapacity: true) }
        parseCache[block.id] = entry
        return (entry.payload, entry.args)
    }

    /// Live state against the registry: a "running" block with no job behind
    /// it was lost with the previous process (interrupted, resumable).
    @MainActor
    var recoveryState: SubAgentRecovery.BlockState {
        SubAgentRecovery.state(payload: payload, isControlCall: isControlOnly,
                               isJobAlive: { AgentJobRegistry.shared.isJobAlive(childSessionId: $0) },
                               isQueued: toolUseId.map { AgentJobRegistry.shared.isQueued(toolUseId: $0) } ?? false)
    }

    var controlLabel: String {
        switch action {
        case .status: return String(localized: "查看子代理状态")
        case .steer: return String(localized: "引导子代理")
        case .cancel: return String(localized: "停止子代理")
        case .resume: return String(localized: "恢复子代理")
        case .delegate: return title
        }
    }
}

struct HelperBlockView: View {
    @ObservedObject var block: AssistantBlock
    @State private var showSheet = false
    /// [T-r3-P2] The registry slice this card shows. The card used to observe
    /// the whole registry, so every job / queue change anywhere re-ran every
    /// card's body (and its JSON parse); now it only re-renders when ITS
    /// job's liveness or queue state actually changes.
    @State private var liveSlice = LiveSlice()

    struct LiveSlice: Equatable {
        var job: AgentJob?
        var queued = false
        static func == (a: LiveSlice, b: LiveSlice) -> Bool {
            a.job === b.job && a.queued == b.queued
        }
    }

    var body: some View {
        let info = HelperBlockInfo(block: block)
        Group {
            if info.isControlOnly {
                controlCapsule(info)
            } else {
                card(info)
            }
        }
        .sheet(isPresented: $showSheet) {
            HelperSheet(block: block)
        }
        .onAppear { refreshLiveSlice() }
        .onChange(of: block.content) { _, _ in refreshLiveSlice() }
        // Delivered after the change lands (objectWillChange fires before it).
        .onReceive(AgentJobRegistry.shared.objectWillChange.receive(on: DispatchQueue.main)) { _ in
            refreshLiveSlice()
        }
    }

    private func refreshLiveSlice() {
        let info = HelperBlockInfo(block: block)
        let registry = AgentJobRegistry.shared
        let next = LiveSlice(job: info.childSessionId.flatMap { registry.job(forChild: $0) },
                             queued: info.toolUseId.map { registry.isQueued(toolUseId: $0) } ?? false)
        if next != liveSlice { liveSlice = next }
    }

    // MARK: Control call (status / steer / cancel / resume)

    private func controlCapsule(_ info: HelperBlockInfo) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "person.2.wave.2")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(ChatColors.accent)
            Text(info.controlLabel)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(ChatColors.secondaryText)
                .lineLimit(1)
            if case .failed = block.toolStatus {
                Image(systemName: "exclamationmark.circle").font(.system(size: 11)).foregroundStyle(.orange)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(ChatColors.toolBg).clipShape(Capsule())
        .contentShape(Capsule())
        .onTapGesture { showSheet = true }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(info.controlLabel)
    }

    // MARK: Delegation card

    private func card(_ info: HelperBlockInfo) -> some View {
        let live = liveSlice.job
        let state = info.recoveryState
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "person.2.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(ChatColors.accent)
                Text(badgeText(info))
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(ChatColors.primaryText)
                    .lineLimit(1)
                Spacer(minLength: 4)
                statusPill(info, live: live, state: state)
            }
            Text(info.title)
                .font(.system(size: 13))
                .foregroundStyle(ChatColors.primaryText)
                .lineLimit(2)
            HStack(spacing: 8) {
                if let model = info.modelLabel, !model.isEmpty {
                    Label(model, systemImage: "cpu")
                        .labelStyle(.titleAndIcon)
                        .font(.system(size: 11))
                        .foregroundStyle(ChatColors.tertiaryText)
                        .lineLimit(1)
                }
                elapsedView(info, live: live)
                Spacer(minLength: 0)
                actions(info, live: live, state: state)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ChatColors.toolBg)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(ChatColors.toolBorder, lineWidth: 0.5))
        .contentShape(RoundedRectangle(cornerRadius: 12))
        .onTapGesture { showSheet = true }
        .accessibilityElement(children: .contain)
    }

    private func badgeText(_ info: HelperBlockInfo) -> String {
        let base = String(localized: "子代理")
        guard let agent = info.agent, !agent.isEmpty, agent != SubAgentDefinition.builtInName else { return base }
        return "\(base) · \(agent)"
    }

    @ViewBuilder
    private func statusPill(_ info: HelperBlockInfo, live: AgentJob?, state: SubAgentRecovery.BlockState) -> some View {
        let (text, color): (String, Color) = {
            if case .interrupted = state { return (String(localized: "已中断"), .orange) }
            if case .neverStarted = state { return (String(localized: "未开始"), .orange) }
            if live != nil { return (String(localized: "运行中"), ChatColors.accent) }
            switch info.status {
            case "completed": return (String(localized: "已完成"), .green)
            case "queued": return (String(localized: "排队中"), .secondary)
            case "running", "starting": return (String(localized: "运行中"), ChatColors.accent)
            case "rejected": return (String(localized: "被拒绝"), .orange)
            case "failed": return (info.errorKind ?? String(localized: "失败"), .red)
            default: return (AgentCallback.localizedStatus(info.status), .secondary)
            }
        }()
        HStack(spacing: 4) {
            if live != nil { ProgressView().controlSize(.mini) }
            Text(text).font(.system(size: 11, weight: .semibold))
        }
        .foregroundStyle(color)
        .padding(.horizontal, 7).padding(.vertical, 2)
        .background(color.opacity(0.12)).clipShape(Capsule())
    }

    @ViewBuilder
    private func elapsedView(_ info: HelperBlockInfo, live: AgentJob?) -> some View {
        if let live {
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                Text(Self.clock(Int(live.elapsed ?? 0)))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ChatColors.tertiaryText)
            }
        } else if let s = info.elapsedSeconds, s > 0 {
            Text(Self.clock(s))
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(ChatColors.tertiaryText)
        }
    }

    @ViewBuilder
    private func actions(_ info: HelperBlockInfo, live: AgentJob?, state: SubAgentRecovery.BlockState) -> some View {
        if live != nil, let child = info.childSessionId {
            Button {
                AgentJobRegistry.shared.cancelSiblings(ofChild: child, reason: "user stopped from the card")
            } label: {
                Label(String(localized: "停止"), systemImage: "stop.circle")
                    .font(.system(size: 12, weight: .medium))
            }
            .buttonStyle(.borderless)
            .tint(.red)
            .accessibilityIdentifier("subagent.stop")
        } else if case .interrupted(let child) = state {
            Button {
                Task { await Self.resume(childSessionId: child) }
            } label: {
                Label(String(localized: "恢复"), systemImage: "play.circle")
                    .font(.system(size: 12, weight: .medium))
            }
            .buttonStyle(.borderless)
            .accessibilityIdentifier("subagent.resume")
        }
    }

    /// Resume from the card: the parent view model owns the run.
    @MainActor
    static func resume(childSessionId: String) async {
        guard let child = await ChatStore.shared.getSession(childSessionId),
              let parent = child.parentSessionId else { return }
        let (vm, fresh) = ViewModelCache.shared.getOrCreate(for: parent)
        if fresh { await vm.loadSession() }
        if let why = await vm.resumeInterruptedSubAgent(childSessionId: childSessionId) {
            vm.appendSystemInfo(String(localized: "子代理没能恢复：\(why)"), icon: "exclamationmark.triangle")
        }
    }

    static func clock(_ s: Int) -> String {
        String(format: "%d:%02d", s / 60, s % 60)
    }
}
