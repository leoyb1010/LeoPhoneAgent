//
//  MacExternalSessionsClient.swift
//  MinisApp
//
//  [takeover] 接管 Mac 终端里已开着的 Claude Code 会话:列出、接管(线格式在 Shared/MacExternalSessions.swift)。
//  接管后就是一个普通的 Mac 任务,会话页、续传、审批全部复用 HarnessConsoleView。
//

import Foundation
import SwiftUI

extension LeoAgentClient {
    /// nil = 这台 Mac 没有这个接口(旧版 LeoBot / 旧 leoagent 回 404):入口隐藏。
    func externalSessions() async throws -> [MacExternalSession]? {
        do {
            return MacExternalSessionsWire.parseList(try await getJSON(MacExternalSessionsWire.listPath, service: .harness))
        } catch GatewayError.http(let status, _) where status == 404 || status == 405 {
            return nil
        } catch GatewayError.harnessNotConfigured {
            return nil
        }
    }

    /// 接管:Mac 开(或找回已开的)一个 Claude Code 任务,事件流先回放终端里的历史。
    func takeOverExternalSession(_ session: MacExternalSession) async throws -> MacTakeoverResult {
        let obj = try await postJSON(MacExternalSessionsWire.createPath,
                                     body: MacExternalSessionsWire.takeoverBody(session), service: .harness)
        guard let result = MacExternalSessionsWire.parseTakeover(obj, fallback: session) else {
            throw GatewayError.malformedResponse("missing session_id")
        }
        return result
    }
}

/// 各台 Mac 上「终端里的会话」。首页入口据此决定显不显示、要不要亮小圆点。
@MainActor
final class MacTerminalSessionsStore: ObservableObject {
    static let shared = MacTerminalSessionsStore()

    struct HostSessions: Identifiable {
        let host: GatewayHost
        var sessions: [MacExternalSession]
        var id: String { host.id }
    }

    enum Phase: Equatable {
        case idle, loading, loaded
        /// 所有 Mac 都没连上(带第一条原因)。
        case failed(String)
    }

    @Published private(set) var groups: [HostSessions] = []
    @Published private(set) var phase: Phase = .idle
    /// 支持接管的 Mac(落盘:下次冷启动入口直接出现,不等探测)。
    @Published private(set) var supportedHostIds: Set<String>

    private static let supportedKey = "leo.takeover.supportedHosts"
    private var lastRefresh: Date?
    private var inFlight: Task<Void, Never>?

    private init() {
        supportedHostIds = Set(UserDefaults.standard.stringArray(forKey: Self.supportedKey) ?? [])
    }

    /// 能看的 Mac:和「看屏」同一批(开着的、配了 harness 地址的 Mac)。
    static var candidates: [GatewayHost] { MacScreenHosts.candidates }

    func isSupported(_ hostIds: [String]? = nil) -> Bool {
        let ids = hostIds ?? Self.candidates.map(\.id)
        return ids.contains(where: supportedHostIds.contains)
    }

    /// 有 Mac 终端里还开着的会话(首页入口上的小绿点)。已接管的不算:那是手机这边在续写同一个文件。
    func hasRunning(_ hostIds: [String]? = nil) -> Bool {
        groups.contains { group in
            (hostIds?.contains(group.host.id) ?? true) && group.sessions.contains { $0.running && $0.leobotSessionId == nil }
        }
    }

    /// 首页 / 远程机器页出现时探一下;`force` 用于下拉刷新与打开列表。
    func refresh(force: Bool = false) async {
        if !force, let lastRefresh, Date().timeIntervalSince(lastRefresh) < 60 { return }
        if let inFlight { return await inFlight.value }
        let task = Task { await self.load() }
        inFlight = task
        await task.value
        inFlight = nil
    }

    private func load() async {
        let hosts = Self.candidates
        guard !hosts.isEmpty else {
            groups = []
            phase = .loaded
            return
        }
        if groups.isEmpty { phase = .loading }
        var loaded: [HostSessions] = []
        var supported = supportedHostIds
        var firstError: String?
        await withTaskGroup(of: (GatewayHost, Result<[MacExternalSession]?, Error>).self) { group in
            for host in hosts {
                guard let client = GatewayHostStore.shared.client(for: host) else { continue }
                group.addTask {
                    do { return (host, .success(try await client.externalSessions())) }
                    catch { return (host, .failure(error)) }
                }
            }
            for await (host, result) in group {
                switch result {
                case .success(.some(let sessions)):
                    supported.insert(host.id)
                    loaded.append(HostSessions(host: host, sessions: sessions))
                case .success(.none):
                    supported.remove(host.id)
                case .failure(let error):
                    // 连不上不等于不支持:保留上次的判断,别让入口忽隐忽现。
                    if firstError == nil, !LeoLinkProblem.isCancellation(error) {
                        firstError = AppLocalized("\(host.name)：\(error.localizedDescription)")
                    }
                }
            }
        }
        let order = hosts.map(\.id)
        groups = loaded.sorted { (order.firstIndex(of: $0.id) ?? 0) < (order.firstIndex(of: $1.id) ?? 0) }
        if supported != supportedHostIds {
            supportedHostIds = supported
            UserDefaults.standard.set(Array(supported), forKey: Self.supportedKey)
        }
        lastRefresh = Date()
        phase = loaded.isEmpty && firstError != nil ? .failed(firstError!) : .loaded
    }

    func takeOver(_ session: MacExternalSession, on host: GatewayHost) async throws -> MacTakeoverResult {
        guard let client = GatewayHostStore.shared.client(for: host) else { throw GatewayError.notConfigured }
        let result = try await client.takeOverExternalSession(session)
        // 列表里这一行标成「已接管」;首页「进行中」随 MacLiveSessionsStore 的下一轮刷新出现。
        if let index = groups.firstIndex(where: { $0.host.id == host.id }),
           let row = groups[index].sessions.firstIndex(where: { $0.id == session.id }) {
            let old = groups[index].sessions[row]
            groups[index].sessions[row] = MacExternalSession(
                id: old.id, agent: old.agent, cwd: old.cwd, title: old.title, updatedAt: old.updatedAt,
                running: old.running, leobotSessionId: result.sessionId)
        }
        return result
    }
}
