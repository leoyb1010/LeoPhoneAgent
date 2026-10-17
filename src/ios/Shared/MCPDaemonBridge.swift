import Foundation
import Network

/// [WP-46] App 与 iSH 里 MCP 守护进程(`leophoneagent-mcp-cli/daemon.py`)之间的两条细线。
///
/// 1. 可观测:守护进程每处理一次 call / tools / ping,往 `mcp-servers/calls.jsonl`(App Group,
///    guest 里是 `/var/minis/mcp-servers`)追加一行 `{ts, server, method, tool, ok, code, ms}`。
///    App 回前台 / 进后台时把它搬进 `diag-*.jsonl`(kind = `mcp.call`),之后删掉源文件。
///    真机取证时 MCP 成功率只能靠猜,就是因为这些结果从没进过 App 的日志。
/// 2. 省电:进后台且没有会话在跑时,让空闲的守护进程退出。取证里它在后台占了 60–87% CPU。
///    守护进程把端口也写进 `mcp-servers/daemon.port`;iSH 的 socket 直通宿主,127.0.0.1 就是本机。
enum MCPDaemonBridge {
    struct CallRow: Decodable, Equatable {
        let ts: Double
        let server: String
        let method: String
        let tool: String?
        let ok: Bool
        let code: String?
        let ms: Int
    }

    static let callsFileName = "calls.jsonl"
    static let portFileName = "daemon.port"

    /// 逐行解析;坏行跳过(守护进程被杀时最后一行可能只写了一半)。
    static func parse(_ data: Data) -> [CallRow] {
        let decoder = JSONDecoder()
        return data.split(separator: 0x0A).compactMap { try? decoder.decode(CallRow.self, from: Data($0)) }
    }

    static func event(for row: CallRow) -> DiagnosticRing.Event {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return DiagnosticRing.Event(
            ts: formatter.string(from: Date(timeIntervalSince1970: row.ts)),
            kind: DiagnosticRing.Kind.mcpCall.rawValue,
            durationMs: row.ms, server: String(row.server.prefix(80)), method: row.method,
            tool: row.tool.map { String($0.prefix(80)) }, ok: row.ok, code: row.code.map { String($0.prefix(40)) })
    }

    /// 把调用记录搬进诊断日志。先改名再读:守护进程每行都重新打开文件,改名之后的新记录
    /// 写进新文件,不会丢也不会重复。返回搬了几条。
    @discardableResult
    static func drainCallLog(in directory: URL, into ring: DiagnosticRing = .shared) -> Int {
        let fm = FileManager.default
        let source = directory.appendingPathComponent(callsFileName)
        guard fm.fileExists(atPath: source.path) else { return 0 }
        let claimed = directory.appendingPathComponent(callsFileName + ".draining")
        try? fm.removeItem(at: claimed)
        guard (try? fm.moveItem(at: source, to: claimed)) != nil,
              let data = try? Data(contentsOf: claimed) else { return 0 }
        try? fm.removeItem(at: claimed)
        let rows = parse(data)
        for row in rows { ring.record(event: event(for: row)) }
        return rows.count
    }

    /// 读守护进程公布的端口;没有、坏了或越界返回 nil。
    static func daemonPort(in directory: URL) -> UInt16? {
        guard let text = try? String(contentsOf: directory.appendingPathComponent(portFileName), encoding: .utf8),
              let value = Int(text.trimmingCharacters(in: .whitespacesAndNewlines)),
              (1...65535).contains(value) else { return nil }
        return UInt16(value)
    }

    /// 请空闲的守护进程退出(它答完 `{"ok":true}` 再走)。没在跑就什么也不发生。
    static func requestShutdown(in directory: URL, timeout: TimeInterval = 2) {
        guard let port = daemonPort(in: directory), let nwPort = NWEndpoint.Port(rawValue: port) else { return }
        let connection = NWConnection(host: "127.0.0.1", port: nwPort, using: .tcp)
        let queue = DispatchQueue(label: "com.leoyuan.leophoneagent.mcpDaemonShutdown")
        connection.stateUpdateHandler = { state in
            switch state {
            case .ready:
                connection.send(content: Data(#"{"cmd":"shutdown"}"#.utf8 + [0x0A]), completion: .contentProcessed { _ in
                    connection.receive(minimumIncompleteLength: 1, maximumLength: 512) { _, _, _, _ in connection.cancel() }
                })
            case .failed, .waiting:
                connection.cancel()   // 端口文件过期(守护进程被系统连同 App 杀掉过):无事可做
            default:
                break
            }
        }
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + timeout) { connection.cancel() }
    }
}
