import Foundation

// [V-rec] 录音 → 转写 → 纪要的数据模型。纯 Foundation,逻辑测试直接编译。
//
// 一条录音 = `Library/MinisChat/recordings/<id>/` 一个目录:
//   meta.json        本文件的 RecordingMetadata
//   transcript.json  RecordingTranscript(带时间戳的分段)
//   chunk-000.m4a …  10 分钟一块的 AAC 音频(崩溃最多丢正在写的那一块的未落盘尾巴)
//   outputs/<id>.md  生成过的纪要正文缓存
// 音频永远只在本机:不进 iCloud,不进系统备份,不进 App 备份包。

/// 一块音频。`frameCount` 按写入的采样帧累计,时长由它和采样率算出,不靠计时器。
struct RecordingChunk: Codable, Equatable, Sendable {
    var index: Int
    var fileName: String
    /// 在整条录音时间轴上的起点(秒,不含暂停)。
    var startOffset: Double
    var sampleRate: Double
    var frameCount: Int64
    /// 正在写。App 崩溃后仍为 true 的块需要在恢复时重新量一次时长。
    var isOpen: Bool

    var duration: Double { sampleRate > 0 ? Double(frameCount) / sampleRate : 0 }
    var endOffset: Double { startOffset + duration }

    static func fileName(forIndex index: Int) -> String {
        String(format: "chunk-%03d.m4a", max(0, min(index, 999)))
    }
}

struct RecordingHighlight: Codable, Equatable, Sendable, Identifiable {
    var id: String
    /// 录音时间轴上的位置(秒)。
    var time: Double
    var note: String?
}

enum RecordingSource: String, Codable, Sendable {
    case microphone
    case imported
}

enum RecordingTranscriptionEngine: String, Codable, Sendable {
    case onDevice
    case cloud
}

struct RecordingTranscriptionState: Codable, Equatable, Sendable {
    enum Phase: String, Codable, Sendable {
        case none, running, done, failed, needsAssets
    }
    var phase: Phase = .none
    var engine: RecordingTranscriptionEngine = .onDevice
    /// 已转写完成的转写单元(见 TranscriptionPlan);中断后从没做完的单元接着转。
    var completedUnits: [Int] = []
    var errorMessage: String?
    var updatedAt: Date?

    init(phase: Phase = .none, engine: RecordingTranscriptionEngine = .onDevice) {
        self.phase = phase
        self.engine = engine
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        phase = (try? c.decodeIfPresent(Phase.self, forKey: .phase)) ?? .none
        engine = (try? c.decodeIfPresent(RecordingTranscriptionEngine.self, forKey: .engine)) ?? .onDevice
        completedUnits = (try? c.decodeIfPresent([Int].self, forKey: .completedUnits)) ?? []
        errorMessage = try? c.decodeIfPresent(String.self, forKey: .errorMessage)
        updatedAt = try? c.decodeIfPresent(Date.self, forKey: .updatedAt)
    }
}

/// 一次生成(纪要 / 沟通记录 / 分析)。结果在一个普通对话里,能同步、能追问。
struct RecordingOutput: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var template: String
    var title: String
    var sessionId: String
    var runId: String?
    var createdAt: Date
    /// 结果已缓存到 outputs/<id>.md。
    var hasCachedResult: Bool = false

    init(id: String = UUID().uuidString, template: String, title: String, sessionId: String,
         runId: String?, createdAt: Date = Date(), hasCachedResult: Bool = false) {
        self.id = id
        self.template = template
        self.title = title
        self.sessionId = sessionId
        self.runId = runId
        self.createdAt = createdAt
        self.hasCachedResult = hasCachedResult
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        template = (try? c.decodeIfPresent(String.self, forKey: .template)) ?? "meeting"
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        sessionId = try c.decode(String.self, forKey: .sessionId)
        runId = try? c.decodeIfPresent(String.self, forKey: .runId)
        createdAt = (try? c.decodeIfPresent(Date.self, forKey: .createdAt)) ?? Date()
        hasCachedResult = (try? c.decodeIfPresent(Bool.self, forKey: .hasCachedResult)) ?? false
    }
}

struct RecordingMetadata: Codable, Equatable, Sendable, Identifiable {
    enum State: String, Codable, Sendable {
        case recording, paused, finished
    }

    static let currentVersion = 1
    static let maxTitleLength = 80

    var version: Int = RecordingMetadata.currentVersion
    var id: String
    var title: String
    var createdAt: Date
    var source: RecordingSource
    var state: State
    var chunks: [RecordingChunk]
    var highlights: [RecordingHighlight]
    var transcription: RecordingTranscriptionState
    /// 说话人改名:"1" → "张三"。没改名的显示「说话人 1」。
    var speakerNames: [String: String]
    /// 说话人标签来自模型推断(界面上注明「推断」)。
    var speakersInferred: Bool
    var localeIdentifier: String
    /// 默认关闭:打开后转写把音频发给你在语音设置里选的服务商。
    var cloudTranscriptionEnabled: Bool
    var outputs: [RecordingOutput]
    var originalFileName: String?

