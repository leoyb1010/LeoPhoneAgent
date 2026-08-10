//
//  MacFleetIntents.swift
//  MinisApp
//
//  [T-siri-fleet] Mac 舰队进 Siri:指挥 / 汇报 / 批准 / 停止。
//
//  四个 intent 全部 openAppWhenRun = false——Siri 里一句话直达中继,
//  不打开 app;结果由 Siri 念出来。地基全是现成的:GatewayHostStore
//  提供主机与 client,中继 API 提供会话/审批/停止。
//
//  实体:三台 Mac 是 AppEntity(Siri 听得懂"在 Studio 上"),CLI 是
//  AppEnum(claude/codex/grok)。参数缺失时 Siri 自动追问补槽。
//

import AppIntents
import Foundation

// MARK: - 实体

/// 一台受控 Mac,来自「我的 Mac」配置。
@available(iOS 16.0, *)
struct MacHostEntity: AppEntity, Identifiable {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Mac")
    static var defaultQuery = MacHostQuery()

    let id: String
    let name: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }

    @MainActor
    static func from(id: String) -> MacHostEntity? {
        GatewayHostStore.shared.activeHosts.first { $0.id == id }
            .map { MacHostEntity(id: $0.id, name: $0.name) }
    }
}

@available(iOS 16.0, *)
struct MacHostQuery: EntityStringQuery {
    /// 口语名匹配:「Studio」「MacBook」这种叫法直接命中,不用全名。
    @MainActor
    func entities(matching string: String) async throws -> [MacHostEntity] {
        let needle = string.lowercased().replacingOccurrences(of: " ", with: "")
        return GatewayHostStore.shared.activeHosts
            .filter { $0.name.lowercased().replacingOccurrences(of: " ", with: "").contains(needle) }
            .map { MacHostEntity(id: $0.id, name: $0.name) }
    }

    @MainActor
    func entities(for identifiers: [String]) async throws -> [MacHostEntity] {
        GatewayHostStore.shared.activeHosts
            .filter { identifiers.contains($0.id) }
            .map { MacHostEntity(id: $0.id, name: $0.name) }
    }

    @MainActor
    func suggestedEntities() async throws -> [MacHostEntity] {
        GatewayHostStore.shared.activeHosts.map { MacHostEntity(id: $0.id, name: $0.name) }
    }

    @MainActor
    func defaultResult() async -> MacHostEntity? {
        GatewayHostStore.shared.activeHosts.first
            .map { MacHostEntity(id: $0.id, name: $0.name) }
    }
}

/// 可指挥的编码 CLI。固定三种;某台 Mac 装没装由创建时的服务端报错兜底。
@available(iOS 16.0, *)
enum MacCLIOption: String, AppEnum {
    case claude, codex, grok

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "编码 CLI")
    static var caseDisplayRepresentations: [MacCLIOption: DisplayRepresentation] = [
        .claude: "Claude Code", .codex: "Codex", .grok: "Grok",
    ]

    var displayName: String {
        switch self {
        case .claude: return "Claude Code"
        case .codex: return "Codex"
        case .grok: return "Grok"
        }
    }
}

// MARK: - 舰队扫描(四个 intent 共用)

@available(iOS 16.0, *)
enum MacFleetScan {
    struct HostSessions {
        let host: GatewayHost
        let sessions: [HarnessSessionSummary]
        /// false = 没连上(而不是"没有任务")。两者绝不能混为一谈。
        var reachable: Bool = true
    }

    /// 活跃 = CLI 还活着,可继续对话/需要人:starting/running/idle/waiting。
    static func isActive(_ s: HarnessSessionSummary) -> Bool {
        ["starting", "running", "idle", "waiting_for_approval"].contains(s.status)
    }

    /// 并发扫全部主机。
    ///
    /// [T-fleet-offline] 关键:网络失败不能降级成"空会话列表"——那会让
    /// 一台关机的 Mac 被汇报成"空闲",与事实相反。用 reachable 标出来。
    @MainActor
    static func scan() async -> [HostSessions] {
        let hosts = GatewayHostStore.shared.activeHosts
        var out: [HostSessions] = []
        await withTaskGroup(of: HostSessions?.self) { group in
            for host in hosts {
                guard let client = GatewayHostStore.shared.client(for: host) else {
                    out.append(HostSessions(host: host, sessions: [], reachable: false))
                    continue
                }
                group.addTask {
                    if let sessions = try? await client.harnessSessions() {
                        return HostSessions(host: host, sessions: sessions, reachable: true)
                    }
                    return HostSessions(host: host, sessions: [], reachable: false)
                }
            }
            for await item in group {
                if let item { out.append(item) }
            }
        }
        // 稳定顺序:按配置顺序而不是网络返回顺序念
        let order = Dictionary(uniqueKeysWithValues: hosts.enumerated().map { ($1.id, $0) })
        return out.sorted { (order[$0.host.id] ?? 99) < (order[$1.host.id] ?? 99) }
    }
}

