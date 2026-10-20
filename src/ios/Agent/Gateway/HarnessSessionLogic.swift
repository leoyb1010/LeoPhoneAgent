import Foundation

// Mac 会话页的纯逻辑(编进 App 和 MinisTests):权限模式、改动面板的数据、统一 diff 解析、
// 正文增量合并、没有 Mac 会话时(建会话中 / SSH 兜底一轮在跑)的消息排队。界面见 GatewayViews / HarnessChangesView。

// MARK: - 权限模式(Leo Link `POST /harness/sessions/:id/mode`)

enum HarnessMode: String, CaseIterable, Sendable {
    case plan, guarded, build, yolo

    /// 没有显式选过时沿用全自动开关:开 → 全自动,关 → 自主。
    static func fallback(fullAutoOn: Bool) -> HarnessMode { fullAutoOn ? .yolo : .guarded }

    /// 「按计划执行」切到哪一档:全自动开着就全自动,否则自主。
    static func afterPlan(fullAutoOn: Bool) -> HarnessMode { fallback(fullAutoOn: fullAutoOn) }

    /// 会话摘要 / 事件里的 mode 字段;不认得的值当作没有(旧 Mac 不发)。
    static func parse(_ raw: Any?) -> HarnessMode? { (raw as? String).flatMap(HarnessMode.init(rawValue:)) }
}

// MARK: - 改动面板(`GET /changes`、`GET /diff`)

struct HarnessChangedFile: Identifiable, Hashable, Sendable {
    let path: String
    /// M / A / D / R / ?
    let status: String
    let additions: Int
    let deletions: Int
    var oldPath: String? = nil
    var id: String { path }
}

struct HarnessCheckpoint: Identifiable, Hashable, Sendable {
    let id: String
    let turn: Int
    let createdAt: Date?
    let label: String
}

struct HarnessChanges: Equatable, Sendable {
    var isRepo = false
    var cwd = ""
    var branch: String? = nil
    var files: [HarnessChangedFile] = []
    var checkpoints: [HarnessCheckpoint] = []

    var additions: Int { files.reduce(0) { $0 + $1.additions } }
    var deletions: Int { files.reduce(0) { $0 + $1.deletions } }

