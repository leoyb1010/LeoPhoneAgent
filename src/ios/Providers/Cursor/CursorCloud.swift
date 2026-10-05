import Foundation
import Security
import SwiftUI

/// [T-cursor-cloud] 用 Cursor API Key 直连 Cursor Cloud Agents,花的是用户自己的 Cursor 额度。
///
/// 不是聊天模型:Agent 把编码任务派给 Cursor 托管的云端 VM,Cursor 在用户已连接的仓库上
/// 改代码、推 `cursor/...` 分支、按需开 PR。iOS 只发 HTTPS,不需要 Mac 在线。
/// 钥匙只存本机钥匙串(仅本设备、首次解锁后可用),不进 iCloud 同步。
enum CursorCloudClient {
    private static let service = "com.leoyuan.leophoneagent.cursor"
    private static let account = "api-key"

    enum CursorError: LocalizedError {
        case noKey
        case http(String)
        case malformed

        var errorDescription: String? {
            switch self {
            case .noKey: return "还没有填 Cursor API Key(设置 → Agent → Cursor 云端 Agent)。"
            case .http(let message): return message
            case .malformed: return "Cursor API 返回的内容无法解析。"
            }
        }
    }

    // MARK: 钥匙

    static var hasKey: Bool { apiKey != nil }

