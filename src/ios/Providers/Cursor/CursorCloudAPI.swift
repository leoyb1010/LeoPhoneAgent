import Foundation

/// [T-cursor-cloud] Cursor Cloud Agents API v1 的纯逻辑:鉴权头、仓库解析、请求体、响应摘要、错误话术。
///
/// 只依赖 Foundation,单测直接编进 MinisTests;网络和钥匙串在 CursorCloud.swift。
/// 接口:https://api.cursor.com/v1,Basic 鉴权(key 作用户名、密码留空,等价 `curl -u KEY:`)。
/// 一个 agent 是持久会话,每次提示是它的一个 run;同一 agent 同时只能有一个活跃 run(否则 409 agent_busy)。
enum CursorCloudAPI {
    static let baseURL = URL(string: "https://api.cursor.com/v1")!

    /// run 进入这些状态后不再变化。
    static let terminalRunStatuses: Set<String> = ["FINISHED", "ERROR", "CANCELLED", "EXPIRED"]

    /// 交给模型的 run 结果上限;更长的完整内容在 cursor.com/agents 里看。
    static let maxResultChars = 8_000

    enum Mode: String {
        case agent
        case plan
    }

    static func authorizationHeader(apiKey: String) -> String {
        "Basic " + Data("\(apiKey):".utf8).base64EncodedString()
    }

    static func isTerminal(runStatus: String?) -> Bool {
        guard let runStatus else { return false }
        return terminalRunStatuses.contains(runStatus.uppercased())
    }

    // MARK: 仓库

    enum RepoResolution: Equatable {
        case resolved(String)
        case notFound(String)
        case ambiguous([String])
    }

    /// 接受完整 URL、`github.com/owner/repo`、`owner/repo` 或只有仓库名。
    /// `connected` 是 `GET /v1/repositories` 返回的 URL;只给仓库名时必须在其中唯一命中,
    /// 免得模型凭名字猜错仓库、让 Cursor 去改别人的代码。
    static func resolveRepo(_ raw: String, connected: [String]) -> RepoResolution {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix("/") { text.removeLast() }
        if text.lowercased().hasSuffix(".git") { text.removeLast(4) }
        guard !text.isEmpty else { return .notFound(raw) }

        if text.contains("://") { return .resolved(text) }

        let parts = text.split(separator: "/").map(String.init)
        if parts.count >= 3 || (parts.count == 2 && parts[0].contains(".")) {
            return .resolved("https://" + text)
        }

        let suffix = "/" + text.lowercased()
        let matches = connected.filter { url in
            var u = url.lowercased()
            while u.hasSuffix("/") { u.removeLast() }
            if u.hasSuffix(".git") { u.removeLast(4) }
            return u.hasSuffix(suffix)
        }
        if matches.count == 1 { return .resolved(matches[0]) }
        if matches.count > 1 { return .ambiguous(matches) }
        if parts.count == 2 { return .resolved("https://github.com/" + text) }
        return .notFound(text)
    }

    // MARK: 请求体

    static func createAgentBody(prompt: String, repoURL: String?, startingRef: String?,
                                modelId: String?, autoCreatePR: Bool, mode: Mode) -> [String: Any] {
        var body: [String: Any] = ["prompt": ["text": prompt]]
        if let repoURL, !repoURL.isEmpty {
            var repo: [String: Any] = ["url": repoURL]
            if let ref = startingRef?.trimmingCharacters(in: .whitespacesAndNewlines), !ref.isEmpty {
                repo["startingRef"] = ref
            }
            body["repos"] = [repo]
            body["autoCreatePR"] = autoCreatePR
        }
        if let model = explicitModel(modelId) {
            body["model"] = ["id": model]
        }
        if mode == .plan {
            body["mode"] = Mode.plan.rawValue
        }
        return body
    }

    static func followUpBody(prompt: String, mode: Mode?) -> [String: Any] {
        var body: [String: Any] = ["prompt": ["text": prompt]]
        if let mode {
            body["mode"] = mode.rawValue
        }
        return body
    }