// MARK: - 指挥一台 Mac

@available(iOS 16.0, *)
struct CommandMacIntent: AppIntent {
    static var title: LocalizedStringResource = "指挥一台 Mac"
    static var description = IntentDescription("在指定 Mac 上用指定编码 CLI 开始一个任务,后台执行,不打开 app。")
    static var openAppWhenRun = false

    @Parameter(title: "Mac", requestValueDialog: "在哪台 Mac 上?")
    var mac: MacHostEntity

    @Parameter(title: "CLI", default: .claude, requestValueDialog: "用哪个 CLI?")
    var cli: MacCLIOption

    @Parameter(title: "任务", requestValueDialog: "要它做什么?")
    var prompt: String

    static var parameterSummary: some ParameterSummary {
        Summary("让 \(\.$mac) 的 \(\.$cli) 执行 \(\.$prompt)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let host = GatewayHostStore.shared.activeHosts.first(where: { $0.id == mac.id }),
              let client = GatewayHostStore.shared.client(for: host) else {
            return .result(dialog: "找不到 \(mac.name) 的访问密钥,去 app 里「设置 → 我的 Mac」补上。",
                           view: MacDispatchSnippet(machine: mac.name, cli: cli.displayName, task: "缺少访问密钥"))
        }
        guard !text.isEmpty else {
            return .result(dialog: "任务内容是空的,没有开工。",
                           view: MacDispatchSnippet(machine: mac.name, cli: cli.displayName, task: "内容为空"))
        }
        // [T-local-brain] Siri 里是口述进来的,常常是一段流水话。先让本机
        // 模型整理成"标题 + 要点"再下发,Mac 那头拿到的是清楚的任务。
        // 本机模型不可用就原样下发——不因为它缺席而少一个功能。
        let structured = await LocalBrain.shared.structureTask(from: text)
        let dispatch = structured.map { "\($0.title)\n\n\($0.detail)" } ?? text
        do {
            _ = try await client.createHarnessSession(harness: cli.rawValue, cwd: "~", prompt: dispatch)
            return .result(dialog: "已让 \(mac.name) 的 \(cli.displayName) 开工。",
                           view: MacDispatchSnippet(machine: mac.name, cli: cli.displayName,
                                                    task: structured?.title ?? text))
        } catch {
            return .result(dialog: "没能开工:\(error.localizedDescription)",
                           view: MacDispatchSnippet(machine: mac.name, cli: cli.displayName,
                                                    task: error.localizedDescription))
        }
    }
}

// MARK: - 舰队汇报

@available(iOS 16.0, *)
struct MacFleetStatusIntent: AppIntent {
    static var title: LocalizedStringResource = "Mac 任务汇报"
    static var description = IntentDescription("汇报三台 Mac 上进行中的编码任务与等待审批的数量。")
    static var openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        let hosts = GatewayHostStore.shared.activeHosts
        guard !hosts.isEmpty else {
            return .result(dialog: "还没有配置任何 Mac。去 app 里「设置 → 我的 Mac」一键添加。",
                           view: FleetStatusSnippet(rows: []))
        }
        let scan = await MacFleetScan.scan()
        guard !scan.isEmpty else {
            return .result(dialog: "一台 Mac 都没连上,检查网络或密钥。",
                           view: FleetStatusSnippet(rows: []))
        }
        var parts: [String] = []
        var rows: [FleetSnapshotRow] = []
        for item in scan {
            let active = item.sessions.filter(MacFleetScan.isActive)
            let waiting = active.filter(\.waitingForApproval)
            let cmd = waiting.first?.pendingApprovalCommand
            rows.append(FleetSnapshotRow(
                id: item.host.id, name: item.host.name,
                activeCount: active.count, waitingCount: waiting.count,
                pendingCommand: cmd, reachable: item.reachable))
            if !item.reachable {
                parts.append("\(item.host.name):没连上")
            } else if let cmd, !cmd.isEmpty {
                parts.append("\(item.host.name):\(active.count) 个进行中,有任务等你审批(\(String(cmd.prefix(40))))")
            } else if !waiting.isEmpty {
                parts.append("\(item.host.name):\(active.count) 个进行中,\(waiting.count) 个等审批")
            } else if !active.isEmpty {
                parts.append("\(item.host.name):\(active.count) 个进行中")
            } else {
                parts.append("\(item.host.name):空闲")
            }
        }
        return .result(
            dialog: IntentDialog(stringLiteral: parts.joined(separator: ";") + "。"),
            view: FleetStatusSnippet(rows: rows))
    }
}

