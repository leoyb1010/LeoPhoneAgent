import Foundation

// [T-subagent] Ported from upstream iOS 1.14 (`[T-p3-agent-callback-cell]`),
// minus the scheduled-task envelope LeoBot does not have.
//
// Wire format for the messages a background sub agent injects into its parent
// conversation. They travel as USER messages (every provider accepts those and
// the model already reads them as "something happened"), wrapped in one fixed
// XML element so that
//   - the model can tell a system-injected callback from a human message, and
//   - the UI renders it as a callback card (AgentCallbackCellView) instead of a
//     right-aligned user bubble.
//
//   <agent_callback kind="finished" job="…" session="…" title="…" status="done" …>
//   <summary>tools … · turns … · tokens …</summary>
//   <result>
//   …the agent's final answer…
//   </result>
//   </agent_callback>
struct AgentCallback: Equatable {
    enum Kind: String {
        case progress
        case finished
    }

    static let tag = "agent_callback"

    let kind: Kind
    let jobId: String
    let childSessionId: String?
    let title: String
    /// running · done · no_deliverable · cancelled · timeout · failed
    let status: String
    /// Where the model came from (`pinned` / `inherited` / …).
    let tier: String?
    /// Display name of the sub agent definition that ran this job.
    let agent: String?
    let elapsed: String?
    let summary: String?
    let body: String
    /// One line about the OTHER sub agents of this conversation.
    var siblings: String?
    var modelIdentity: HelperModelIdentity? = nil

    init(kind: Kind, jobId: String, childSessionId: String?, title: String, status: String,
         tier: String?, elapsed: String?, summary: String?, body: String,
         siblings: String? = nil, modelIdentity: HelperModelIdentity? = nil, agent: String? = nil) {
        self.kind = kind; self.jobId = jobId; self.childSessionId = childSessionId
        self.title = title; self.status = status; self.tier = tier; self.agent = agent
        self.elapsed = elapsed; self.summary = summary; self.body = body
        self.siblings = siblings; self.modelIdentity = modelIdentity
    }

    static let identityAttrs: [String] = [
        "model_resolved", "model_resolved_entry_id", "model_resolved_provider",
        "model_resolved_id", "model_resolved_name",
        "model_effective", "model_effective_entry_id", "model_effective_provider",
        "model_effective_id", "model_effective_name", "model_effective_source", "model_response",
    ]

    // MARK: Detection

    static func isCallbackText(_ text: String) -> Bool {
        text.hasPrefix("<\(tag) ") || text.hasPrefix("<\(tag)>")
    }

    static func bodyTag(for kind: Kind) -> String {
        kind == .finished ? "result" : "last_message"
    }

    // MARK: Serialisation

    var xml: String {
        var attrs: [(String, String)] = [("kind", kind.rawValue), ("job", jobId)]
        if let childSessionId, !childSessionId.isEmpty { attrs.append(("session", childSessionId)) }
        attrs.append(("title", title))
        attrs.append(("status", status))
        if let tier, !tier.isEmpty { attrs.append(("model", tier)) }
        if let agent, !agent.isEmpty { attrs.append(("agent", agent)) }
        if let elapsed, !elapsed.isEmpty { attrs.append(("elapsed", elapsed)) }
        if let id = modelIdentity {
            let payload = id.payload()
            for key in Self.identityAttrs {
                if let v = payload[key] as? String, !v.isEmpty { attrs.append((key, v)) }
            }
        }
        let open = "<\(Self.tag) " + attrs.map { "\($0.0)=\"\(Self.escapeAttr($0.1))\"" }.joined(separator: " ") + ">"
        var lines: [String] = [open]
        if let summary, !summary.isEmpty { lines.append("<summary>\(Self.escapeText(summary))</summary>") }
        if let siblings, !siblings.isEmpty { lines.append("<other_sub_agents>\(Self.escapeText(siblings))</other_sub_agents>") }
        let bodyTag = Self.bodyTag(for: kind)
        lines.append("<\(bodyTag)>")
        // The child's text is escaped: a deliverable that happens to contain
        // `</agent_callback>` or a forged opening tag must not be able to end
        // the envelope early or impersonate another callback.
        lines.append(Self.escapeText(body))
        lines.append("</\(bodyTag)>")
        lines.append("</\(Self.tag)>")
        return lines.joined(separator: "\n")
    }

