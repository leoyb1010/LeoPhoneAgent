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
    static func transcribe(data: Data, localeIdentifier: String) async throws -> VoiceInputResponse {
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
