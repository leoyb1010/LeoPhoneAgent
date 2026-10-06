import Foundation

// MARK: - 实时事件

/// 服务器 WebSocket 推送的事件外层：{id, companyId, type, createdAt, payload}。
/// 只解码需要的字段；payload 字段全部按需读取，缺失即视为 nil。
struct PaperclipLiveEvent: Decodable, Sendable, Equatable {
    let companyId: String
    let type: String
    let createdAt: String?
    let payload: [String: PaperclipJSON]

    private enum CodingKeys: String, CodingKey { case companyId, type, createdAt, payload }
    init(companyId: String, type: String, createdAt: String? = nil, payload: [String: PaperclipJSON]) {
        self.companyId = companyId; self.type = type; self.createdAt = createdAt; self.payload = payload
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        companyId = try values.decode(String.self, forKey: .companyId)
        type = try values.decode(String.self, forKey: .type)
        createdAt = try? values.decodeIfPresent(String.self, forKey: .createdAt)
        payload = (try? values.decodeIfPresent([String: PaperclipJSON].self, forKey: .payload)) ?? [:]
    }

    /// 文本帧解码；不是合法事件返回 nil（调用方忽略，不当作身份问题）。
    static func decode(_ text: String) -> PaperclipLiveEvent? {
        guard text.utf8.count <= 2_000_000 else { return nil }
        return try? JSONDecoder().decode(PaperclipLiveEvent.self, from: Data(text.utf8))
    }

    /// 在后台线程解码：通道推送整个公司的事件（含每秒数条、最大 8KB 的日志片段），
    /// 以前逐帧在主线程解析 JSON，事件密集时会拖慢详情页滚动。按到达顺序逐帧等待，顺序不变。
    static func decodeInBackground(_ text: String) async -> PaperclipLiveEvent? {
        await Task.detached(priority: .userInitiated) { decode(text) }.value
    }

    func string(_ key: String) -> String? {
        if case .string(let value)? = payload[key] { return value }
        return nil
    }
    func int(_ key: String) -> Int? {
        switch payload[key] {
        case .number(let value)?: return value.isFinite ? Int(value) : nil
        case .string(let value)?: return Int(value)
        default: return nil
        }
    }
    func bool(_ key: String) -> Bool? {
        if case .bool(let value)? = payload[key] { return value }
        return nil
    }
    var runID: String? { string("runId") }
    var issueID: String? { string("issueId") }
}

/// 运行中卡片的进度（来自 heartbeat.run.progress / heartbeat.run.event 或 live-runs 接口）。
struct PaperclipRunProgress: Equatable, Sendable {
    var phase: String?
    var message: String?
    var currentToolName: String?
    var lastAssistantSnippet: String?
    var lastEventAt: String?

    /// 事件只覆盖非空字段：工具结束后服务器可能不再带工具名，保留最近一次更直观。
    mutating func apply(_ event: PaperclipLiveEvent) {
        if let value = event.string("phase") { phase = value }
        if event.type == "heartbeat.run.progress", let value = event.string("message") { message = value }
        if let value = event.string("currentToolName"), !value.isEmpty { currentToolName = value }
        if let value = event.string("lastAssistantSnippet"), !value.isEmpty { lastAssistantSnippet = value }
        if let value = event.string("lastEventAt") { lastEventAt = value }
    }
}

// MARK: - 运行中的 run（GET /api/issues/:id/live-runs、/api/companies/:id/live-runs）