// MARK: - 批准最近的待审批

@available(iOS 16.0, *)
struct ApprovePendingMacIntent: AppIntent {
    static var title: LocalizedStringResource = "批准 Mac 待审批"
    static var description = IntentDescription("批准最近一条等待审批的 Mac 任务操作(批准一次)。")
    static var openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        let scan = await MacFleetScan.scan()

        // [T-approve-newest] 这是在放行 shell 命令,选错对象不是小事。
        // 收齐全部待审批,取 seq 最大的那条(= 最近的),而不是"首台主机的
        // 第一条"(= 最老的,与文案自述相反)。
        struct Candidate {
            let host: GatewayHost
            let session: HarnessSessionSummary
            let approvalId: String
        }
        var candidates: [Candidate] = []
        for item in scan where item.reachable {
            for session in item.sessions {
                if let aid = session.pendingApprovalId {
                    candidates.append(Candidate(host: item.host, session: session, approvalId: aid))
                }
            }
        }
        candidates.sort { $0.session.seq > $1.session.seq }

        guard !candidates.isEmpty else {
            let unreachable = scan.filter { !$0.reachable }.count
            let tail = unreachable > 0 ? "(另有 \(unreachable) 台没连上)" : ""
            return .result(dialog: IntentDialog(stringLiteral: "现在没有等待审批的任务。" + tail),
                           view: ApprovalResultSnippet(machine: "—", command: "无待审批", approved: false))
        }

        // [T-approve-retry] 首台失败不该让其余待审批全部落空,继续试下一条。
        var lastError: String?
        for candidate in candidates {
            guard let client = GatewayHostStore.shared.client(for: candidate.host) else { continue }
            let cmd = candidate.session.pendingApprovalCommand ?? candidate.session.name
            do {
                try await client.approveHarness(sessionId: candidate.session.id,
                                                choice: "once", approvalId: candidate.approvalId)
                return .result(
                    dialog: "已批准 \(candidate.host.name) 上的操作:\(String(cmd.prefix(60)))",
                    view: ApprovalResultSnippet(machine: candidate.host.name,
                                                command: cmd, approved: true))
            } catch {
                lastError = error.localizedDescription
                continue
            }
        }
        return .result(dialog: "批准没送达:\(lastError ?? "未知原因")",
                       view: ApprovalResultSnippet(machine: candidates[0].host.name,
                                                   command: lastError ?? "", approved: false))
    }
}

// MARK: - 停止 Mac 任务

@available(iOS 16.0, *)
struct StopMacTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "停止 Mac 任务"
    static var description = IntentDescription("停止指定 Mac 上最近的进行中任务。")
    static var openAppWhenRun = false

    @Parameter(title: "Mac", requestValueDialog: "停哪台 Mac 上的任务?")
    var mac: MacHostEntity

    static var parameterSummary: some ParameterSummary {
        Summary("停止 \(\.$mac) 上的任务")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let host = GatewayHostStore.shared.activeHosts.first(where: { $0.id == mac.id }),
              let client = GatewayHostStore.shared.client(for: host) else {
            return .result(dialog: "找不到 \(mac.name) 的访问密钥。")
        }
        let sessions = (try? await client.harnessSessions()) ?? []
        // 最近的活跃会话 = 列表末尾的活跃项(服务端按创建序返回)
        guard let target = sessions.last(where: MacFleetScan.isActive) else {
            return .result(dialog: "\(mac.name) 上没有进行中的任务。")
        }
        do {
            try await client.stopHarness(sessionId: target.id)
            return .result(dialog: "已停止 \(mac.name) 上的 \(target.name) 任务。")
        } catch {
            return .result(dialog: "停止失败:\(error.localizedDescription)")
        }
    }
}
