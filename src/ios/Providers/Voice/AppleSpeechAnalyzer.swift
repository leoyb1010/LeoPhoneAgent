import Foundation
import Speech
import AVFoundation

/// Apple-managed local models. No asset download is initiated by transcription.
/// https://developer.apple.com/documentation/speech/speechanalyzer
/// https://developer.apple.com/documentation/speech/assetinventory
@available(iOS 26.0, *)
enum AppleSpeechAnalyzer {
    static func availability(locale: Locale) async -> SystemSpeechAvailability {
        guard SpeechTranscriber.isAvailable,
              let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
            return .init(requestedLocale: locale.identifier, resolvedLocale: nil, state: .unsupported)
        }
        let module = SpeechTranscriber(locale: supported, preset: .transcription)
        let state: SystemSpeechAssetState
        switch await AssetInventory.status(forModules: [module]) {
        case .installed: state = .installed
        case .downloading: state = .downloading
        case .supported: state = .notInstalled
        case .unsupported: state = .unsupported
        @unknown default: state = .unknown
        }
        return .init(requestedLocale: locale.identifier, resolvedLocale: supported.identifier, state: state)
    }

    @MainActor
    static func transcribe(data: Data, localeIdentifier: String,
                           contextualStrings: [String] = []) async throws -> VoiceInputResponse {
        let locale = Locale(identifier: localeIdentifier)
        let available = await availability(locale: locale)
        guard available.state == .installed else {
            throw SystemSpeechError.assetsMissing(localeIdentifier)
        }
        try Task.checkCancellation()
        let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent("system-speech-\(UUID().uuidString).wav")
        try data.write(to: fileURL, options: .atomic)
        defer { try? FileManager.default.removeItem(at: fileURL) }
        let audioFile: AVAudioFile
        do { audioFile = try AVAudioFile(forReading: fileURL) }
        catch { throw SystemSpeechError.invalidAudio(error.localizedDescription) }
        let duration = Double(audioFile.length) / audioFile.processingFormat.sampleRate
        guard duration.isFinite, duration > 0 else { throw SystemSpeechError.invalidAudio("音频为空") }
        let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let lifetime = SpeechRequestLifetime<VoiceInputResponse>()
        return try await lifetime.value(timeoutSeconds: SystemSpeechPolicy.timeout(audioDuration: duration)) { lifetime in
            lifetime.onFinish { Task { await analyzer.cancelAndFinishNow() } }
            let results = Task { () throws -> String in
                var text = ""
                for try await result in transcriber.results {
                    try Task.checkCancellation()
                    if result.isFinal { text += String(result.text.characters) }
                }
                return text.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            lifetime.onFinish { results.cancel() }
            let work = Task { @MainActor in
                do {
                    try Task.checkCancellation()
                    if !contextualStrings.isEmpty {
                        let context = AnalysisContext()
                        context.contextualStrings[.general] = Array(contextualStrings.prefix(VoiceHotwords.limit))
                        try? await analyzer.setContext(context)
                    }
                    _ = try await analyzer.analyzeSequence(from: audioFile)
                    try await analyzer.finalizeAndFinishThroughEndOfInput()
                    let text = try await results.value
                    lifetime.finish(.success(VoiceInputResponse(text: text, language: locale.identifier, duration: duration,
                        execution: .init(engine: .speechAnalyzer, location: .onDevice, locale: locale.identifier, isFinal: true))))
                } catch {
                    lifetime.finish(.failure(error is CancellationError ? error : SystemSpeechError.recognitionFailed(error.localizedDescription)))
                }
            }
            lifetime.onFinish { work.cancel() }
        }
    }

    @MainActor
    static func install(locale: Locale, userInitiated: Bool, onProgress: @escaping (Double) -> Void) async throws {
        try SystemSpeechPolicy.requireExplicitInstallation(userInitiated)
        guard SpeechTranscriber.isAvailable,
              let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
            throw SystemSpeechError.offlineUnavailable(locale.identifier)
        }
        try Task.checkCancellation()
        let module = SpeechTranscriber(locale: supported, preset: .transcription)
        _ = try await AssetInventory.reserve(locale: supported)
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
            let progress = Task { @MainActor in
                while !Task.isCancelled {
                    onProgress(request.progress.fractionCompleted)
                    do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
                }
            }
            defer { progress.cancel() }
            let lifetime = SpeechRequestLifetime<Void>()
            try await lifetime.value(timeoutSeconds: 900, onTimeout: { .failure(SystemSpeechError.installationTimedOut) }) { lifetime in
                let download = Task {
                    do {
                        try Task.checkCancellation()
                        try await request.downloadAndInstall()
                        lifetime.finish(.success(()))
                    } catch { lifetime.finish(.failure(error)) }
                }
                lifetime.onFinish {
                    if !request.progress.isFinished { request.progress.cancel() }
                    download.cancel()
                }
            }
        }
        try Task.checkCancellation()
        guard await AssetInventory.status(forModules: [module]) == .installed else {
            throw SystemSpeechError.installationNotConfirmed
        }
        onProgress(1)
    }
}