struct PaperclipLiveRun: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let status: String
    let agentId: String
    let agentName: String?
    let avatarUrl: String?
    let startedAt: String?
    let createdAt: String?
    let logBytes: Int?
    let currentStatusMessage: String?
    let currentToolName: String?
    let lastAssistantSnippet: String?
    let lastEventAt: String?
    /// 仅公司级 live-runs 返回；用于列表“运行中”标识和公司归属校验。
    let companyId: String?
    let issueId: String?

    var isActive: Bool { status == "queued" || status == "running" }
    var progress: PaperclipRunProgress {
        PaperclipRunProgress(phase: nil, message: currentStatusMessage, currentToolName: currentToolName,
                             lastAssistantSnippet: lastAssistantSnippet, lastEventAt: lastEventAt)
    }

    private enum CodingKeys: String, CodingKey {
        case id, status, agentId, agentName, avatarUrl, startedAt, createdAt, logBytes
        case currentStatusMessage, currentToolName, lastAssistantSnippet, lastEventAt, companyId, issueId
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        status = try values.decode(String.self, forKey: .status)
        agentId = try values.decode(String.self, forKey: .agentId)
        func text(_ key: CodingKeys) -> String? { try? values.decodeIfPresent(String.self, forKey: key) }
        agentName = text(.agentName); avatarUrl = text(.avatarUrl)
        startedAt = text(.startedAt); createdAt = text(.createdAt)
        currentStatusMessage = text(.currentStatusMessage); currentToolName = text(.currentToolName)
        lastAssistantSnippet = text(.lastAssistantSnippet); lastEventAt = text(.lastEventAt)
        companyId = text(.companyId); issueId = text(.issueId)
        // 数据库 bigint 可能序列化成数字或字符串，两种都接受，失败时不影响其余字段。
        if let number = try? values.decodeIfPresent(Int.self, forKey: .logBytes) { logBytes = number }
        else { logBytes = text(.logBytes).flatMap(Int.init) }
    }
}

// MARK: - 运行日志（NDJSON：每行 {"ts","stream","chunk"}）

struct PaperclipLogLine: Identifiable, Equatable, Sendable {
    enum Stream: String, Sendable { case stdout, stderr, system }
    let id: Int
    let stream: Stream
    var text: String
}

/// 把服务器原始 NDJSON 日志解析成可读文本：取 chunk、区分 stdout/stderr、去掉 ANSI 控制码。
/// 值类型：实时日志追加前保存快照，REST 补齐时回退快照再整段写入，避免重复。
struct PaperclipRunLogParser: Equatable, Sendable {
    private(set) var lines: [PaperclipLogLine] = []
    private var nextID = 0
    /// 上一段 NDJSON 末尾未完整的一条记录（64KB 分段可能切断一行）。
    private var pendingRecord = ""
    /// 最后一行是否尚未以换行结束（下一个同流片段接在后面）。
    private var lastLineOpen = false
    /// 已解析 NDJSON 记录里的最大 seq。服务器每条日志记录都带单调递增的 seq（与实时
    /// heartbeat.run.log 事件同一序号），用于把实时片段与 REST 读取结果去重、补齐。
    private(set) var maxSeq: Int?
    var maxLines = 1_500

    var isEmpty: Bool { lines.isEmpty }
    var text: String { lines.map(\.text).joined(separator: "\n") }

    /// - Parameter startsMidRecord: 从日志中间（尾部窗口）开始读取时，首个不完整记录直接丢弃。
    mutating func feedNDJSON(_ content: String, startsMidRecord: Bool = false) {
        var buffer = pendingRecord + content
        pendingRecord = ""
        if startsMidRecord {
            guard let newline = buffer.firstIndex(of: "\n") else { pendingRecord = ""; return }
            buffer = String(buffer[buffer.index(after: newline)...])
        }
        var records = buffer.components(separatedBy: "\n")
        // 最后一段没有换行结尾：可能是被分段截断的半条记录，留到下次拼接。
        pendingRecord = records.removeLast()
        if pendingRecord.utf8.count > 256_000 { pendingRecord = "" }
        for record in records where !record.isEmpty { consume(record) }
    }

    /// 把缓冲中最后一条可能完整的记录也解析出来（运行结束后的最终读取）。
    mutating func flush() {
        guard !pendingRecord.isEmpty else { return }
        let record = pendingRecord
        pendingRecord = ""
        consume(record)
    }