    static func parse(_ obj: [String: Any]) -> HarnessChanges {
        let iso = ISO8601DateFormatter()
        let isoFrac = ISO8601DateFormatter()
        isoFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let files = (obj["files"] as? [[String: Any]] ?? []).compactMap { row -> HarnessChangedFile? in
            guard let path = row["path"] as? String, !path.isEmpty else { return nil }
            let old = (row["old_path"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            return HarnessChangedFile(path: path, status: (row["status"] as? String).map { String($0.prefix(1)).uppercased() } ?? "M",
                                      additions: row["additions"] as? Int ?? 0, deletions: row["deletions"] as? Int ?? 0,
                                      oldPath: old)
        }
        let checkpoints = (obj["checkpoints"] as? [[String: Any]] ?? []).compactMap { row -> HarnessCheckpoint? in
            guard let id = row["id"] as? String, !id.isEmpty else { return nil }
            let raw = row["created_at"] as? String ?? ""
            return HarnessCheckpoint(id: id, turn: row["turn"] as? Int ?? 0,
                                     createdAt: iso.date(from: raw) ?? isoFrac.date(from: raw),
                                     label: row["label"] as? String ?? "")
        }
        // 新的一轮在最上面。
        return HarnessChanges(isRepo: obj["is_repo"] as? Bool ?? false, cwd: obj["cwd"] as? String ?? "",
                              branch: (obj["branch"] as? String).flatMap { $0.isEmpty ? nil : $0 },
                              files: files, checkpoints: checkpoints.sorted { $0.turn > $1.turn })
    }
}

struct HarnessFileDiff: Equatable, Sendable {
    let path: String
    let diff: String
    let truncated: Bool
    let binary: Bool

    static func parse(_ obj: [String: Any], path: String) -> HarnessFileDiff {
        HarnessFileDiff(path: obj["path"] as? String ?? path, diff: obj["diff"] as? String ?? "",
                        truncated: obj["truncated"] as? Bool ?? false, binary: obj["binary"] as? Bool ?? false)
    }
}

// MARK: - 统一 diff 解析

struct UnifiedDiffLine: Hashable, Sendable {
    enum Kind: Sendable { case meta, hunk, context, added, removed, noNewline }
    let kind: Kind
    /// 去掉了 +/-/空格 前缀的正文(meta / hunk 行是整行)。
    let text: String
    let oldNumber: Int?
    let newNumber: Int?
    /// 字内高亮:这一行里真正改动的那一段(按字符下标);整行都不同时为 nil。
    var highlight: Range<Int>? = nil
}

enum UnifiedDiff {
    /// 按 hunk 头里的行数走,而不是看行首:hunk 里内容以 `--`/`++` 开头的行不会被当成文件头。
    static func parse(_ raw: String) -> [UnifiedDiffLine] {
        var out: [UnifiedDiffLine] = []
        var oldLine = 0, newLine = 0, oldLeft = 0, newLeft = 0
        var lines = raw.components(separatedBy: "\n")
        if lines.last == "" { lines.removeLast() }
        for rawLine in lines {
            let line = rawLine.hasSuffix("\r") ? String(rawLine.dropLast()) : rawLine
            let inHunk = oldLeft > 0 || newLeft > 0
            if inHunk {
                if line.hasPrefix("+") {
                    out.append(.init(kind: .added, text: String(line.dropFirst()), oldNumber: nil, newNumber: newLine))
                    newLine += 1; newLeft -= 1
                    continue
                }
                if line.hasPrefix("-") {
                    out.append(.init(kind: .removed, text: String(line.dropFirst()), oldNumber: oldLine, newNumber: nil))
                    oldLine += 1; oldLeft -= 1
                    continue
                }
                if line.hasPrefix(" ") || line.isEmpty {
                    out.append(.init(kind: .context, text: String(line.dropFirst()), oldNumber: oldLine, newNumber: newLine))
                    oldLine += 1; newLine += 1; oldLeft -= 1; newLeft -= 1
                    continue
                }
            }
            if line.hasPrefix("\\") {
                out.append(.init(kind: .noNewline, text: line, oldNumber: nil, newNumber: nil))
            } else if let header = hunkHeader(line) {
                (oldLine, oldLeft, newLine, newLeft) = header
                out.append(.init(kind: .hunk, text: line, oldNumber: nil, newNumber: nil))
            } else {
                // 计数没对上的 hunk(截断的 diff)到这里也就结束了。
                oldLeft = 0; newLeft = 0
                out.append(.init(kind: .meta, text: line, oldNumber: nil, newNumber: nil))
            }
        }
        return markIntraLine(out)
    }

    /// `@@ -a,b +c,d @@`:返回 (旧起始, 旧行数, 新起始, 新行数);省略的行数是 1。
    static func hunkHeader(_ line: String) -> (Int, Int, Int, Int)? {
        guard line.hasPrefix("@@ ") else { return nil }
        let parts = line.split(separator: " ")
        guard parts.count >= 3, parts[1].hasPrefix("-"), parts[2].hasPrefix("+") else { return nil }
        func range(_ s: Substring) -> (Int, Int)? {
            let nums = s.dropFirst().split(separator: ",", omittingEmptySubsequences: false)
            guard let start = Int(nums[0]) else { return nil }
            let count = nums.count > 1 ? Int(nums[1]) : 1
            guard let count else { return nil }
            return (start, count)
        }
        guard let old = range(parts[1]), let new = range(parts[2]) else { return nil }
        return (old.0, old.1, new.0, new.1)
    }

    /// 一段「删若干行紧跟加若干行」逐行配对,公共前后缀以外的部分是改动;改动占了大半行就不标(整行都换了,标了也是噪声)。
    static func markIntraLine(_ lines: [UnifiedDiffLine]) -> [UnifiedDiffLine] {
        var out = lines
        var i = 0
        while i < out.count {
            guard out[i].kind == .removed else { i += 1; continue }
            var removedEnd = i
            while removedEnd < out.count, out[removedEnd].kind == .removed { removedEnd += 1 }
            var addedEnd = removedEnd
            while addedEnd < out.count, out[addedEnd].kind == .added { addedEnd += 1 }
            // 行数不等时按顺序配前 min 行(多出来的是纯新增 / 纯删除)。
            for k in 0..<min(removedEnd - i, addedEnd - removedEnd) {
                if let (old, new) = changedRanges(old: out[i + k].text, new: out[removedEnd + k].text) {
                    out[i + k].highlight = old
                    out[removedEnd + k].highlight = new
                }
            }
            i = max(addedEnd, i + 1)
        }
        return out
    }

    static func changedRanges(old: String, new: String) -> (Range<Int>, Range<Int>)? {
        let a = Array(old), b = Array(new)
        guard !a.isEmpty, !b.isEmpty, a != b else { return nil }
        var prefix = 0
        while prefix < a.count, prefix < b.count, a[prefix] == b[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < a.count - prefix, suffix < b.count - prefix, a[a.count - 1 - suffix] == b[b.count - 1 - suffix] { suffix += 1 }
        guard prefix + suffix > 0 else { return nil }
        let oldRange = prefix..<(a.count - suffix), newRange = prefix..<(b.count - suffix)
        // 两边改动都超过 70% 就算整行替换。
        if oldRange.count * 10 > a.count * 7, newRange.count * 10 > b.count * 7 { return nil }
        return (oldRange, newRange)
    }
}

// MARK: - 正文增量合并

/// Mac 每个 token 一帧;每帧都改 `@Published items` 会让会话页每秒重排几十次。
/// 攒一小段(驱动里约 33ms)再一次性写进去;别的事件到来前先把攒着的冲掉,先后顺序不乱。
struct TextDeltaBuffer: Sendable {
    private(set) var pending = ""

    /// 返回 true = 这是攒批里的第一段,调用方该排一次冲刷。
    mutating func append(_ delta: String) -> Bool {
        guard !delta.isEmpty else { return false }
        let first = pending.isEmpty
        pending += delta
        return first
    }

    mutating func take() -> String? {
        guard !pending.isEmpty else { return nil }
        defer { pending = "" }
        return pending
    }
}

// MARK: - 没有 Mac 会话时的消息排队

/// 建会话请求还在路上,或 SSH 兜底的一轮还在跑:这时再发的消息排队,等这一轮结束再按顺序发,
/// 不能并发出两轮(SSH 兜底每轮是一条独立命令,并发就是两个 CLI 同时改同一个目录)。
struct PendingTurns: Sendable {
    private(set) var busy = false
    private(set) var queued: [String] = []

    /// 开始一轮(建会话或 SSH 兜底)。
    mutating func begin() { busy = true }

    /// 返回 true = 现在就能跑;false = 已排队。
    mutating func submit(_ text: String) -> Bool {
        if busy { queued.append(text); return false }
        busy = true
        return true
    }

    /// 这一轮结束:有排队的就交出下一条(调用方用它开新的一轮,会再 begin)。
    mutating func turnEnded() -> String? {
        busy = false
        return queued.isEmpty ? nil : queued.removeFirst()
    }

    /// Mac 会话建好了:排队的全部交出去当后续消息发。
    mutating func drain() -> [String] {
        busy = false
        defer { queued = [] }
        return queued
    }

    /// 停止 / 失败:排队的退还给输入框,不能静默丢掉。
    mutating func cancel() -> [String] { drain() }
}
