//
//  SessionStore.swift
//  LeoAgentMac
//
//  One harness session, live. Owns the resumable event stream (replay from
//  lastSeq, then follow), the transcript it renders, and the three controls
//  (send / approve / stop).
//
//  Swift 6 note: URLSession.AsyncBytes is not Sendable, so the read loop
//  lives entirely inside this @MainActor type — the awaits suspend, they do
//  not hop isolation.
//

import Foundation

struct TranscriptItem: Identifiable {
    enum Kind {
        case user, assistant, reasoning, info
        case toolRunning, toolDone, toolError
        case approval, done, failed, cancelled
    }
    let id: String
    var kind: Kind
    var text: String
    var detail: String = ""
    var approvalId: String?
    var choices: [String] = []
    var answered: String?    // the choice, once resolved
}

@MainActor
final class SessionStore: ObservableObject {
    @Published private(set) var items: [TranscriptItem] = []
    @Published private(set) var status = "…"
    @Published private(set) var pendingApprovals: [String] = []  // approval item ids
    @Published private(set) var lastError: String?
    @Published private(set) var detached = false

    let sessionId: String
    let harnessName: String
    let cwd: String

    private let baseURL: URL
    private let key: String
    private var lastSeq = 0
    private var streamTask: Task<Void, Never>?
    // tool_use_id → item id, so completions close the right card even when
    // several tools run at once.
    private var runningTools: [String: String] = [:]

    // Sticky: a session that was already dead when we attached must not be
    // resurrected by replaying its own history (session.created → "running").
    private let bornReadOnly: Bool

    var isReadOnly: Bool {
        bornReadOnly || ["orphaned", "completed", "failed", "cancelled"].contains(status)
    }

    init(sessionId: String, harnessName: String, cwd: String, status: String,
         baseURL: URL, key: String) {
        self.sessionId = sessionId
        self.harnessName = harnessName
        self.cwd = cwd
        self.status = status
        self.bornReadOnly = ["orphaned", "completed", "failed", "cancelled"].contains(status)
        self.baseURL = baseURL
        self.key = key
        start()
    }

    func start() {
        guard streamTask == nil else { return }
        detached = false
        streamTask = Task { await follow() }
    }

    func shutdown() {
        streamTask?.cancel()
        streamTask = nil
    }

    /// Manual retry after the stream gave up.
    func reattach() {
        shutdown()
        start()
    }

    // MARK: - Stream

