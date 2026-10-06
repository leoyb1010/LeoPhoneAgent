import Foundation

// [H] 语音升级的纯逻辑:实时字幕下的动态断句(H6)、双轨识别取舍(H2)、
// 确认过的错字自动替换(H3)、三个语音度量(H4)、识别热词(H5)。
// 不依赖 UI / Speech 框架,同时编进 MinisLogicTests。

// MARK: - 偏好开关

enum VoiceExperiencePreferences {
    static let liveCaptionsKey = "voice.liveCaptions.enabled"
    static let hotwordsKey = "voice.hotwords.enabled"
    static let streamingTTSKey = "voice.streamingTTS.enabled"

    /// 实时字幕(H1)。系统识别资源未下载时即便打开也不会生效。
    static var liveCaptionsEnabled: Bool { flag(liveCaptionsKey) }
    /// 把当前会话的术语作为热词传给支持的识别服务(H5)。
    static var hotwordsEnabled: Bool { flag(hotwordsKey) }
    /// 支持流式接口的朗读服务边收边播(H7)。
    static var streamingTTSEnabled: Bool { flag(streamingTTSKey) }

    private static func flag(_ key: String, defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: key) as? Bool ?? true
    }
}

// MARK: - H6 动态判断"说完了"

enum VoiceEndpointing {
    /// 字幕显示句子已完整(句末标点):静音这么久就切。
    static let completeSilence: TimeInterval = 0.8
    /// 明显说到一半(逗号、连接词结尾):放宽到这么久。
    static let midSentenceSilence: TimeInterval = 3.0
    /// 判断不出来:折中值,仍短于 VAD 固定的约 5 秒。
    static let neutralSilence: TimeInterval = 2.0

    private static let terminalPunctuation: Set<Character> = ["。", "！", "？", ".", "!", "?", "…"]
    private static let continuingPunctuation: Set<Character> = ["，", ",", "、", "；", ";", "：", ":", "—", "-"]
    /// 句尾出现这些词基本说明话没说完。
    private static let danglingWords = ["然后", "还有", "但是", "可是", "因为", "所以", "而且", "或者", "以及",
                                        "如果", "就是", "那个", "这个", "比如", "并且", "和", "跟", "与", "把", "给",
                                        " and", " but", " or", " because", " so", " the", " to", " of"]

    /// 当前实时字幕对应的静音阈值;nil = 没有字幕,沿用 VAD 自己的断句。
    static func silenceThreshold(forLiveText raw: String) -> TimeInterval? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let last = text.last else { return nil }
        if terminalPunctuation.contains(last) { return completeSilence }
        if continuingPunctuation.contains(last) { return midSentenceSilence }
        let lower = text.lowercased()
        if danglingWords.contains(where: { lower.hasSuffix($0) }) { return midSentenceSilence }
        return neutralSilence
    }

    /// 静音已持续 `silence` 秒时是否该提前收尾。
    static func shouldEndSegment(liveText: String, silence: TimeInterval) -> Bool {
        guard let threshold = silenceThreshold(forLiveText: liveText) else { return false }
        return silence >= threshold
    }
}

// MARK: - H2 双轨识别

enum VoiceDualTrack {
    /// 少于这个时长才考虑直接用端侧结果。
    static let maxOnDeviceSeconds: Double = 8
    /// 端侧结果的平均置信度至少这么高才算"高"。
    static let minConfidence: Double = 0.75

    enum Route: Equatable {
        /// 直接用端侧实时结果,不再调用配置的识别服务。
        case onDevice
        /// 走配置的识别链(云端或系统);有端侧结果时先显示、回来后替换。
        case configured
    }

    /// - Parameter configuredIsOnDevice: 配置的识别就是系统端侧引擎——再跑一遍是同一个模型,
    ///   有结果就直接用。
    static func route(liveText: String, confidence: Double?, segmentSeconds: Double,
                      configuredIsOnDevice: Bool) -> Route {
        let text = liveText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return .configured }
        if configuredIsOnDevice { return .onDevice }
        guard segmentSeconds < maxOnDeviceSeconds, let confidence, confidence >= minConfidence else {
            return .configured
        }
        return .onDevice
    }
}

