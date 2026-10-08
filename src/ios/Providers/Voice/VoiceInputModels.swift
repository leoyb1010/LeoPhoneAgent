import Foundation

// MARK: - Request / Response models
//
// Shared value types for the voice subsystem. `VoiceInput*` covers speech
// recognition (ASR); `VoiceOutput*` covers speech synthesis (TTS).

/// A speech-recognition (ASR) request: audio in, text out.
struct VoiceInputRequest {
    /// 16 kHz mono WAV produced by the VAD (or any provider-acceptable audio).
    let audioData: Data
    let model: String?
    /// nil = let the provider auto-detect the spoken language.
    let language: String?
    let responseFormat: VoiceInputFormat
    /// Optional biasing prompt to improve recognition of domain terms.
    let prompt: String?
    /// The resolved LLMModel — allows the provider to detect whether this model
    /// uses dedicated ASR (Whisper API) or chat-based ASR (chat completions with
    /// audio input + constrained system prompt).
    let resolvedModel: LLMModel?
    /// System (Apple) ASR only: force on-device (`true`) vs server/cloud (`false`).
    /// nil = provider default (prefer on-device when supported). Ignored by cloud
    /// ASR providers.
    let onDeviceRecognition: Bool?
    /// [H5] 当前会话的术语(≤50)。系统识别作为 contextualStrings;云端只在支持 prompt
    /// 的服务商上经由 `prompt` 传递。
    let hotwords: [String]

    init(audioData: Data,
         model: String? = nil,
         language: String? = nil,
         responseFormat: VoiceInputFormat = .json,
         prompt: String? = nil,
         resolvedModel: LLMModel? = nil,
         onDeviceRecognition: Bool? = nil,
         hotwords: [String] = []) {
        self.audioData = audioData
        self.model = model
        self.language = language
        self.responseFormat = responseFormat
        self.prompt = prompt
        self.resolvedModel = resolvedModel
        self.onDeviceRecognition = onDeviceRecognition
        self.hotwords = hotwords
    }
}

enum VoiceInputFormat: String {
    case json, text, srt, vtt
}

struct VoiceInputResponse: Sendable {
    let text: String
    let language: String?
    let duration: Double?
    var execution: SpeechExecutionMetadata? = nil
}

/// A speech-synthesis (TTS) request: text in, audio out.
struct VoiceOutputRequest {
    let input: String
    let model: String?
    let voice: String?
    /// 0.25 ~ 4.0, nil = 1.0 (provider default).
    let speed: Float?
    let responseFormat: VoiceOutputFormat

    init(input: String,
         model: String? = nil,
         voice: String? = nil,
         speed: Float? = nil,
         responseFormat: VoiceOutputFormat = .mp3) {
        self.input = input
        self.model = model
        self.voice = voice
        self.speed = speed
        self.responseFormat = responseFormat
    }
}

enum VoiceOutputFormat: String {
    case mp3, opus, wav, aac
}

// MARK: - Capability protocols

protocol VoiceInputCapable {
    func transcribe(_ request: VoiceInputRequest) async throws -> VoiceInputResponse
    var supportsVoiceInput: Bool { get }
}

protocol VoiceOutputCapable {
    func synthesize(_ request: VoiceOutputRequest) async throws -> Data
    var supportsVoiceOutput: Bool { get }
}

/// [H7] 能边收边播的 TTS:按顺序回调 16-bit 小端单声道 PCM 片段。
/// 只给已接入且接口本身就是流式的服务商实现(目前:豆包 v3 unidirectional,
/// format=pcm 见火山引擎文档 6561/1598757)。
protocol StreamingVoiceOutput {
    var streamingSampleRate: Double { get }
    func streamPCM(_ request: VoiceOutputRequest, onChunk: @escaping (Data) -> Void) async throws
}

/// A voice provider that can do both directions (ASR + TTS). The factory returns
/// this so the built-in `SystemVoiceProvider` (not a `VoiceProvider` subclass) and
/// the cloud `VoiceProvider` subclasses share one factory entry point.
typealias VoiceProviderCapable = VoiceInputCapable & VoiceOutputCapable

// MARK: - Errors

enum VoiceProviderError: LocalizedError {
    case unsupported(String)
    case httpError(Int, Data?)
    case parseError(String)
    case authError
    case noAudioData
    /// The audio session could not be activated because another app holds the
    /// microphone (FaceTime, a phone call, another recorder). "Parse failed:
    /// Microphone input unavailable" described neither the cause nor the fix.
    case audioSessionPreempted

    var errorDescription: String? {
        switch self {
        case .unsupported(let msg):
            return String(localized: "Unsupported: \(msg)", comment: "Voice provider unsupported capability")
        case .httpError(let code, let body):
            // Surface the server's own error message when present (most APIs put
            // the reason in the body, e.g. {"error":{"message":"..."}}).
            if let detail = Self.serverMessage(from: body) {
                return String(localized: "Request failed (HTTP \(code)): \(detail)", comment: "Voice provider HTTP error with detail")
            }
            if code == 404 {
                return String(localized: "Request failed (HTTP 404) — check the provider's Base URL and model name", comment: "Voice provider 404 hint")
            }
            return String(localized: "Request failed (HTTP \(code))", comment: "Voice provider HTTP error")
        case .parseError(let msg):
            return String(localized: "Parse failed: \(msg)", comment: "Voice provider response parse error")
        case .authError:
            return String(localized: "Authentication failed, please check the API key", comment: "Voice provider auth error")
        case .noAudioData:
            return String(localized: "No audio data", comment: "Voice provider missing audio")
        case .audioSessionPreempted:
            return String(localized: "The microphone is in use by another app (e.g. FaceTime or a phone call). Please try again after it finishes.",
                          comment: "Voice input failed because another app holds the microphone")
        }
    }

    /// Best-effort extraction of an API error message from a JSON/text body.
    private static func serverMessage(from body: Data?) -> String? {
        guard let body, !body.isEmpty else { return nil }
        if let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
            if let err = obj["error"] as? [String: Any], let msg = err["message"] as? String { return msg }
            if let msg = obj["error"] as? String { return msg }
            if let msg = obj["message"] as? String { return msg }
        }
        if let text = String(data: body, encoding: .utf8) {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty, trimmed.count < 200 { return trimmed }
        }
        return nil
    }
}