    mutating func appendChunk(_ chunk: String, stream raw: String?) {
        let stream = PaperclipLogLine.Stream(rawValue: raw ?? "") ?? .stdout
        let cleaned = Self.stripANSI(chunk).replacingOccurrences(of: "\r\n", with: "\n")
        guard !cleaned.isEmpty else { return }
        var pieces = cleaned.components(separatedBy: "\n")
        let endsWithNewline = pieces.last == ""
        if endsWithNewline { pieces.removeLast() }
        for (index, piece) in pieces.enumerated() {
            // 进度条用 \r 回到行首：终端最终显示的是最后一个 \r 之后的内容。
            let visible = piece.components(separatedBy: "\r").last ?? piece
            if index == 0, lastLineOpen, var last = lines.last, last.stream == stream {
                last.text += visible
                lines[lines.count - 1] = last
            } else {
                lines.append(PaperclipLogLine(id: nextID, stream: stream, text: visible))
                nextID += 1
            }
        }
        lastLineOpen = !endsWithNewline && !pieces.isEmpty
        if lines.count > maxLines { lines.removeFirst(lines.count - maxLines) }
    }

    private mutating func consume(_ record: String) {
        guard let data = record.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let chunk = object["chunk"] as? String else {
            // 不是 NDJSON 记录（旧版本或纯文本日志）：按普通输出显示，仍去掉控制码。
            appendChunk(record + "\n", stream: "stdout")
            return
        }
        if let seq = (object["seq"] as? NSNumber)?.intValue { maxSeq = max(maxSeq ?? seq, seq) }
        appendChunk(chunk, stream: object["stream"] as? String)
    }

    /// 去掉 CSI（颜色、光标）与 OSC（标题、超链接）序列，以及其余不可见控制字符。
    static func stripANSI(_ text: String) -> String {
        guard text.contains("\u{1B}") || text.unicodeScalars.contains(where: { $0.value < 0x20 && $0 != "\n" && $0 != "\r" && $0 != "\t" }) else { return text }
        var result = text
        for pattern in ["\u{1B}\\][^\u{07}\u{1B}]*(?:\u{07}|\u{1B}\\\\)", "\u{1B}\\[[0-?]*[ -/]*[@-~]", "\u{1B}[@-Z\\\\-_]"] {
            result = result.replacingOccurrences(of: pattern, with: "", options: .regularExpression)
        }
        return String(String.UnicodeScalarView(result.unicodeScalars.filter {
            $0.value >= 0x20 || $0 == "\n" || $0 == "\r" || $0 == "\t"
        }))
    }
}

// MARK: - 评论增量合并

enum PaperclipCommentMerge {
    /// 按 id 去重：同 id 以新数据为准（编辑），新评论按到达顺序追加。
    static func merge(_ existing: [PaperclipComment], _ incoming: [PaperclipComment]) -> [PaperclipComment] {
        guard !incoming.isEmpty else { return existing }
        var result = existing
        var index: [String: Int] = [:]
        for (offset, comment) in result.enumerated() { index[comment.id] = offset }
        for comment in incoming {
            if let offset = index[comment.id] { result[offset] = comment }
            else { index[comment.id] = result.count; result.append(comment) }
        }
        return result
    }
}

// MARK: - 实时通道重连退避

enum PaperclipLiveBackoff {
    /// 与网页端一致：1/2/4/8/15 秒，之后保持 15 秒。
    static let delays: [Double] = [1, 2, 4, 8, 15]
    static func delay(afterFailures failures: Int) -> Double {
        delays[min(max(failures, 1), delays.count) - 1]
    }
}

// MARK: - 时间

enum PaperclipDates {
    nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    nonisolated(unsafe) private static let plain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
    private static let lock = NSLock()
    static func parse(_ value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        lock.lock(); defer { lock.unlock() }
        return fractional.date(from: value) ?? plain.date(from: value)
    }
    /// 「2 分 13 秒」这样的中文耗时。
    static func duration(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds.rounded()))
        let hours = total / 3600, minutes = total % 3600 / 60, secs = total % 60
        if hours > 0 { return "\(hours) 小时 \(minutes) 分" }
        if minutes > 0 { return "\(minutes) 分 \(secs) 秒" }
        return "\(secs) 秒"
    }
    /// 计时器用的紧凑格式：1:05、12:30、1:02:03。
    static func clock(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds))
        let hours = total / 3600, minutes = total % 3600 / 60, secs = total % 60
        return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, secs) : String(format: "%d:%02d", minutes, secs)
    }
}

