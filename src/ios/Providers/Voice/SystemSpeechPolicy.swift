import Foundation

// Framework-free contracts shared by System ASR, its UI and focused tests.
enum SystemSpeechMode: String, Codable, Sendable {
    case offline, networkAllowed, automatic
}

enum SystemSpeechAssetState: String, Codable, Sendable {
    case installed, notInstalled, downloading, unsupported, unknown
}

struct SystemSpeechAvailability: Equatable, Sendable {
    let requestedLocale: String
    let resolvedLocale: String?
    let state: SystemSpeechAssetState
}

enum SystemSpeechRoute: Equatable, Sendable {
    case analyzer(locale: String)
    case legacy(requiresOnDevice: Bool)
}

struct SpeechExecutionMetadata: Equatable, Codable, Sendable {
    enum Engine: String, Codable, Sendable { case speechAnalyzer, legacyOnDevice, legacyNetworkAllowed }
    enum Location: String, Codable, Sendable { case onDevice, systemManaged }
    let engine: Engine
    let location: Location
    let locale: String
    let isFinal: Bool
    var note: String? = nil

    var displayLabel: String {
        location == .onDevice ? "本机转写" : "允许联网 · 执行位置由系统决定"
    }
}

struct SystemSpeechTranscript: Sendable {
    let text: String
    let duration: Double?
    let execution: SpeechExecutionMetadata
}

enum SystemSpeechError: Error, LocalizedError, Equatable, Sendable {
    case assetsMissing(String)
    case assetsDownloading(String)
    case offlineUnavailable(String)
    case legacyPermissionRequired
    case recognizerUnavailable
    case invalidAudio(String)
    case recognitionFailed(String)
    case timedOut
    case installationRequiresUserAction
    case installationNotConfirmed
    case installationTimedOut

    var errorDescription: String? {
        switch self {
        case .assetsMissing(let locale): return "本机缺少 \(locale) 转写资源。请打开“系统语音与语言资源”，由你选择下载；音频没有转到网络识别。"
        case .assetsDownloading(let locale): return "\(locale) 的系统语言资源仍在准备。请在“系统语音与语言资源”查看，完成后重试。"
        case .offlineUnavailable(let locale): return "此设备或语言（\(locale)）暂不支持离线识别。可选择其他本机语言，或明确切换“允许联网”。"
        case .legacyPermissionRequired: return "此识别方式需要系统语音识别授权。请在系统设置中允许，或安装可直接本机运行的系统转写资源。"
        case .recognizerUnavailable: return "系统语音识别当前不可用，请稍后重试或检查语言资源。"
        case .invalidAudio(let detail): return "无法读取这段音频：\(detail)"
        case .recognitionFailed(let detail): return "系统转写未完成：\(detail)"
        case .timedOut: return "系统转写超时，已停止本次请求，请重试。"
        case .installationRequiresUserAction: return "语言资源下载必须由你点击开始。"
        case .installationNotConfirmed: return "系统尚未确认语言资源安装完成，请刷新状态后重试。"
        case .installationTimedOut: return "语言资源下载等待超时，已请求停止本次下载。请刷新查看系统的实际资源状态。"
        }
    }

    var offersResourceManagement: Bool {
        switch self {
        case .assetsMissing, .assetsDownloading, .offlineUnavailable, .legacyPermissionRequired,
             .recognizerUnavailable, .installationNotConfirmed: return true
        default: return false
        }
    }
}

enum SystemSpeechPreferences {
    static let autoNetworkAllowedKey = "leo.systemSpeech.autoNetworkAllowed"
    static var autoNetworkAllowed: Bool {
        UserDefaults.standard.object(forKey: autoNetworkAllowedKey) as? Bool ?? false
    }
}

enum SystemSpeechPolicy {
    static func mode(onDevice: Bool?, modelID: String?) -> SystemSpeechMode {
        // A conflicting flag can never weaken an explicitly Offline model.
        if onDevice == true || modelID?.hasSuffix("system-asr-offline") == true { return .offline }
        if onDevice == false || modelID?.hasSuffix("system-asr-online") == true { return .networkAllowed }
        return .automatic
    }