    init(id: String = UUID().uuidString, title: String, createdAt: Date = Date(),
         source: RecordingSource = .microphone, state: State = .recording,
         localeIdentifier: String = Locale.current.identifier) {
        self.id = id
        self.title = RecordingMetadata.sanitizedTitle(title)
        self.createdAt = createdAt
        self.source = source
        self.state = state
        self.chunks = []
        self.highlights = []
        self.transcription = RecordingTranscriptionState()
        self.speakerNames = [:]
        self.speakersInferred = false
        self.localeIdentifier = localeIdentifier
        self.cloudTranscriptionEnabled = false
        self.outputs = []
        self.originalFileName = nil
    }

    /// 坏掉或旧版本的 meta.json 也要尽量读出来:读不出来的录音在列表里直接消失,等于丢数据。
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = (try? c.decodeIfPresent(Int.self, forKey: .version)) ?? RecordingMetadata.currentVersion
        id = try c.decode(String.self, forKey: .id)
        title = RecordingMetadata.sanitizedTitle((try? c.decodeIfPresent(String.self, forKey: .title)) ?? "")
        createdAt = (try? c.decodeIfPresent(Date.self, forKey: .createdAt)) ?? Date(timeIntervalSince1970: 0)
        source = (try? c.decodeIfPresent(RecordingSource.self, forKey: .source)) ?? .microphone
        state = (try? c.decodeIfPresent(State.self, forKey: .state)) ?? .finished
        chunks = (try? c.decodeIfPresent([RecordingChunk].self, forKey: .chunks)) ?? []
        highlights = (try? c.decodeIfPresent([RecordingHighlight].self, forKey: .highlights)) ?? []
        transcription = (try? c.decodeIfPresent(RecordingTranscriptionState.self, forKey: .transcription))
            ?? RecordingTranscriptionState()
        speakerNames = (try? c.decodeIfPresent([String: String].self, forKey: .speakerNames)) ?? [:]
        speakersInferred = (try? c.decodeIfPresent(Bool.self, forKey: .speakersInferred)) ?? false
        localeIdentifier = (try? c.decodeIfPresent(String.self, forKey: .localeIdentifier)) ?? Locale.current.identifier
        cloudTranscriptionEnabled = (try? c.decodeIfPresent(Bool.self, forKey: .cloudTranscriptionEnabled)) ?? false
        outputs = (try? c.decodeIfPresent([RecordingOutput].self, forKey: .outputs)) ?? []
        originalFileName = try? c.decodeIfPresent(String.self, forKey: .originalFileName)
    }

    var duration: Double { chunks.reduce(0) { $0 + $1.duration } }

    var displayTitle: String {
        title.isEmpty ? RecordingMetadata.defaultTitle(for: createdAt) : title
    }

    /// 单行、去控制字符、≤80 字。标题会进对话标题和灵动岛。
    static func sanitizedTitle(_ raw: String) -> String {
        let scalars = raw.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) || CharacterSet.newlines.contains($0) ? " " : String($0) }
        let collapsed = scalars.joined()
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        return String(collapsed.prefix(maxTitleLength))
    }

    static func defaultTitle(for date: Date, locale: Locale = Locale(identifier: "zh_CN")) -> String {
        let f = DateFormatter()
        f.locale = locale
        f.dateFormat = "M月d日 HH:mm"
        return String(localized: "录音 \(f.string(from: date))")
    }

    /// 列表上的状态文字。
    var statusLabel: String {
        switch state {
        case .recording: return String(localized: "录音中")
        case .paused: return String(localized: "已暂停")
        case .finished: break
        }
        switch transcription.phase {
        case .none: return String(localized: "未转写")
        case .running: return String(localized: "转写中")
        case .done: return outputs.isEmpty ? String(localized: "已转写") : String(localized: "已生成纪要")
        case .failed: return String(localized: "转写失败")
        case .needsAssets: return String(localized: "需下载语言资源")
        }
    }
}

/// 一段转写。时间都在整条录音的时间轴上(秒)。
struct TranscriptSegment: Codable, Equatable, Sendable {
    var start: Double
    var end: Double
    var text: String
    /// 1 起的说话人编号;nil = 未区分。
    var speaker: Int?
    /// 时间是按字数估出来的(云端转写只给整段文字时)。
    var approximate: Bool
    /// 产生这段的转写单元(TranscriptionPlan.Unit.id),重转某个单元时按它替换。
    var unit: Int

    init(start: Double, end: Double, text: String, speaker: Int? = nil, approximate: Bool = false, unit: Int) {
        self.start = start
        self.end = end
        self.text = text
        self.speaker = speaker
        self.approximate = approximate
        self.unit = unit
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        start = (try? c.decode(Double.self, forKey: .start)) ?? 0
        end = (try? c.decode(Double.self, forKey: .end)) ?? start
        text = (try? c.decode(String.self, forKey: .text)) ?? ""
        speaker = try? c.decodeIfPresent(Int.self, forKey: .speaker)
        approximate = (try? c.decodeIfPresent(Bool.self, forKey: .approximate)) ?? false
        unit = (try? c.decodeIfPresent(Int.self, forKey: .unit)) ?? 0
    }
}

struct RecordingTranscript: Codable, Equatable, Sendable {
    var segments: [TranscriptSegment]
    var updatedAt: Date

    init(segments: [TranscriptSegment] = [], updatedAt: Date = Date()) {
        self.segments = segments
        self.updatedAt = updatedAt
    }

    var plainText: String { segments.map(\.text).joined() }
    var characterCount: Int { segments.reduce(0) { $0 + $1.text.count } }
}
