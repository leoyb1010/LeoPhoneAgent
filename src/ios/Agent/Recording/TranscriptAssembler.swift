import Foundation

/// [V-rec] 转写的切分计划:每块音频按 ≤10 分钟的窗口转写(导入的长文件也一样),
/// 窗口是可恢复的最小单位 —— 转到一半退出,下次从没做完的窗口接着转。
enum TranscriptionPlan {
    static let windowSeconds: Double = 600

    struct Unit: Equatable, Sendable {
        /// 稳定编号:块序号 × 1000 + 窗口序号。
        let id: Int
        let chunkIndex: Int
        let fileName: String
        /// 窗口在这块文件里的起点(秒)。
        let localStart: Double
        let duration: Double
        /// 窗口在整条录音时间轴上的起点(秒)。
        let globalStart: Double
    }

    static func units(for chunks: [RecordingChunk], windowSeconds: Double = windowSeconds) -> [Unit] {
        let window = max(1, windowSeconds)
        var out: [Unit] = []
        for chunk in chunks.sorted(by: { $0.index < $1.index }) where chunk.duration > 0.05 {
            var local = 0.0
            var w = 0
            while local < chunk.duration - 0.05, w < 1000 {
                let length = min(window, chunk.duration - local)
                out.append(Unit(id: chunk.index * 1000 + w, chunkIndex: chunk.index, fileName: chunk.fileName,
                                localStart: local, duration: length, globalStart: chunk.startOffset + local))
                local += length
                w += 1
            }
        }
        return out
    }

    static func pending(_ units: [Unit], completed: [Int]) -> [Unit] {
        let done = Set(completed)
        return units.filter { !done.contains($0.id) }
    }
}

/// [V-rec] 把各个转写单元的分段合并成一条时间轴,并处理说话人标签。纯函数。
enum TranscriptAssembler {
    /// 引擎给出的一段:时间相对于这个单元的起点。
    struct LocalSegment: Equatable, Sendable {
        var start: Double
        var end: Double
        var text: String
    }

    // MARK: - Merge