// MARK: - [H1] 说话时实时出字

/// 录音期间的流式转写:把 VAD 麦克风 tap 的实时 PCM 喂给 SpeechTranscriber,
/// 打开临时结果(volatileResults)与置信度。系统识别资源未下载时 `init` 返回 nil,
/// 调用方回到"整段识别"的原流程。
/// 接口按 iPhoneOS27.0 SDK 的 Speech.swiftinterface 核对:
/// `SpeechAnalyzer.start(inputSequence:)`、`AnalyzerInput(buffer:)`、
/// `SpeechTranscriber.ReportingOption.volatileResults/.fastResults`、
/// `ResultAttributeOption.transcriptionConfidence`、`AnalysisContext.contextualStrings`。
@available(iOS 26.0, *)
final class AppleLiveTranscriber: @unchecked Sendable {
    struct Snapshot: Equatable, Sendable {
        /// 已定稿(黑字)。
        var finalized = ""
        /// 临时结果(灰字),随说话不断改写。
        var volatile = ""
        /// 已定稿部分按字数加权的平均置信度;没有置信度信息时为 nil。
        var confidence: Double?
        var text: String { finalized + volatile }
    }

    private static let readyLock = NSLock()
    nonisolated(unsafe) private static var ready: [String: (locale: Locale, format: AVAudioFormat)] = [:]