    // MARK: Parsing

    static func parse(_ text: String) -> AgentCallback? {
        guard isCallbackText(text), let openEnd = text.firstIndex(of: ">") else { return nil }
        let open = String(text[text.index(text.startIndex, offsetBy: tag.count + 1)..<openEnd])
        let attrs = parseAttributes(open)
        guard let kindRaw = attrs["kind"], let kind = Kind(rawValue: kindRaw),
              let jobId = attrs["job"] else { return nil }
        let inner: Substring = {
            let after = text[text.index(after: openEnd)...]
            if let close = after.range(of: "</\(tag)>", options: .backwards) {
                return after[after.startIndex..<close.lowerBound]
            }
            return after
        }()
        let summary = element("summary", in: inner).map(unescapeText)
        let siblings = element("other_sub_agents", in: inner).map(unescapeText)
        let rawBody = element(bodyTag(for: kind), in: inner) ?? String(inner).trimmingCharacters(in: .whitespacesAndNewlines)
        var identityPayload: [String: Any] = [:]
        for key in identityAttrs { if let v = attrs[key] { identityPayload[key] = v } }
        if let tier = attrs["model"] { identityPayload["model_origin"] = tier }
        return AgentCallback(kind: kind,
                             jobId: jobId,
                             childSessionId: attrs["session"],
                             title: attrs["title"] ?? "",
                             status: attrs["status"] ?? (kind == .finished ? "done" : "running"),
                             tier: attrs["model"],
                             elapsed: attrs["elapsed"],
                             summary: summary,
                             body: unescapeText(rawBody),
                             siblings: siblings,
                             modelIdentity: HelperModelIdentity(payload: identityPayload),
                             agent: attrs["agent"])
    }

    /// One-line stand-in for previews, where the raw XML would be noise.
    var previewLine: String {
        let head = kind == .finished ? String(localized: "子代理结果") : String(localized: "子代理进度")
        return "\(head) · \(title) · \(Self.localizedStatus(status))"
    }

    static func localizedStatus(_ status: String) -> String {
        switch status {
        case "running": return String(localized: "运行中")
        case "done", "completed": return String(localized: "已完成")
        case "no_deliverable": return String(localized: "无结果")
        case "cancelled": return String(localized: "已取消")
        case "timeout": return String(localized: "已超时")
        case "failed": return String(localized: "失败")
        case "rejected": return String(localized: "被拒绝")
        case "queued": return String(localized: "排队中")
        default: return status
        }
    }

    // MARK: Helpers

    private static func parseAttributes(_ s: String) -> [String: String] {
        var out: [String: String] = [:]
        var rest = Substring(s)
        while let eq = rest.firstIndex(of: "=") {
            let key = rest[rest.startIndex..<eq].trimmingCharacters(in: .whitespaces)
            let afterEq = rest[rest.index(after: eq)...]
            guard let q1 = afterEq.firstIndex(of: "\"") else { break }
            let valStart = afterEq.index(after: q1)
            guard let q2 = afterEq[valStart...].firstIndex(of: "\"") else { break }
            out[key] = unescapeText(String(afterEq[valStart..<q2]))
            rest = afterEq[afterEq.index(after: q2)...]
        }
        return out
    }

    private static func element(_ name: String, in s: Substring) -> String? {
        guard let open = s.range(of: "<\(name)>"),
              let close = s.range(of: "</\(name)>", options: .backwards),
              open.upperBound <= close.lowerBound else { return nil }
        return String(s[open.upperBound..<close.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func escapeAttr(_ s: String) -> String {
        escapeText(s).replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "\n", with: " ")
    }

    private static func escapeText(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }

    private static func unescapeText(_ s: String) -> String {
        s.replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&amp;", with: "&")
    }
}
