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
struct MacHostQuery: EntityQuery {
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
    }

    /// 活跃 = CLI 还活着,可继续对话/需要人:starting/running/idle/waiting。
    static func isActive(_ s: HarnessSessionSummary) -> Bool {
        ["starting", "running", "idle", "waiting_for_approval"].contains(s.status)
    }

    /// 并发扫全部主机;单台失败按空处理(Siri 场景下部分可达好过整体失败)。
    @MainActor
    static func scan() async -> [HostSessions] {
        let hosts = GatewayHostStore.shared.activeHosts
        var out: [HostSessions] = []
        await withTaskGroup(of: HostSessions?.self) { group in
            for host in hosts {
                guard let client = GatewayHostStore.shared.client(for: host) else { continue }
                group.addTask {
                    let sessions = (try? await client.harnessSessions()) ?? []
                    return HostSessions(host: host, sessions: sessions)
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
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let host = GatewayHostStore.shared.activeHosts.first(where: { $0.id == mac.id }),
              let client = GatewayHostStore.shared.client(for: host) else {
            return .result(dialog: "找不到 \(mac.name) 的访问密钥,去 app 里「设置 → 我的 Mac」补上。")
        }
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            return .result(dialog: "任务内容是空的,没有开工。")
        }
        do {
            _ = try await client.createHarnessSession(harness: cli.rawValue, cwd: "~", prompt: text)
            return .result(dialog: "已让 \(mac.name) 的 \(cli.displayName) 开工。进 app 首页「指挥一台 Mac」可随时查看、审批或接管。")
        } catch {
            return .result(dialog: "没能开工:\(error.localizedDescription)")
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
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let hosts = GatewayHostStore.shared.activeHosts
        guard !hosts.isEmpty else {
            return .result(dialog: "还没有配置任何 Mac。去 app 里「设置 → 我的 Mac」一键添加。")
        }
        let scan = await MacFleetScan.scan()
        guard !scan.isEmpty else {
            return .result(dialog: "一台 Mac 都没连上,检查网络或密钥。")
        }
        var parts: [String] = []
        for item in scan {
            let active = item.sessions.filter(MacFleetScan.isActive)
            let waiting = active.filter(\.waitingForApproval)
            if let w = waiting.first, let cmd = w.pendingApprovalCommand, !cmd.isEmpty {
                parts.append("\(item.host.name):\(active.count) 个进行中,有任务等你审批(\(String(cmd.prefix(40))))")
            } else if !waiting.isEmpty {
                parts.append("\(item.host.name):\(active.count) 个进行中,\(waiting.count) 个等审批")
            } else if !active.isEmpty {
                parts.append("\(item.host.name):\(active.count) 个进行中")
            } else {
                parts.append("\(item.host.name):空闲")
            }
        }
        if scan.count < hosts.count {
            parts.append("另有 \(hosts.count - scan.count) 台没连上")
        }
        return .result(dialog: IntentDialog(stringLiteral: parts.joined(separator: ";") + "。"))
    }
}

// MARK: - 批准最近的待审批

@available(iOS 16.0, *)
struct ApprovePendingMacIntent: AppIntent {
    static var title: LocalizedStringResource = "批准 Mac 待审批"
    static var description = IntentDescription("批准最近一条等待审批的 Mac 任务操作(批准一次)。")
    static var openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let scan = await MacFleetScan.scan()
        for item in scan {
            guard let session = item.sessions.first(where: { $0.pendingApprovalId != nil }),
                  let approvalId = session.pendingApprovalId,
                  let client = GatewayHostStore.shared.client(for: item.host) else { continue }
            let cmd = session.pendingApprovalCommand ?? session.name
            do {
                try await client.approveHarness(sessionId: session.id, choice: "once",
                                                approvalId: approvalId)
                return .result(dialog: "已批准 \(item.host.name) 上的操作:\(String(cmd.prefix(60)))")
            } catch {
                return .result(dialog: "批准没送达:\(error.localizedDescription)")
            }
        }
        return .result(dialog: "现在没有等待审批的任务。")
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