    /// 进入语音模式时预热:确认资源已安装并拿到分析格式。没装就记为不可用。
    static func prewarm(localeIdentifier: String) async {
        let availability = await AppleSpeechAnalyzer.availability(locale: Locale(identifier: localeIdentifier))
        guard availability.state == .installed, let resolved = availability.resolvedLocale else {
            readyLock.withLock { ready[localeIdentifier] = nil }
            return
        }
        let locale = Locale(identifier: resolved)
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [makeModule(locale)]) else { return }
        readyLock.withLock { ready[localeIdentifier] = (locale, format) }
    }

    static func isReady(localeIdentifier: String) -> Bool {
        readyLock.withLock { ready[localeIdentifier] != nil }
    }

    private static func makeModule(_ locale: Locale) -> SpeechTranscriber {
        SpeechTranscriber(locale: locale, transcriptionOptions: [],
                          reportingOptions: [.volatileResults, .fastResults],
                          attributeOptions: [.transcriptionConfidence])
    }

    private let lock = NSLock()
    private let format: AVAudioFormat
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private var converter: AVAudioConverter?
    private var converterRate: Double = 0
    private var snapshot = Snapshot()
    private var confidenceSum = 0.0
    private var confidenceWeight = 0.0
    private var closed = false
    private var setupTask: Task<SpeechAnalyzer?, Never>?
    private var resultsTask: Task<Void, Never>?

    init?(localeIdentifier: String, contextualStrings: [String],
          onUpdate: @escaping @MainActor (Snapshot) -> Void) {
        guard let entry = Self.readyLock.withLock({ Self.ready[localeIdentifier] }) else { return nil }
        format = entry.format
        let (stream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
        self.continuation = continuation
        let transcriber = Self.makeModule(entry.locale)
        resultsTask = Task { [weak self] in
            do {
                for try await result in transcriber.results {
                    guard let self else { return }
                    let snap = self.ingest(result)
                    await onUpdate(snap)
                }
            } catch {
                VoiceLog.log("live transcriber results ended: \(error.localizedDescription)")
            }
        }
        let words = Array(contextualStrings.prefix(VoiceHotwords.limit))
        setupTask = Task {
            let analyzer = SpeechAnalyzer(modules: [transcriber])
            do {
                if !words.isEmpty {
                    let context = AnalysisContext()
                    context.contextualStrings[.general] = words
                    try await analyzer.setContext(context)
                }
                try await analyzer.start(inputSequence: stream)
                return analyzer
            } catch {
                VoiceLog.log("live transcriber start failed: \(error.localizedDescription)")
                return nil
            }
        }
    }

    private func ingest(_ result: SpeechTranscriber.Result) -> Snapshot {
        let text = String(result.text.characters)
        lock.lock(); defer { lock.unlock() }
        if result.isFinal {
            snapshot.finalized += text
            snapshot.volatile = ""
            for run in result.text.runs {
                guard let c = run[AttributeScopes.SpeechAttributes.ConfidenceAttribute.self] else { continue }
                let weight = Double(result.text[run.range].characters.count)
                confidenceSum += c * weight
                confidenceWeight += weight
            }
            snapshot.confidence = confidenceWeight > 0 ? confidenceSum / confidenceWeight : nil
        } else {
            snapshot.volatile = text
        }
        return snapshot
    }

    /// 音频线程调用:单声道 Float32 采样,转成分析格式后送入。
    func append(_ samples: UnsafeBufferPointer<Float>, sampleRate: Double) {
        guard sampleRate > 0, let base = samples.baseAddress, samples.count > 0 else { return }
        lock.lock(); defer { lock.unlock() }
        guard !closed,
              let inFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false),
              let input = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: AVAudioFrameCount(samples.count)),
              let channel = input.floatChannelData?[0] else { return }
        input.frameLength = AVAudioFrameCount(samples.count)
        channel.update(from: base, count: samples.count)
        if converter == nil || converterRate != sampleRate {
            converter = AVAudioConverter(from: inFormat, to: format)
            converterRate = sampleRate
        }
        guard let converter else { return }
        let capacity = AVAudioFrameCount(Double(samples.count) * format.sampleRate / sampleRate) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
        var supplied = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, outStatus in
            if supplied { outStatus.pointee = .noDataNow; return nil }
            supplied = true
            outStatus.pointee = .haveData
            return input
        }
        guard status != .error, output.frameLength > 0 else { return }
        continuation.yield(AnalyzerInput(buffer: output))
    }

    var current: Snapshot { lock.withLock { snapshot } }

    /// 输入结束,等系统把最后的临时结果定稿(最多 `timeout` 秒),返回最终快照。
    func finish(timeout: TimeInterval = 2.0) async -> Snapshot {
        lock.withLock { closed = true }
        continuation.finish()
        let setup = setupTask
        let results = resultsTask
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                if let analyzer = await setup?.value {
                    try? await analyzer.finalizeAndFinishThroughEndOfInput()
                }
                await results?.value
            }
            group.addTask { try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000)) }
            await group.next()
            group.cancelAll()
        }
        cancel()
        return current
    }

    /// 立即停止,丢弃未定稿部分。
    func cancel() {
        lock.withLock { closed = true }
        continuation.finish()
        resultsTask?.cancel()
        let setup = setupTask
        Task { if let analyzer = await setup?.value { await analyzer.cancelAndFinishNow() } }
    }
}