// MARK: - 头像地址

enum PaperclipAvatarPath {
    /// 只接受服务器预设头像路径；转成小尺寸，避免为 24pt 头像下载 512px 图。
    /// 绝对地址必须与配置同源，返回仅含路径与查询的同源相对地址。
    static func normalized(_ raw: String?, origin: URL) -> String? {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty,
              var parts = URLComponents(string: raw) else { return nil }
        if parts.scheme != nil || parts.host != nil {
            guard let url = parts.url, PaperclipProfile.sameOrigin(url, origin) else { return nil }
        }
        let path = parts.percentEncodedPath
        guard path.hasPrefix("/api/agent-avatars/"), path.hasSuffix(".png"), !path.contains(".."),
              !path.contains("//"), parts.fragment == nil else { return nil }
        parts.queryItems = [URLQueryItem(name: "size", value: "96"), URLQueryItem(name: "scale", value: "1")]
        return path + "?" + (parts.percentEncodedQuery ?? "")
    }
}

// MARK: - 对话线程

/// 线程条目：评论与已结束运行的摘要按时间交错；运行中的 run 与待审批卡片由页面放在末尾。
enum PaperclipThreadEntry: Identifiable, Equatable {
    /// header：同一作者连续消息的第一条（显示头像与名字）；footer：最后一条（显示时间）。
    case comment(PaperclipComment, header: Bool, footer: Bool)
    case run(PaperclipRun)

    var id: String {
        switch self {
        case .comment(let comment, _, _): return "comment-" + comment.id
        case .run(let run): return "run-" + run.runId
        }
    }
}

enum PaperclipThread {
    /// 同一作者 10 分钟内的连续消息合并显示头像与时间。
    static let groupingWindow: TimeInterval = 600