    static func choose(mode: SystemSpeechMode, automaticNetworkAllowed: Bool,
                       assets: SystemSpeechAvailability, legacyAvailable: Bool,
                       legacySupportsOnDevice: Bool, legacyAuthorized: Bool) throws -> SystemSpeechRoute {
        if assets.state == .installed, let locale = assets.resolvedLocale { return .analyzer(locale: locale) }
        if legacySupportsOnDevice {
            guard legacyAuthorized else { throw SystemSpeechError.legacyPermissionRequired }
            guard legacyAvailable else { throw SystemSpeechError.recognizerUnavailable }
            return .legacy(requiresOnDevice: true)
        }
        let networkAllowed = mode == .networkAllowed || (mode == .automatic && automaticNetworkAllowed)
        if networkAllowed {
            guard legacyAuthorized else { throw SystemSpeechError.legacyPermissionRequired }
            guard legacyAvailable else { throw SystemSpeechError.recognizerUnavailable }
            return .legacy(requiresOnDevice: false)
        }
        switch assets.state {
        case .notInstalled: throw SystemSpeechError.assetsMissing(assets.resolvedLocale ?? assets.requestedLocale)
        case .downloading: throw SystemSpeechError.assetsDownloading(assets.resolvedLocale ?? assets.requestedLocale)
        default: throw SystemSpeechError.offlineUnavailable(assets.requestedLocale)
        }
    }

    static func timeout(audioDuration: Double?) -> Double {
        guard let audioDuration, audioDuration.isFinite, audioDuration > 0 else { return 15 }
        return min(90, max(8, audioDuration + 5))
    }

    static func requireExplicitInstallation(_ userInitiated: Bool) throws {
        guard userInitiated else { throw SystemSpeechError.installationRequiresUserAction }
    }
}

/// A callback or XPC operation may ignore cooperative Task cancellation. This
/// lifetime owns one continuation and requests all cleanup before resuming it.
/// The deadline therefore does not wait for a stuck child task to cooperate.
final class SpeechRequestLifetime<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var terminal: Result<Value, Error>?
    private var completion: ((Result<Value, Error>) -> Void)?
    private var cleanup: [() -> Void] = []
    private var bound = false

    var isFinished: Bool { lock.lock(); defer { lock.unlock() }; return terminal != nil }

    @discardableResult
    func finish(_ result: Result<Value, Error>) -> Bool {
        lock.lock()
        guard terminal == nil else { lock.unlock(); return false }
        terminal = result
        let callback = completion
        completion = nil
        let actions = cleanup
        cleanup.removeAll()
        lock.unlock()
        actions.forEach { $0() }
        callback?(result)
        return true
    }

    func onFinish(_ action: @escaping () -> Void) {
        lock.lock()
        if terminal != nil { lock.unlock(); action() }
        else { cleanup.append(action); lock.unlock() }
    }

    func value(timeoutSeconds: Double,
               onTimeout: @escaping @Sendable () -> Result<Value, Error> = { .failure(SystemSpeechError.timedOut) },
               start: @escaping (SpeechRequestLifetime<Value>) -> Void) async throws -> Value {
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                lock.lock()
                if bound {
                    lock.unlock()
                    continuation.resume(throwing: SystemSpeechError.recognitionFailed("同一请求不能重复启动"))
                    return
                }
                bound = true
                let existing = terminal
                if existing == nil { completion = { continuation.resume(with: $0) } }
                lock.unlock()
                if let existing { continuation.resume(with: existing); return }
                let timeout = Task {
                    do { try await Task.sleep(nanoseconds: UInt64(max(0.001, timeoutSeconds) * 1_000_000_000)) }
                    catch { return }
                    self.finish(onTimeout())
                }
                onFinish { timeout.cancel() }
                if !isFinished { start(self) }
            }
        } onCancel: {
            self.finish(.failure(CancellationError()))
        }
    }
}

final class SpeechTranscriptBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var value = ""
    func replace(_ text: String) { lock.lock(); value = text; lock.unlock() }
    func append(_ text: String) { lock.lock(); value += text; lock.unlock() }
    var text: String { lock.lock(); defer { lock.unlock() }; return value.trimmingCharacters(in: .whitespacesAndNewlines) }
}