    static var apiKey: String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data,
              let key = String(data: data, encoding: .utf8),
              !key.isEmpty else { return nil }
        return key
    }

    /// 传 nil 或空串就删除。
    @discardableResult
    static func saveKey(_ key: String?) -> Bool {
        SecItemDelete(baseQuery as CFDictionary)
        Task { await repoCache.clear() }
        guard let key = key?.trimmingCharacters(in: .whitespacesAndNewlines), !key.isEmpty else { return true }
        var item = baseQuery
        item[kSecValueData as String] = Data(key.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
    }

    // MARK: 接口

    static func me() async throws -> [String: Any] {
        try await send("GET", "me")
    }

    static func modelIds() async throws -> [String] {
        let json = try await send("GET", "models")
        return (json["items"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
    }

    /// 已连接仓库。官方限流较紧,10 分钟内复用。
    static func repositories() async throws -> [String] {
        if let cached = await repoCache.fresh() { return cached }
        let json = try await send("GET", "repositories", timeout: 60)
        let urls = (json["items"] as? [[String: Any]] ?? []).compactMap { $0["url"] as? String }
        await repoCache.store(urls)
        return urls
    }

    static func listAgents(limit: Int) async throws -> [[String: Any]] {
        let json = try await send("GET", "agents",
                                  query: [URLQueryItem(name: "limit", value: String(min(max(limit, 1), 50)))])
        return json["items"] as? [[String: Any]] ?? []
    }

    static func agent(id: String) async throws -> [String: Any] {
        try await send("GET", "agents/\(id)")
    }

    static func run(agentId: String, runId: String) async throws -> [String: Any] {
        try await send("GET", "agents/\(agentId)/runs/\(runId)")
    }

    static func createAgent(body: [String: Any]) async throws -> (agent: [String: Any], run: [String: Any]?) {
        let json = try await send("POST", "agents", body: body, timeout: 60)
        guard let agent = json["agent"] as? [String: Any] else { throw CursorError.malformed }
        return (agent, json["run"] as? [String: Any])
    }

    static func followUp(agentId: String, body: [String: Any]) async throws -> [String: Any] {
        let json = try await send("POST", "agents/\(agentId)/runs", body: body, timeout: 60)
        guard let run = json["run"] as? [String: Any] else { throw CursorError.malformed }
        return run
    }

    static func cancel(agentId: String, runId: String) async throws {
        _ = try await send("POST", "agents/\(agentId)/runs/\(runId)/cancel")
    }

    /// 每 5 秒查一次 run,结束或到 `maxWait` 就返回最新状态。取消随 Task 生效。
    static func waitForRun(agentId: String, runId: String, maxWait: TimeInterval) async throws -> [String: Any] {
        let deadline = Date().addingTimeInterval(maxWait)
        var latest = try await run(agentId: agentId, runId: runId)
        while !CursorCloudAPI.isTerminal(runStatus: latest["status"] as? String), Date() < deadline {
            try await Task.sleep(nanoseconds: 5_000_000_000)
            latest = try await run(agentId: agentId, runId: runId)
        }
        return latest
    }

    private static func send(_ method: String, _ path: String, query: [URLQueryItem] = [],
                             body: [String: Any]? = nil, timeout: TimeInterval = 30) async throws -> [String: Any] {
        guard let key = apiKey else { throw CursorError.noKey }
        var components = URLComponents(url: CursorCloudAPI.baseURL.appendingPathComponent(path),
                                       resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.setValue(CursorCloudAPI.authorizationHeader(apiKey: key), forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw CursorError.malformed }
        guard (200..<300).contains(http.statusCode) else {
            throw CursorError.http(CursorCloudAPI.errorMessage(status: http.statusCode, body: data))
        }
        if data.isEmpty { return [:] }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw CursorError.malformed
        }
        return object
    }

    private static let repoCache = RepoCache()

    private actor RepoCache {
        private var urls: [String] = []
        private var fetchedAt: Date?

        func fresh() -> [String]? {
            guard let fetchedAt, Date().timeIntervalSince(fetchedAt) < 600 else { return nil }
            return urls
        }

        func store(_ urls: [String]) {
            self.urls = urls
            fetchedAt = Date()
        }

        func clear() {
            urls = []
            fetchedAt = nil
        }
    }
}

// MARK: - Agent 工具

enum CursorCloudTools {
    static let names: Set<String> = [
        "cursor_agent_launch", "cursor_agent_followup", "cursor_agent_status", "cursor_agent_cancel",
    ]

    static func execute(name: String, args: [String: Any]) async throws -> (output: String, success: Bool) {
        do {
            switch name {
            case "cursor_agent_launch": return try await launch(args)
            case "cursor_agent_followup": return try await followUp(args)
            case "cursor_agent_status": return try await status(args)
            case "cursor_agent_cancel": return try await cancel(args)
            default: return ("Error: Unknown tool '\(name)'", false)
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            return ("Error: \(error.localizedDescription)", false)
        }
    }

    private static func string(_ args: [String: Any], _ key: String) -> String? {
        guard let value = (args[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        return value
    }

    private static func int(_ args: [String: Any], _ key: String) -> Int? {
        if let n = args[key] as? Int { return n }
        if let n = args[key] as? NSNumber { return n.intValue }
        return (args[key] as? String).flatMap { Int($0) }
    }

    private static func bool(_ args: [String: Any], _ key: String) -> Bool? {
        if let b = args[key] as? Bool { return b }
        if let s = (args[key] as? String)?.lowercased() { return ["true", "1", "yes"].contains(s) }
        return nil
    }

    private static func launch(_ args: [String: Any]) async throws -> (output: String, success: Bool) {
        guard let prompt = string(args, "prompt") else { return ("Error: missing prompt.", false) }
        var repoURL: String?
        if let raw = string(args, "repo") {
            let connected = (try? await CursorCloudClient.repositories()) ?? []
            switch CursorCloudAPI.resolveRepo(raw, connected: connected) {
            case .resolved(let url):
                repoURL = url
            case .ambiguous(let matches):
                return ("Error: repo '\(raw)' matches several connected repositories: \(matches.joined(separator: ", ")). Pass the full URL.", false)
            case .notFound(let name):
                let sample = connected.prefix(30).joined(separator: "\n")
                return ("Error: no repository named '\(name)' is connected to Cursor. Connected repositories:\n\(sample.isEmpty ? "(none)" : sample)", false)
            }
        }
        let body = CursorCloudAPI.createAgentBody(
            prompt: prompt, repoURL: repoURL, startingRef: string(args, "ref"),
            modelId: string(args, "model"), autoCreatePR: bool(args, "auto_create_pr") ?? true,
            mode: string(args, "mode") == "plan" ? .plan : .agent)
        let (agent, run) = try await CursorCloudClient.createAgent(body: body)
        let summary = CursorCloudAPI.summarize(agent: agent, run: run)
        return (summary + "\n\nStarted. Use cursor_agent_status with this agent_id and wait_seconds to follow it.", true)
    }

    private static func followUp(_ args: [String: Any]) async throws -> (output: String, success: Bool) {
        guard let agentId = string(args, "agent_id") else { return ("Error: missing agent_id.", false) }
        guard let prompt = string(args, "prompt") else { return ("Error: missing prompt.", false) }
        let mode = string(args, "mode").flatMap(CursorCloudAPI.Mode.init(rawValue:))
        let run = try await CursorCloudClient.followUp(
            agentId: agentId, body: CursorCloudAPI.followUpBody(prompt: prompt, mode: mode))
        let runId = run["id"] as? String ?? "?"
        return ("agent_id: \(agentId)\nrun_id: \(runId)\nrun_status: \(run["status"] as? String ?? "CREATING")\n\nFollow-up queued. Use cursor_agent_status with wait_seconds to follow it.", true)
    }

    private static func status(_ args: [String: Any]) async throws -> (output: String, success: Bool) {
        guard let agentId = string(args, "agent_id") else {
            let items = try await CursorCloudClient.listAgents(limit: int(args, "limit") ?? 10)
            return (CursorCloudAPI.summarize(list: items), true)
        }
        let agent = try await CursorCloudClient.agent(id: agentId)
        guard let runId = string(args, "run_id") ?? (agent["latestRunId"] as? String) else {
            return (CursorCloudAPI.summarize(agent: agent, run: nil), true)
        }
        let wait = TimeInterval(min(max(int(args, "wait_seconds") ?? 0, 0), 600))
        let run = wait > 0
            ? try await CursorCloudClient.waitForRun(agentId: agentId, runId: runId, maxWait: wait)
            : try await CursorCloudClient.run(agentId: agentId, runId: runId)
        let status = (run["status"] as? String ?? "").uppercased()
        return (CursorCloudAPI.summarize(agent: agent, run: run), status != "ERROR")
    }

    private static func cancel(_ args: [String: Any]) async throws -> (output: String, success: Bool) {
        guard let agentId = string(args, "agent_id") else { return ("Error: missing agent_id.", false) }
        var runId = string(args, "run_id")
        if runId == nil {
            runId = try await CursorCloudClient.agent(id: agentId)["latestRunId"] as? String
        }
        guard let runId else { return ("Error: agent \(agentId) has no run to cancel.", false) }
        try await CursorCloudClient.cancel(agentId: agentId, runId: runId)
        return ("Cancel requested for \(agentId) run \(runId).", true)
    }
}

// MARK: - 设置页

struct CursorCloudSettingsView: View {
    @State private var keyInput = ""
    @State private var hasKey = CursorCloudClient.hasKey
    @State private var testing = false
    @State private var testResult: String?
    @State private var confirmDeleteKey = false

    var body: some View {
        Form {
            Section {
                if hasKey {
                    Label("已填好,只存在这台设备的钥匙串里", systemImage: "checkmark.seal.fill")
                        .foregroundStyle(.green)
                    Button(testing ? "测试中…" : "测一下") { Task { await test() } }
                        .disabled(testing)
                    Button("删除 Key", role: .destructive) {
                        confirmDeleteKey = true
                    }
                } else {
                    SecureField("粘贴 Cursor API Key(crsr_…)", text: $keyInput)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("保存并测试") {
                        guard CursorCloudClient.saveKey(keyInput) else {
                            testResult = "保存失败,请重试。"
                            return
                        }
                        keyInput = ""
                        hasKey = CursorCloudClient.hasKey
                        Task { await test() }
                    }
                    .disabled(keyInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if let testResult {
                    Text(testResult)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } footer: {
                Text("用你自己的 Cursor 额度把编码任务派给 Cursor 云端 Agent:它在你已连接到 Cursor 的仓库上改代码、推 cursor/ 分支,按需开 PR,不需要 Mac 在线。填好后 Agent 多四个工具:cursor_agent_launch、cursor_agent_followup、cursor_agent_status、cursor_agent_cancel。启动和追加任务会消耗额度,每次都要你确认。Key 在 cursor.com/dashboard → Integrations 生成。")
            }
        }
        .navigationTitle("Cursor 云端 Agent")
        .navigationBarTitleDisplayMode(.inline)
        .alert("删除 Cursor Key？", isPresented: $confirmDeleteKey) {
            Button("删除", role: .destructive) {
                CursorCloudClient.saveKey(nil)
                hasKey = false
                testResult = nil
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("删除后 Agent 不再有 cursor_agent_* 工具，要再用得重新粘贴 Key。")
        }
    }

    private func test() async {
        testing = true
        defer { testing = false }
        let start = Date()
        do {
            let me = try await CursorCloudClient.me()
            let models = try await CursorCloudClient.modelIds()
            let repos = try await CursorCloudClient.repositories()
            let ms = Int(Date().timeIntervalSince(start) * 1000)
            let who = me["userEmail"] as? String ?? me["apiKeyName"] as? String ?? "未知账号"
            testResult = "连接正常(\(ms) 毫秒):\(who),\(models.count) 个可用模型,\(repos.count) 个已连接仓库。"
        } catch {
            testResult = error.localizedDescription
        }
    }
}