    static func authorKey(_ comment: PaperclipComment) -> String {
        let user = (comment.authorUserId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let agent = (comment.authorAgentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return user.isEmpty ? "agent:" + agent : "user:" + user
    }

    static func entries(comments: [PaperclipComment], runs: [PaperclipRun], activeRunIDs: Set<String>) -> [PaperclipThreadEntry] {
        enum Raw { case comment(PaperclipComment), run(PaperclipRun) }
        var timeline: [(date: Date, order: Int, raw: Raw)] = []
        var lastDate = Date.distantPast
        for (index, comment) in comments.enumerated() {
            // 缺时间的评论沿用前一条的时间，保持服务器返回顺序。
            let date = PaperclipDates.parse(comment.createdAt) ?? lastDate
            lastDate = date
            timeline.append((date, index, .comment(comment)))
        }
        for (index, run) in runs.enumerated() where !run.isActive && !activeRunIDs.contains(run.runId) {
            guard let date = PaperclipDates.parse(run.finishedAt ?? run.startedAt ?? run.createdAt) else { continue }
            timeline.append((date, comments.count + index, .run(run)))
        }
        timeline.sort { $0.date == $1.date ? $0.order < $1.order : $0.date < $1.date }

        var result: [PaperclipThreadEntry] = []
        for (index, item) in timeline.enumerated() {
            switch item.raw {
            case .run(let run): result.append(.run(run))
            case .comment(let comment):
                func sameGroup(_ other: Int) -> Bool {
                    guard timeline.indices.contains(other), case .comment(let neighbour) = timeline[other].raw else { return false }
                    return authorKey(neighbour) == authorKey(comment) && abs(timeline[other].date.timeIntervalSince(item.date)) <= groupingWindow
                }
                result.append(.comment(comment, header: !sameGroup(index - 1), footer: !sameGroup(index + 1)))
            }
        }
        return result
    }
}

// MARK: - 关注工单的运行跟踪（灵动岛与完成通知的事件来源）

/// [G2/G5] 关注工单（本机创建或正在查看）的运行变化。只消费已有的实时事件，不新增轮询；
/// 一个工单只跟踪最近一次运行，同一运行的终态只报告一次（重连补发、迟到事件都不会重复通知）。
struct PaperclipRunWatch: Equatable, Sendable {
    struct Run: Equatable, Sendable {
        let issueID: String
        let runID: String
        var status: String
        var agentID: String?
        var startedAt: Date?
        /// 当前阶段：工具名或进度消息。
        var stage: String?
        var isActive: Bool { status == "queued" || status == "running" }
    }
    enum Change: Equatable, Sendable {
        /// 开始运行或阶段变化。
        case active(Run)
        /// 运行结束（成功、失败、取消、超时），每个运行只出现一次。
        case finished(Run)
        var run: Run {
            switch self { case .active(let run), .finished(let run): return run }
        }
    }
    static let terminalStatuses: Set<String> = ["succeeded", "failed", "cancelled", "timed_out"]

    private(set) var runs: [String: Run] = [:]
    private var finished: Set<String> = []

    var hasActiveRun: Bool { runs.values.contains(where: \.isActive) }

    /// - Parameter watched: 关注的工单；已在跟踪的工单（例如从上次的实时活动接回的）继续跟踪。
    mutating func apply(_ event: PaperclipLiveEvent, watched: Set<String>, now: Date = Date()) -> Change? {
        guard let issueID = event.issueID, let runID = event.runID, !finished.contains(runID),
              watched.contains(issueID) || runs[issueID] != nil else { return nil }
        let existing = runs[issueID].flatMap { $0.runID == runID ? $0 : nil }
        switch event.type {
        case "heartbeat.run.queued", "heartbeat.run.status":
            guard let status = event.string("status") ?? (event.type == "heartbeat.run.queued" ? "queued" : nil) else { return nil }
            var run = existing ?? Run(issueID: issueID, runID: runID, status: status)
            run.status = status
            run.agentID = event.string("agentId") ?? run.agentID
            run.startedAt = run.startedAt ?? PaperclipDates.parse(event.string("startedAt")) ?? now
            if Self.terminalStatuses.contains(status) {
                finished.insert(runID)
                runs[issueID] = run
                return .finished(run)
            }
            guard run.isActive else { return nil }
            let changed = existing == nil || existing?.status != status
            runs[issueID] = run
            return changed ? .active(run) : nil
        case "heartbeat.run.progress":
            // 已在看的运行中工单没有开始事件：第一条进度即视为开始。
            var run = existing ?? Run(issueID: issueID, runID: runID, status: "running", startedAt: now)
            guard run.isActive else { return nil }
            let stage = Self.stage(event) ?? run.stage
            guard existing == nil || stage != run.stage else { return nil }
            run.stage = stage
            runs[issueID] = run
            return .active(run)
        default:
            return nil
        }
    }

    static func stage(_ event: PaperclipLiveEvent) -> String? {
        if let tool = event.string("currentToolName")?.trimmingCharacters(in: .whitespacesAndNewlines), !tool.isEmpty {
            return "正在使用 " + String(tool.prefix(40))
        }
        if let message = event.string("message")?.trimmingCharacters(in: .whitespacesAndNewlines), !message.isEmpty {
            return String(message.prefix(80))
        }
        return nil
    }

    /// 接回上次留下的运行中活动（App 重启后），以便补核终态；已结束或已在跟踪的不覆盖。
    mutating func adopt(_ run: Run) {
        guard run.isActive, !finished.contains(run.runID), runs[run.issueID] == nil else { return }
        runs[run.issueID] = run
    }

    /// 本地认为仍在运行、但公司级 live-runs 已经没有的工单：断线或后台期间错过了终态事件，需要补读一次运行列表。
    func staleActiveRuns(liveIssueIDs: Set<String>) -> [Run] {
        runs.values.filter { $0.isActive && !liveIssueIDs.contains($0.issueID) }.sorted { $0.issueID < $1.issueID }
    }

    /// 补读得到的终态；运行已被更新的运行取代或状态仍在进行时不变。
    mutating func resolve(issueID: String, runID: String, status: String) -> Change? {
        guard var run = runs[issueID], run.runID == runID, run.isActive, Self.terminalStatuses.contains(status),
              !finished.contains(runID) else { return nil }
        run.status = status
        finished.insert(runID)
        runs[issueID] = run
        return .finished(run)
    }
}