    /// 用 `unit` 的新结果替换它旧的分段:平移到全局时间、夹进单元范围、去掉空白段,按开始时间排好。
    static func merge(existing: [TranscriptSegment], unit: TranscriptionPlan.Unit,
                      local: [LocalSegment], approximate: Bool = false) -> [TranscriptSegment] {
        var kept = existing.filter { $0.unit != unit.id }
        let lower = unit.globalStart
        let upper = unit.globalStart + unit.duration
        for seg in local {
            let text = seg.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }
            let s = seg.start.isFinite ? seg.start : 0
            let e = seg.end.isFinite ? seg.end : s
            let start = min(max(lower, lower + s), upper)
            let end = min(max(start, lower + e), upper)
            kept.append(TranscriptSegment(start: start, end: end, text: text, approximate: approximate, unit: unit.id))
        }
        // 稳定排序:同一时刻的段保持原有先后。
        return kept.enumerated().sorted { a, b in
            a.element.start != b.element.start ? a.element.start < b.element.start : a.offset < b.offset
        }.map(\.element)
    }

    /// 云端只给整段文字时:按句子切开,按字数把单元时长分给每句(标为估算时间)。
    static func approximateSegments(text: String, duration: Double) -> [LocalSegment] {
        let sentences = splitSentences(text)
        let total = sentences.reduce(0) { $0 + max(1, $1.count) }
        guard total > 0, duration > 0 else {
            return sentences.map { LocalSegment(start: 0, end: 0, text: $0) }
        }
        var cursor = 0.0
        return sentences.map { sentence in
            let share = duration * Double(max(1, sentence.count)) / Double(total)
            defer { cursor += share }
            return LocalSegment(start: cursor, end: cursor + share, text: sentence)
        }
    }

    static func splitSentences(_ text: String) -> [String] {
        var out: [String] = []
        var current = ""
        let enders: Set<Character> = ["。", "！", "？", "!", "?", ".", "；", ";", "\n"]
        for ch in text {
            if ch == "\n" {
                if !current.trimmingCharacters(in: .whitespaces).isEmpty { out.append(current) }
                current = ""
                continue
            }
            current.append(ch)
            if enders.contains(ch) {
                out.append(current)
                current = ""
            }
        }
        if !current.trimmingCharacters(in: .whitespaces).isEmpty { out.append(current) }
        return out.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    // MARK: - Paragraphs (display + export)

    struct Paragraph: Equatable, Sendable {
        var start: Double
        var end: Double
        var speaker: Int?
        var text: String
        var approximate: Bool
        /// 构成这段的分段在 segments 里的下标(第一个)。
        var firstSegment: Int
    }

    /// 相邻、同一说话人、间隔不长的分段并成一段,读起来像文字稿而不是字幕。
    static func paragraphs(_ segments: [TranscriptSegment], maxGap: Double = 2.0, maxCharacters: Int = 220) -> [Paragraph] {
        var out: [Paragraph] = []
        for (i, seg) in segments.enumerated() {
            if var last = out.last,
               last.speaker == seg.speaker,
               seg.start - last.end <= maxGap,
               last.text.count + seg.text.count <= maxCharacters {
                last.text += joiner(last.text, seg.text) + seg.text
                last.end = max(last.end, seg.end)
                last.approximate = last.approximate || seg.approximate
                out[out.count - 1] = last
            } else {
                out.append(Paragraph(start: seg.start, end: seg.end, speaker: seg.speaker, text: seg.text,
                                     approximate: seg.approximate, firstSegment: i))
            }
        }
        return out
    }

    /// 中文之间不加空格,拉丁文字之间加一个。
    private static func joiner(_ a: String, _ b: String) -> String {
        guard let l = a.unicodeScalars.last, let f = b.unicodeScalars.first else { return "" }
        let latin = CharacterSet.alphanumerics.subtracting(CharacterSet(charactersIn: "\u{4E00}"..."\u{9FFF}"))
        return latin.contains(l) && latin.contains(f) ? " " : ""
    }

    // MARK: - Speakers

    static func speakerLabel(_ speaker: Int, names: [String: String]) -> String {
        if let name = names[String(speaker)]?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            return name
        }
        return String(localized: "说话人 \(speaker)")
    }

    /// 改名:去首尾空白、单行、≤20 字;空名字 = 恢复成「说话人 N」。
    static func renameSpeaker(_ names: [String: String], speaker: Int, to newName: String) -> [String: String] {
        var out = names
        let clean = RecordingMetadata.sanitizedTitle(newName)
        let capped = String(clean.prefix(20))
        if capped.isEmpty { out.removeValue(forKey: String(speaker)) } else { out[String(speaker)] = capped }
        return out
    }

    static func speakers(in segments: [TranscriptSegment]) -> [Int] {
        Array(Set(segments.compactMap(\.speaker))).sorted()
    }

    /// 把模型给出的「行号 → 说话人」套到分段上。行号对应 `numberedLines` 里的编号(1 起,含 `lineOffset`)。
    /// 没给到的行沿用上一行的说话人(模型常常只在换人时标注)。说话人编号夹在 1…maxSpeakers。
    static func applySpeakerAssignments(_ segments: [TranscriptSegment], assignments: [Int: Int],
                                        maxSpeakers: Int = 12) -> [TranscriptSegment] {
        guard !assignments.isEmpty else { return segments }
        var out = segments
        var current: Int?
        for i in out.indices {
            if let s = assignments[i + 1] { current = min(max(1, s), maxSpeakers) }
            out[i].speaker = current ?? out[i].speaker
        }
        return out
    }

    /// 解析模型回复。接受 `12:2`、`12：说话人2`、`12 -> 2`、`[12] 2` 等,每行一条;也接受 JSON 对象 `{"12":2}`。
    /// 只收 1…lineCount 范围里的行号(防止回复里乱写的数字套到不存在的行上)。
    static func parseSpeakerAssignments(_ response: String, validLines: ClosedRange<Int>) -> [Int: Int] {
        var out: [Int: Int] = [:]
        let jsonText = extractJSONObject(response)
        if !jsonText.isEmpty,
           let obj = (try? JSONSerialization.jsonObject(with: Data(jsonText.utf8))) as? [String: Any] {
            for (k, v) in obj {
                guard let line = Int(k.trimmingCharacters(in: .whitespaces)), validLines.contains(line) else { continue }
                if let n = v as? Int { out[line] = n }
                else if let s = v as? String, let n = firstInteger(in: s) { out[line] = n }
            }
            if !out.isEmpty { return out }
        }
        let pattern = #"^\s*\[?(\d{1,6})\]?\s*(?:[:：=]|->|→|\s)\s*(?:说话人|speaker|S)?\s*(\d{1,2})\b"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return out }
        for rawLine in response.split(whereSeparator: \.isNewline) {
            let line = String(rawLine)
            let ns = line as NSString
            guard let m = regex.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)),
                  let index = Int(ns.substring(with: m.range(at: 1))),
                  let speaker = Int(ns.substring(with: m.range(at: 2))),
                  validLines.contains(index), speaker >= 1 else { continue }
            out[index] = speaker
        }
        return out
    }

    private static func extractJSONObject(_ s: String) -> String {
        guard let open = s.firstIndex(of: "{"), let close = s.lastIndex(of: "}"), open < close else { return "" }
        return String(s[open...close])
    }

    private static func firstInteger(in s: String) -> Int? {
        let digits = s.drop { !$0.isNumber }.prefix { $0.isNumber }
        return Int(digits)
    }

    /// 给说话人推断用的编号行:`12 [03:15] 文本`。`range` 是 segments 的下标范围。
    static func numberedLines(_ segments: [TranscriptSegment], range: Range<Int>, maxCharactersPerLine: Int = 300) -> [String] {
        range.clamped(to: segments.indices).map { i in
            "\(i + 1) [\(timestamp(segments[i].start))] \(segments[i].text.prefix(maxCharactersPerLine))"
        }
    }

    // MARK: - Rendering

    static func timestamp(_ seconds: Double) -> String {
        let total = Int(max(0, seconds.isFinite ? seconds : 0))
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%02d:%02d", m, s)
    }

    /// 带时间戳的文字稿(作为附件交给模型,也用于导出)。
    static func renderMarkdown(title: String, date: Date, duration: Double, segments: [TranscriptSegment],
                               names: [String: String], speakersInferred: Bool,
                               highlights: [RecordingHighlight] = []) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "zh_CN")
        f.dateFormat = "yyyy-MM-dd HH:mm"
        var out = "# \(title)\n\n"
        out += "- \(String(localized: "录音时间")):\(f.string(from: date))\n"
        out += "- \(String(localized: "时长")):\(timestamp(duration))\n"
        if speakersInferred {
            out += "- \(String(localized: "说话人标签由模型根据语义推断,可能有误"))\n"
        }
        if segments.contains(where: \.approximate) {
            out += "- \(String(localized: "部分时间戳为估算"))\n"
        }
        if !highlights.isEmpty {
            let marks = highlights.sorted { $0.time < $1.time }.map { h in
                "[\(timestamp(h.time))]" + (h.note.map { " \($0)" } ?? "")
            }
            out += "- \(String(localized: "标记的重点")):\(marks.joined(separator: "、"))\n"
        }
        out += "\n"
        for p in paragraphs(segments) {
            let who = p.speaker.map { "**\(speakerLabel($0, names: names))** " } ?? ""
            out += "[\(timestamp(p.start))] \(who)\(p.text)\n\n"
        }
        return out
    }

    /// 给模型的紧凑行格式(每段一行),比 Markdown 稿省字。
    static func compactLines(_ segments: [TranscriptSegment], names: [String: String]) -> [String] {
        paragraphs(segments).map { p in
            let who = p.speaker.map { "\(speakerLabel($0, names: names)):" } ?? ""
            return "[\(timestamp(p.start))] \(who)\(p.text)"
        }
    }
}