// MARK: - H3 确认过的错字自动替换

struct VoiceAutoCorrectionRule: Equatable, Sendable {
    let from: String
    let to: String
    let phoneticKey: String
    let locale: String
}

enum VoiceAutoCorrection {
    /// 你手动改过(确认过)至少这么多次的修正才自动替换。
    static let minConfirmations = 2

    /// 确认次数扣掉被否决的次数后仍达到阈值。
    static func isEligible(frequency: Int, negative: Int) -> Bool {
        frequency - negative >= minConfirmations
    }

    /// 把词库行展开成可直接替换的规则;只用你实际改过的原文变体,不靠发音猜。
    static func rules(from rows: [ConfusionRow]) -> [VoiceAutoCorrectionRule] {
        var out: [VoiceAutoCorrectionRule] = []
        var seen = Set<String>()
        for row in rows where isEligible(frequency: row.frequency, negative: row.negativeFeedbackCount) {
            for variant in row.variants where variant.count >= 2 && variant != row.correctedTerm {
                guard seen.insert(variant).inserted else { continue }
                out.append(.init(from: variant, to: row.correctedTerm, phoneticKey: row.phoneticKey, locale: row.locale))
            }
        }
        return out.sorted { $0.from.count > $1.from.count }
    }

    /// 逐条替换;已经是正确写法的地方(如规则"张→张三"遇到"张三")不重复替换。
    static func apply(_ text: String, rules: [VoiceAutoCorrectionRule]) -> (text: String, applied: [VoiceAutoCorrectionRule]) {
        var result = text
        var applied: [VoiceAutoCorrectionRule] = []
        for rule in rules where !rule.from.isEmpty {
            var hit = false
            var searchStart = result.startIndex
            while searchStart < result.endIndex,
                  let r = result.range(of: rule.from, range: searchStart..<result.endIndex) {
                if rule.to.contains(rule.from), alreadyCorrect(rule.to, covering: r, in: result) {
                    searchStart = r.upperBound
                    continue
                }
                let offset = result.distance(from: result.startIndex, to: r.lowerBound)
                result.replaceSubrange(r, with: rule.to)
                hit = true
                searchStart = result.index(result.startIndex, offsetBy: offset + rule.to.count)
            }
            if hit { applied.append(rule) }
        }
        return (result, applied)
    }

    /// "已自动更正：石塘→食堂，张山→张三"
    static func notice(for applied: [VoiceAutoCorrectionRule]) -> String {
        "已自动更正：" + applied.map { "\($0.from)→\($0.to)" }.joined(separator: "，")
    }

    private static func alreadyCorrect(_ correct: String, covering r: Range<String.Index>, in text: String) -> Bool {
        var start = text.startIndex
        while start < text.endIndex, let c = text.range(of: correct, range: start..<text.endIndex) {
            if c.lowerBound <= r.lowerBound && c.upperBound >= r.upperBound { return true }
            if c.lowerBound > r.lowerBound { return false }
            start = text.index(after: c.lowerBound)
        }
        return false
    }
}

// MARK: - H4 三个语音度量

enum VoiceMetricKind: String, CaseIterable, Sendable {
    /// 说完 → 看到终稿(毫秒)。
    case finalLatency = "final"
    /// 发出语音消息 → 听到回答的第一个字(毫秒)。
    case firstAudioLatency = "firstAudio"
    /// 一次语音输入是否被手动改字(1 / 0)。
    case manualEdit = "edit"
}

final class VoiceMetricsStore: @unchecked Sendable {
    static let shared = VoiceMetricsStore(defaults: .standard)
    /// 只保留最近这么多次。
    static let window = 20
    /// 发出后这么久还没开口就不算(多半是没开朗读或被打断)。
    static let firstAudioHorizon: TimeInterval = 120

    private let defaults: UserDefaults
    private let lock = NSLock()
    private var pendingReplyAt: TimeInterval?

    init(defaults: UserDefaults) { self.defaults = defaults }

    private func key(_ kind: VoiceMetricKind) -> String { "voice.metrics.\(kind.rawValue)" }