    private func follow() async {
        var attempt = 0
        while !Task.isCancelled {
            do {
                var req = URLRequest(url: baseURL.appendingPathComponent(
                    "harness/sessions/\(sessionId)/events"))
                req.url = req.url.flatMap {
                    var parts = URLComponents(url: $0, resolvingAgainstBaseURL: false)
                    parts?.queryItems = [URLQueryItem(name: "after", value: String(lastSeq))]
                    return parts?.url
                }
                req.timeoutInterval = 3600
                req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
                let (bytes, response) = try await URLSession.shared.bytes(for: req)
                guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                    throw URLError(.badServerResponse)
                }
                lastError = nil
                for try await line in bytes.lines {
                    guard line.hasPrefix("data: "),
                          let data = String(line.dropFirst(6)).data(using: .utf8),
                          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                    else { continue }
                    attempt = 0
                    apply(obj)
                }
                // Server closed the stream: finished or orphaned session ends
                // here by design. Reconnect only if it still looks alive.
                if isReadOnly { return }
            } catch {
                if Task.isCancelled { return }
            }
            attempt += 1
            if attempt > 6 {
                detached = true
                lastError = "连接不上,已停止自动重试"
                return
            }
            try? await Task.sleep(for: .seconds(min(30, 1 << attempt)))
        }
    }

    private func apply(_ obj: [String: Any]) {
        let seq = obj["seq"] as? Int ?? 0
        if seq > 0 {
            guard seq > lastSeq else { return }   // replay overlap
            lastSeq = seq
        }
        let itemId = "e\(seq)"
        switch obj["event"] as? String ?? "" {
        case "session.created":
            if !bornReadOnly { status = "running" }
            items.append(TranscriptItem(id: itemId, kind: .info,
                text: "会话开始 · \(obj["name"] as? String ?? harnessName)",
                detail: obj["cwd"] as? String ?? cwd))
        case "user.message":
            items.append(TranscriptItem(id: itemId, kind: .user,
                text: obj["text"] as? String ?? ""))
            if !isReadOnly { status = "running" }
        case "message.delta":
            appendText(obj["delta"] as? String ?? "", kind: .assistant, id: itemId)
        case "reasoning.available":
            appendText(obj["text"] as? String ?? "", kind: .reasoning, id: itemId)
        case "tool.started":
            let item = TranscriptItem(id: itemId, kind: .toolRunning,
                text: obj["tool"] as? String ?? "tool",
                detail: obj["preview"] as? String ?? "")
            items.append(item)
            if let toolUseId = obj["tool_use_id"] as? String {
                runningTools[toolUseId] = itemId
            }
        case "tool.completed":
            closeTool(obj)
        case "approval.request":
            let approvalId = obj["approval_id"] as? String
            items.append(TranscriptItem(id: itemId, kind: .approval,
                text: obj["command"] as? String ?? "",
                detail: obj["description"] as? String ?? "",
                approvalId: approvalId,
                choices: obj["choices"] as? [String] ?? ["once", "deny"]))
            pendingApprovals.append(itemId)
            status = "waiting_for_approval"
        case "approval.responded":
            let answeredId = obj["approval_id"] as? String
            for index in items.indices where items[index].kind == .approval
                    && items[index].answered == nil
                    && (answeredId == nil || items[index].approvalId == answeredId) {
                items[index].answered = obj["choice"] as? String ?? "?"
                pendingApprovals.removeAll { $0 == items[index].id }
                break
            }
            if pendingApprovals.isEmpty && !isReadOnly { status = "running" }
        case "run.completed":
            let usage = obj["usage"] as? [String: Any]
            let tokens = (usage?["input_tokens"] as? Int).flatMap { input in
                (usage?["output_tokens"] as? Int).map { "· \(input)→\($0) tokens" }
            } ?? ""
            items.append(TranscriptItem(id: itemId, kind: .done, text: "回合完成 \(tokens)"))
            if !isReadOnly { status = "idle" }
        case "run.failed":
            items.append(TranscriptItem(id: itemId, kind: .failed,
                text: obj["error"] as? String ?? "失败"))
            if !isReadOnly { status = "idle" }
        case "run.cancelled":
            items.append(TranscriptItem(id: itemId, kind: .cancelled, text: "已停止"))
            status = "cancelled"
        case "harness.stderr", "harness.stdout":
            appendText(obj["text"] as? String ?? "", kind: .info, id: itemId, joiner: "\n")
        default:
            break   // unmodelled event families stay in the log, not the UI
        }
    }

    private func appendText(_ text: String, kind: TranscriptItem.Kind, id: String,
                            joiner: String = "") {
        guard !text.isEmpty else { return }
        if let last = items.indices.last, items[last].kind == kind {
            items[last].text += joiner + text
        } else {
            items.append(TranscriptItem(id: id, kind: kind, text: text))
        }
    }

    private func closeTool(_ obj: [String: Any]) {
        let failed = obj["error"] as? Bool ?? false
        let name = obj["tool"] as? String ?? "tool"
        var targetIndex: Int?
        if let toolUseId = obj["tool_use_id"] as? String,
           let itemId = runningTools.removeValue(forKey: toolUseId) {
            targetIndex = items.firstIndex { $0.id == itemId }
        } else {
            targetIndex = items.lastIndex { $0.kind == .toolRunning && $0.text == name }
                ?? items.lastIndex { $0.kind == .toolRunning }
        }
        if let index = targetIndex {
            items[index].kind = failed ? .toolError : .toolDone
        }
    }

    // MARK: - Controls

    func send(_ text: String) async -> Bool {
        await post("harness/sessions/\(sessionId)/send", body: ["text": text]) != nil
    }

    func approve(approvalId: String?, choice: String) async {
        var body: [String: Any] = ["choice": choice]
        if let approvalId { body["approval_id"] = approvalId }
        if await post("harness/sessions/\(sessionId)/approval", body: body) == nil {
            // Server refused (undeliverable) — the card stays, honestly.
            lastError = lastError ?? "审批没有送达 CLI"
        }
    }

    func stop() async {
        _ = await post("harness/sessions/\(sessionId)/stop", body: [:])
    }

    private func post(_ path: String, body: [String: Any]) async -> [String: Any]? {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.timeoutInterval = 15
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        guard let (data, response) = try? await URLSession.shared.data(for: req),
              let http = response as? HTTPURLResponse else {
            lastError = "无法连接本机服务"
            return nil
        }
        guard http.statusCode == 200 else {
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let message = (obj?["error"] as? [String: Any])?["message"] as? String
            lastError = message ?? "请求失败 (\(http.statusCode))"
            return nil
        }
        lastError = nil
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}