    /// `auto` / `default` / 空串交给 Cursor 按用户默认模型解析,不显式传。
    static func explicitModel(_ raw: String?) -> String? {
        guard let id = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !id.isEmpty else { return nil }
        return ["auto", "default"].contains(id.lowercased()) ? nil : id
    }

    // MARK: 摘要

    static func summarize(agent: [String: Any], run: [String: Any]?) -> String {
        var lines: [String] = []
        if let id = agent["id"] as? String { lines.append("agent_id: \(id)") }
        if let name = agent["name"] as? String, !name.isEmpty { lines.append("name: \(name)") }
        if let status = agent["status"] as? String { lines.append("agent_status: \(status)") }
        if let url = agent["url"] as? String { lines.append("url: \(url)") }
        if let repos = agent["repos"] as? [[String: Any]] {
            for repo in repos {
                let url = repo["url"] as? String ?? "?"
                let ref = (repo["startingRef"] as? String).map { " @ \($0)" } ?? ""
                lines.append("repo: \(url)\(ref)")
            }
        }
        guard let run else {
            if let latest = agent["latestRunId"] as? String { lines.append("latest_run_id: \(latest)") }
            return lines.joined(separator: "\n")
        }
        if let id = run["id"] as? String { lines.append("run_id: \(id)") }
        let status = run["status"] as? String ?? "UNKNOWN"
        lines.append("run_status: \(status)\(isTerminal(runStatus: status) ? " (terminal)" : " (still running)")")
        if let ms = (run["durationMs"] as? NSNumber)?.doubleValue {
            lines.append("duration: \(String(format: "%.1f", ms / 1000))s")
        }
        if let git = run["git"] as? [String: Any], let branches = git["branches"] as? [[String: Any]] {
            for branch in branches {
                var line = "branch: \(branch["repoUrl"] as? String ?? "?")"
                if let name = branch["branch"] as? String { line += " → \(name)" }
                if let pr = branch["prUrl"] as? String { line += " (PR: \(pr))" }
                lines.append(line)
            }
        }
        if let result = run["result"] as? String, !result.isEmpty {
            let trimmed = result.count > maxResultChars
                ? String(result.prefix(maxResultChars)) + "\n…(truncated, full reply at the agent url)"
                : result
            lines.append("result:\n\(trimmed)")
        }
        return lines.joined(separator: "\n")
    }

    static func summarize(list items: [[String: Any]]) -> String {
        guard !items.isEmpty else { return "No Cursor cloud agents yet." }
        return items.map { item in
            let id = item["id"] as? String ?? "?"
            let status = item["status"] as? String ?? "?"
            let name = item["name"] as? String ?? ""
            let updated = item["updatedAt"] as? String ?? ""
            return "- \(id) [\(status)] \(name) (updated \(updated))"
        }.joined(separator: "\n")
    }

    // MARK: 错误

    /// 两种线格式都收:`{"error":{"code","message"}}` 与顶层 `{"code","message"}`。
    static func errorMessage(status: Int, body: Data) -> String {
        let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        let inner = json?["error"] as? [String: Any] ?? json
        let code = inner?["code"] as? String
        let message = inner?["message"] as? String
            ?? String(data: body.prefix(200), encoding: .utf8) ?? ""
        switch (status, code) {
        case (401, _):
            return "Cursor API Key 无效或已作废(HTTP 401),请在设置 → Cursor 云端 Agent 里重新填写。"
        case (409, "agent_busy"):
            return "这个 Cursor agent 上一轮还在运行(409 agent_busy)。先用 cursor_agent_status 等它结束,或用 cursor_agent_cancel 取消。"
        case (429, _):
            return "Cursor API 限流了(HTTP 429),稍后再试。"
        default:
            let label = code.map { " \($0)" } ?? ""
            return "Cursor API 返回 HTTP \(status)\(label):\(message)"
        }
    }
}