    func record(_ kind: VoiceMetricKind, _ value: Double) {
        guard value.isFinite, value >= 0 else { return }
        lock.lock(); defer { lock.unlock() }
        var list = defaults.array(forKey: key(kind)) as? [Double] ?? []
        list.append(value)
        if list.count > Self.window { list.removeFirst(list.count - Self.window) }
        defaults.set(list, forKey: key(kind))
    }

    func values(_ kind: VoiceMetricKind) -> [Double] {
        lock.lock(); defer { lock.unlock() }
        return defaults.array(forKey: key(kind)) as? [Double] ?? []
    }

    /// 最近 20 次的中位数;手动改字率是 0/1 样本,这里给的是均值(= 改字率)。
    func summary(_ kind: VoiceMetricKind) -> Double? {
        let list = values(kind)
        return kind == .manualEdit ? Self.mean(list) : Self.median(list)
    }

    func reset() {
        lock.lock(); defer { lock.unlock() }
        for kind in VoiceMetricKind.allCases { defaults.removeObject(forKey: key(kind)) }
        pendingReplyAt = nil
    }

    /// 语音消息发出的时刻(系统运行时间),等第一段朗读出声。
    func markVoiceMessageSent(at uptime: TimeInterval) {
        lock.lock(); pendingReplyAt = uptime; lock.unlock()
    }

    /// 朗读第一次出声时调用;有待测的发送就记一笔并返回毫秒数。
    @discardableResult
    func noteFirstAudio(at uptime: TimeInterval) -> Double? {
        lock.lock()
        guard let sent = pendingReplyAt else { lock.unlock(); return nil }
        pendingReplyAt = nil
        lock.unlock()
        let elapsed = uptime - sent
        guard elapsed >= 0, elapsed <= Self.firstAudioHorizon else { return nil }
        let ms = (elapsed * 1000).rounded()
        record(.firstAudioLatency, ms)
        return ms
    }

    static func median(_ values: [Double]) -> Double? {
        guard !values.isEmpty else { return nil }
        let sorted = values.sorted()
        let mid = sorted.count / 2
        return sorted.count % 2 == 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
    }

    static func mean(_ values: [Double]) -> Double? {
        guard !values.isEmpty else { return nil }
        return values.reduce(0, +) / Double(values.count)
    }
}

// MARK: - H5 识别热词

enum VoiceHotwords {
    /// 上限 50 个。
    static let limit = 50
    /// Whisper 的 prompt 只看前 224 个 token,中文按字粗估,留余量。
    static let maxPromptCharacters = 200

    /// 从会话文本里挑术语:出现次数多的在前,去重,最多 `limit` 个。
    /// `extract` 默认走打字词表同一套过滤(分词 + 停用词 + 打分)。
    static func select(from texts: [String],
                       extract: (String) -> [String] = VoiceHotwords.vocabularyTerms) -> [String] {
        var counts: [String: Int] = [:]
        var firstSeen: [String: Int] = [:]
        var order = 0
        for text in texts where !text.isEmpty {
            for term in extract(text) {
                let t = term.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !t.isEmpty else { continue }
                counts[t, default: 0] += 1
                if firstSeen[t] == nil { firstSeen[t] = order; order += 1 }
            }
        }
        return counts.keys
            .sorted { (counts[$0]!, -firstSeen[$0]!) > (counts[$1]!, -firstSeen[$1]!) }
            .prefix(limit)
            .map { $0 }
    }

    /// Whisper 风格的 prompt:术语用顿号串起来,超长截断在词边界。
    static func prompt(for words: [String]) -> String? {
        var out = ""
        for word in words {
            let next = out.isEmpty ? word : out + "、" + word
            if next.count > maxPromptCharacters { break }
            out = next
        }
        return out.isEmpty ? nil : out
    }

    static func vocabularyTerms(in text: String) -> [String] {
        VocabularyFilter.candidates(in: text).compactMap { term, _, tag in
            if case .accepted = VocabularyFilter.evaluate(term: term, posTag: tag) { return term }
            return nil
        }
    }
}
