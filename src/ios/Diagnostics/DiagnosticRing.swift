import Foundation

/// [B1] 常开的轻量诊断日志,不依赖「打开日志」开关。
///
/// JSON Lines 写到 `Library/Logs/diag-YYYY-MM-DD.jsonl`(按本地日期),保留 7 天,单日上限 2 MB
/// (超出后当天只再写一条 `diag.truncated` 标记)。后台串行队列写入,不阻塞调用方。
/// 只记结构化字段,不记对话正文;message 截断到 200 字。
///
/// 真机拉取:
/// xcrun devicectl device copy from --device <UDID> --domain-type appDataContainer \
///   --domain-identifier com.leoyuan.leophoneagent --source Library/Logs --destination /tmp/iphone-logs
final class DiagnosticRing: @unchecked Sendable {
    /// 预留的事件种类;新增种类直接加在这里。
    enum Kind: String, Sendable {
        case llmRequest = "llm.request"
        case llmSuccess = "llm.success"
        case llmError = "llm.error"
        case llmRetry = "llm.retry"
        case contextSignal = "context.signal"
        case contextDecision = "context.decision"
        case voiceLatency = "voice.latency"
        case shortcutRun = "shortcut.run"
        case truncated = "diag.truncated"
    }

    struct Event: Codable, Equatable, Sendable {
        var ts: String
        var kind: String
        var sessionId: String?
        var model: String?
        var entryId: String?
        var attempt: Int?
        var errorDomain: String?
        var errorCode: Int?
        var message: String?
        var durationMs: Int?
    }

    static let shared = DiagnosticRing(directory: FileManager.default
        .urls(for: .libraryDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Logs", isDirectory: true))

    let directory: URL
    let maxBytesPerDay: Int
    let retentionDays: Int
    private let now: @Sendable () -> Date
    private let queue = DispatchQueue(label: "com.leoyuan.leophoneagent.diagring", qos: .utility)
    private var lastPurgeDay: String?
    private var truncatedDay: String?

    init(directory: URL, maxBytesPerDay: Int = 2 * 1024 * 1024, retentionDays: Int = 7,
         now: @escaping @Sendable () -> Date = { Date() }) {
        self.directory = directory
        self.maxBytesPerDay = maxBytesPerDay
        self.retentionDays = retentionDays
        self.now = now
    }

    /// 记一条事件。`error` 只取 domain / code 和截断后的描述。
    func record(_ kind: Kind, sessionId: String? = nil, model: String? = nil, entryId: String? = nil,
                attempt: Int? = nil, error: Error? = nil, message: String? = nil, durationMs: Int? = nil) {
        let date = now()
        let ns = error.map { $0 as NSError }
        let text = message ?? error.map { ($0 as? LocalizedError)?.errorDescription ?? $0.localizedDescription }
        let event = Event(ts: Self.timestamp(date), kind: kind.rawValue,
                          sessionId: sessionId.map { String($0.prefix(8)) }, model: model, entryId: entryId,
                          attempt: attempt, errorDomain: ns?.domain, errorCode: ns?.code,
                          message: text.map { String($0.prefix(200)) }, durationMs: durationMs)
        queue.async { self.write(event, at: date) }
    }

    /// 等队列里已提交的写入落盘(测试与导出前用)。
    func flush() { queue.sync {} }

    func fileURL(for date: Date) -> URL {
        directory.appendingPathComponent("diag-\(Self.day(date)).jsonl")
    }

    // MARK: 写入(只在串行队列上)

    private func write(_ event: Event, at date: Date) {
        let fm = FileManager.default
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let day = Self.day(date)
        if lastPurgeDay != day { purge(before: date); lastPurgeDay = day }
        let url = fileURL(for: date)
        guard var line = try? Self.encoder.encode(event) else { return }
        line.append(0x0A)
        let size = (try? fm.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        if size + line.count > maxBytesPerDay {
            // 超限:当天只留一条截断标记,之后的事件丢弃,不让日志挤占存储。
            guard truncatedDay != day else { return }
            truncatedDay = day
            let marker = Event(ts: event.ts, kind: Kind.truncated.rawValue, message: "单日上限 \(maxBytesPerDay) 字节已满")
            guard var data = try? Self.encoder.encode(marker) else { return }
            data.append(0x0A)
            append(data, to: url)
            return
        }
        append(line, to: url)
    }

    private func append(_ data: Data, to url: URL) {
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
        } else {
            try? data.write(to: url, options: .atomic)
        }
    }

    /// 删掉 retentionDays 天之前的 diag-*.jsonl(按文件名里的日期,不看修改时间)。
    private func purge(before date: Date) {
        guard let oldest = Calendar.current.date(byAdding: .day, value: -(retentionDays - 1),
                                                 to: Calendar.current.startOfDay(for: date)) else { return }
        let cutoff = Self.day(oldest)
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        for name in names where name.hasPrefix("diag-") && name.hasSuffix(".jsonl") {
            let day = String(name.dropFirst(5).dropLast(6))
            if day < cutoff { try? FileManager.default.removeItem(at: directory.appendingPathComponent(name)) }
        }
    }

    // MARK: 格式

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()

    static func day(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}
