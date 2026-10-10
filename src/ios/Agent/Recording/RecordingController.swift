import ActivityKit
import AVFoundation
import Foundation
import UIKit
import UniformTypeIdentifiers

private let logger = AppLogger(category: "Recording")

/// [V-rec] 录音实时状态:计时、电平、实时字幕。单独一个对象,只有录音页订阅,
/// 每秒十次的电平刷新不会让列表、首页跟着重绘。
@MainActor
final class RecordingLiveState: ObservableObject {
    @Published var elapsed: Double = 0
    @Published var level: Float = 0
    /// 最近一段实时字幕(已定稿 + 正在识别),只留尾部 400 字。
    @Published var captionFinal = ""
    @Published var captionVolatile = ""
    @Published var captionsAvailable = false
}

/// [V-rec] 录音功能的总控:开始 / 暂停 / 停止、灵动岛、手表遥控、转写队列、说话人、生成纪要。
@MainActor
final class RecordingController: ObservableObject {
    static let shared = RecordingController()

    struct Active: Equatable {
        let id: String
        var title: String
        var isPaused: Bool
        /// 你自己按的暂停(来电结束后不自动继续)。
        var userPaused: Bool
        /// 被来电 / Siri 打断:引擎已停,继续时要重新声明音频会话。
        var interrupted: Bool
        var highlights: Int

        var pausedByInterruption: Bool { isPaused && interrupted && !userPaused }
    }

    @Published private(set) var recordings: [RecordingMetadata] = []
    @Published private(set) var active: Active?
    /// 正在转写的录音 → (完成单元数, 总单元数)。
    @Published private(set) var transcriptionProgress: [String: (done: Int, total: Int)] = [:]
    /// 正在做说话人推断 / 生成纪要的录音 → 状态文字。
    @Published private(set) var busyText: [String: String] = [:]
    /// 最近一次失败,界面上用 LeoInlineError 显示。
    @Published var lastError: String?

    let live = RecordingLiveState()
    let store = RecordingStore.shared

    private var session: RecordingSession?
    private var liveTranscriber: AnyObject?
    private var tickTimer: Timer?
    private var lastActivityPush: Date = .distantPast
    private var lastPushedLevel: Double = -1
    private var transcriptionTasks: [String: Task<Void, Never>] = [:]
    private var observersInstalled = false
    private var recovered = false
    private var activity: Any?

    private init() {}

    /// App 启动时:恢复上次被杀时没收尾的录音,结束残留的录音灵动岛,挂上灵动岛按钮的信号。
    static func bootstrapAtLaunch() {
        Task { @MainActor in
            let controller = RecordingController.shared
            controller.installObservers()
            controller.recoverInterruptedRecordings()
            await controller.endStaleActivities()
        }
    }

    // MARK: - List

    func reload() {
        recoverInterruptedRecordings()
        recordings = store.list()
    }

    func metadata(_ id: String) -> RecordingMetadata? {
        recordings.first { $0.id == id } ?? store.load(id: id)
    }

    private func update(_ id: String, _ change: (inout RecordingMetadata) -> Void) {
        guard var meta = metadata(id) else { return }
        change(&meta)
        do { try store.save(meta) } catch {
            logger.error("[Recording] save meta failed: \(error.localizedDescription)")
        }
        if let i = recordings.firstIndex(where: { $0.id == id }) { recordings[i] = meta }
        else { recordings.insert(meta, at: 0) }
    }

    // MARK: - Recording

    var isRecording: Bool { active != nil }

    /// 开始录音。没有麦克风权限时先请求;失败返回 false 并写 lastError。
    @discardableResult
    func startRecording(title: String = "") async -> Bool {
        guard active == nil else { return true }
        installObservers()
        switch VoiceActivityDetector.microphonePermission {
        case .denied:
            lastError = String(localized: "没有麦克风权限。请在系统设置 › LeoBot 里打开麦克风。")
            return false
        case .undetermined:
            guard await VoiceActivityDetector.requestMicrophonePermission() else {
                lastError = String(localized: "没有麦克风权限。请在系统设置 › LeoBot 里打开麦克风。")
                return false
            }
        case .granted:
            break
        }
        var meta = RecordingMetadata(title: title, localeIdentifier: VoiceLanguages.lastUsed)
        meta.state = .recording
        do { try store.create(meta) } catch {
            lastError = String(localized: "无法创建录音文件:\(error.localizedDescription)")
            return false
        }
        // 真实的 `.record` 会话:锁屏后继续录靠它(已有的 audio 后台模式),不靠静音保活。
        BackgroundKeepAliveManager.shared.suspendSilentAudioForMedia(caller: "Recording")
        AudioSessionCoordinator.shared.beginAndWait(.recording)
        let session = RecordingSession(recordingId: meta.id, store: store)
        wire(session)
        do {
            try session.start()
        } catch {
            releaseAudioSession()
            try? store.delete(id: meta.id)
            lastError = error.localizedDescription
            logger.error("[Recording] start failed: \(error.localizedDescription)")
            return false
        }
        self.session = session
        recordings.insert(meta, at: 0)
        active = Active(id: meta.id, title: meta.displayTitle, isPaused: false, userPaused: false, interrupted: false, highlights: 0)
        live.elapsed = 0
        live.level = 0
        live.captionFinal = ""
        live.captionVolatile = ""
        startTicking()
        startLiveCaptions(localeIdentifier: meta.localeIdentifier)
        startActivity(meta)
        LeoHaptics.impact(.medium)
        LeoPerf.record("rec.start", ms: 0, extra: ["locale": meta.localeIdentifier])
        logger.info("[Recording] started id=\(meta.id.prefix(8))")
        return true
    }

    private func wire(_ session: RecordingSession) {
        let id = session.recordingId
        session.onChunksChanged = { [weak self] chunks in
            self?.update(id) { $0.chunks = chunks }
        }
        session.onLevel = { [weak self] level in self?.live.level = level }
        session.onWriteFailure = { [weak self] message in
            self?.lastError = String(localized: "录音写入失败:\(message)")
        }
        session.onEngineLost = { [weak self] in
            guard let self, self.active?.id == id else { return }
            self.pause(byInterruption: true)
            self.lastError = String(localized: "麦克风断开了,录音已暂停。点继续接着录。")
        }
    }

    func togglePause() {
        guard let active else { return }
        if active.isPaused { resume() } else { pause(byInterruption: false) }
    }

    func pause(byInterruption: Bool) {
        guard var a = active, let session else { return }
        if byInterruption {
            guard !a.interrupted else { return }
            session.interruptionBegan()
            a.interrupted = true
        } else {
            guard !a.isPaused else { return }
            session.pauseByUser()
            a.userPaused = true
        }
        a.isPaused = true
        active = a
        update(a.id) { $0.state = .paused }
        pushActivity(force: true)
        LeoPerf.record(byInterruption ? "rec.interrupt" : "rec.pause", ms: 0, extra: ["sec": Int(session.elapsed)])
    }

    func resume() {
        guard var a = active, a.isPaused, let session else { return }
        if a.interrupted {
            // 打断后系统收回了会话:重新声明再启动引擎。
            AudioSessionCoordinator.shared.beginAndWait(.recording)
        }
        do {
            try session.resume()
        } catch {
            lastError = error.localizedDescription
            logger.error("[Recording] resume failed: \(error.localizedDescription)")
            return
        }
        a.isPaused = false
        a.userPaused = false
        a.interrupted = false
        active = a
        update(a.id) { $0.state = .recording }
        pushActivity(force: true)
        LeoPerf.record("rec.resume", ms: 0, extra: ["sec": Int(session.elapsed)])
    }

    func markHighlight(note: String? = nil) {
        guard var a = active, let session else { return }
        let time = session.elapsed
        a.highlights += 1
        active = a
        update(a.id) { $0.highlights.append(RecordingHighlight(id: UUID().uuidString, time: time, note: note)) }
        LeoHaptics.impact(.light)
        pushActivity(force: true)
    }

    func renameActive(_ title: String) {
        guard var a = active else { return }
        let clean = RecordingMetadata.sanitizedTitle(title)
        update(a.id) { $0.title = clean }
        a.title = clean.isEmpty ? (metadata(a.id)?.displayTitle ?? a.title) : clean
        active = a
    }

    /// 停止并保存;返回录音 id。转写在停止后自动开始(本机,或你选了云端)。
    @discardableResult
    func stopRecording(autoTranscribe: Bool = true) async -> String? {
        guard let a = active, let session else { return nil }
        active = nil
        stopTicking()
        stopLiveCaptions()
        let chunks = await session.stop()
        self.session = nil
        releaseAudioSession()
        update(a.id) {
            $0.chunks = chunks
            $0.state = .finished
        }
        store.applyBackupExclusion(id: a.id)
        endActivity()
        LeoHaptics.notification(.success)
        let duration = chunks.reduce(0) { $0 + $1.duration }
        LeoPerf.record("rec.stop", ms: duration * 1000, extra: ["chunks": chunks.count])
        logger.info("[Recording] stopped id=\(a.id.prefix(8)) sec=\(Int(duration)) chunks=\(chunks.count)")
        if duration < 0.5 {
            // 什么都没录到:不留空记录。
            delete(a.id)
            return nil
        }
        if autoTranscribe { transcribe(a.id) }
        return a.id
    }

    private func releaseAudioSession() {
        AudioSessionCoordinator.shared.end(.recording)
        BackgroundKeepAliveManager.shared.resumeSilentAudioForMedia(caller: "Recording")
    }

    // MARK: - Ticking & live captions

    private func startTicking() {
        tickTimer?.invalidate()
        tickTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let session = self.session else { return }
                self.live.elapsed = session.elapsed
                self.pushActivity(force: false)
            }
        }
    }

    private func stopTicking() {
        tickTimer?.invalidate()
        tickTimer = nil
    }

    private func startLiveCaptions(localeIdentifier: String) {
        live.captionsAvailable = false
        guard #available(iOS 26.0, *),
              UserDefaults.standard.object(forKey: VoiceExperiencePreferences.liveCaptionsKey) as? Bool ?? true else { return }
        let id = active?.id
        Task { @MainActor [weak self] in
            await AppleLiveTranscriber.prewarm(localeIdentifier: localeIdentifier)
            guard let self, self.active?.id == id, let session = self.session else { return }
            guard let transcriber = AppleLiveTranscriber(localeIdentifier: localeIdentifier, contextualStrings: [],
                                                         onUpdate: { [weak self] snap in
                guard let self else { return }
                self.live.captionFinal = String(snap.finalized.suffix(400))
                self.live.captionVolatile = snap.volatile
            }) else { return }
            self.liveTranscriber = transcriber
            self.live.captionsAvailable = true
            session.liveSamples = { samples, rate in transcriber.append(samples, sampleRate: rate) }
        }
    }

    private func stopLiveCaptions() {
        session?.liveSamples = nil
        if #available(iOS 26.0, *), let t = liveTranscriber as? AppleLiveTranscriber { t.cancel() }
        liveTranscriber = nil
        live.captionsAvailable = false
    }

    // MARK: - Interruptions

    private func installObservers() {
        guard !observersInstalled else { return }
        observersInstalled = true
        let nc = NotificationCenter.default
        nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            let opts = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt
            MainActor.assumeIsolated { self?.handleInterruption(typeRaw: raw, optionsRaw: opts) }
        }
        nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.active != nil, self.active?.isPaused == false else { return }
                self.pause(byInterruption: true)
                self.lastError = String(localized: "系统音频服务重启了,录音已暂停。点继续接着录。")
            }
        }
        for name in [RecordingActivityBridge.togglePauseNotification, RecordingActivityBridge.stopNotification,
                     RecordingActivityBridge.markNotification] {
            CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), nil, { _, _, cfName, _, _ in
                guard let cfName else { return }
                let raw = cfName.rawValue as String
                Task { @MainActor in RecordingController.shared.handleActivityButton(raw) }
            }, name as CFString, nil, .deliverImmediately)
        }
    }

    private func handleInterruption(typeRaw: UInt?, optionsRaw: UInt?) {
        guard let typeRaw, let type = AVAudioSession.InterruptionType(rawValue: typeRaw), let a = active else { return }
        switch type {
        case .began:
            guard !a.interrupted else { return }
            pause(byInterruption: true)
            logger.info("[Recording] interruption began")
        case .ended:
            let shouldResume = AVAudioSession.InterruptionOptions(rawValue: optionsRaw ?? 0).contains(.shouldResume)
            logger.info("[Recording] interruption ended shouldResume=\(shouldResume)")
            // 你自己暂停的不自动继续;只有被打断的、系统说可以继续的才接着录(开新块)。
            guard a.interrupted, !a.userPaused, shouldResume else { return }
            resume()
        @unknown default:
            break
        }
    }

    private func handleActivityButton(_ name: String) {
        switch name {
        case RecordingActivityBridge.togglePauseNotification: togglePause()
        case RecordingActivityBridge.markNotification: markHighlight()
        case RecordingActivityBridge.stopNotification: Task { await stopRecording() }
        default: break
        }
    }

    // MARK: - Live Activity

    private func startActivity(_ meta: RecordingMetadata) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let attributes = RecordingActivityPayload.attributes(recordingId: meta.id, title: meta.displayTitle)
        let state = RecordingActivityPayload.state(isPaused: false, elapsed: 0, level: 0, highlightCount: 0,
                                                   statusText: String(localized: "录音中"))
        do {
            activity = try Activity.request(attributes: attributes, content: .init(state: state, staleDate: nil), pushType: nil)
        } catch {
            logger.warning("[Recording] live activity request failed: \(error.localizedDescription)")
        }
    }

    /// 计时由卡片自己走;只有状态变化或电平变化明显(每 5 秒最多一次)才推。
    private func pushActivity(force: Bool) {
        guard let activity = activity as? Activity<RecordingActivityAttributes>, let a = active, let session else { return }
        let level = Double(live.level)
        let now = Date()
        if !force {
            guard now.timeIntervalSince(lastActivityPush) >= 5, abs(level - lastPushedLevel) >= 0.15 else { return }
        }
        lastActivityPush = now
        lastPushedLevel = level
        let status: String
        if a.isPaused {
            status = a.pausedByInterruption ? String(localized: "已因来电暂停") : String(localized: "已暂停")
        } else {
            status = String(localized: "录音中")
        }
        let state = RecordingActivityPayload.state(isPaused: a.isPaused, elapsed: session.elapsed, level: level,
                                                   highlightCount: a.highlights, statusText: status)
        Task { await activity.update(.init(state: state, staleDate: nil)) }
    }

    private func endActivity() {
        guard let activity = activity as? Activity<RecordingActivityAttributes> else { return }
        self.activity = nil
        Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }

    private func endStaleActivities() async {
        for stale in Activity<RecordingActivityAttributes>.activities where stale.attributes.recordingId != active?.id {
            await stale.end(nil, dismissalPolicy: .immediate)
        }
    }

    // MARK: - Recovery

    /// 上次 App 在录音中被杀:把这条录音收尾(能读出多少算多少),不让它永远显示「录音中」。
    func recoverInterruptedRecordings() {
        guard !recovered else { return }
        recovered = true
        let store = self.store
        let activeId = active?.id
        Task { @MainActor in
            // 读目录和 meta.json 放到后台:启动路径上不碰文件。
            let stale = await Task.detached(priority: .utility) {
                store.list().filter { $0.state != .finished && $0.id != activeId }
            }.value
            guard !stale.isEmpty else { return }
            for var meta in stale where meta.id != self.active?.id {
                var chunks: [RecordingChunk] = []
                for var chunk in meta.chunks {
                    guard let url = try? store.audioURL(for: meta.id, fileName: chunk.fileName),
                          FileManager.default.fileExists(atPath: url.path) else { continue }
                    if let seconds = await RecordingAudioReader.duration(of: url) {
                        chunk.frameCount = Int64(seconds * chunk.sampleRate)
                        chunk.isOpen = false
                        chunks.append(chunk)
                    }
                }
                // 偏移按实际时长重新排一遍。
                var offset = 0.0
                for i in chunks.indices { chunks[i].startOffset = offset; offset += chunks[i].duration }
                meta.chunks = chunks
                meta.state = .finished
                try? store.save(meta)
                store.applyBackupExclusion(id: meta.id)
                LeoPerf.record("rec.recovered", ms: offset * 1000, extra: ["chunks": chunks.count])
                logger.info("[Recording] recovered interrupted recording id=\(meta.id.prefix(8)) sec=\(Int(offset))")
            }
            recordings = store.list()
        }
    }

    // MARK: - Edit / delete

    func rename(_ id: String, to title: String) {
        update(id) { $0.title = RecordingMetadata.sanitizedTitle(title) }
        if active?.id == id { renameActive(title) }
    }

    func setCloudTranscription(_ id: String, enabled: Bool) {
        update(id) { $0.cloudTranscriptionEnabled = enabled }
    }

    func renameSpeaker(_ id: String, speaker: Int, to name: String) {
        update(id) { $0.speakerNames = TranscriptAssembler.renameSpeaker($0.speakerNames, speaker: speaker, to: name) }
    }

    func delete(_ id: String) {
        guard active?.id != id else { return }
        transcriptionTasks[id]?.cancel()
        transcriptionTasks[id] = nil
        do { try store.delete(id: id) } catch {
            lastError = String(localized: "删除失败:\(error.localizedDescription)")
            return
        }
        recordings.removeAll { $0.id == id }
        LeoPerf.record("rec.delete", ms: 0)
    }

    func removeOutput(_ id: String, outputId: String) {
        update(id) { $0.outputs.removeAll { $0.id == outputId } }
    }

    // MARK: - Import

    /// 从文件 App / 分享面板导入一段音频,复制进录音目录后自动转写。
    @discardableResult
    func importAudio(from url: URL, title: String? = nil, originalName: String? = nil) async -> String? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let ext = url.pathExtension.lowercased().filter { $0.isLetter || $0.isNumber }
        let safeExt = ext.isEmpty || ext.count > 8 ? "m4a" : ext
        let base = title ?? url.deletingPathExtension().lastPathComponent
        var meta = RecordingMetadata(title: base, source: .imported, state: .finished,
                                     localeIdentifier: VoiceLanguages.lastUsed)
        meta.originalFileName = String((originalName ?? url.lastPathComponent).prefix(120))
        let fileName = "imported.\(safeExt)"
        do {
            try store.create(meta)
            let dest = try store.audioURL(for: meta.id, fileName: fileName)
            var coordError: NSError?
            var copyError: Error?
            NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordError) { readURL in
                do { try FileManager.default.copyItem(at: readURL, to: dest) } catch { copyError = error }
            }
            if let e = coordError ?? copyError { throw e }
            guard let seconds = await RecordingAudioReader.duration(of: dest) else {
                throw RecordingAudioReader.ReaderError.noAudioTrack
            }
            meta.chunks = [RecordingChunk(index: 0, fileName: fileName, startOffset: 0, sampleRate: 48_000,
                                          frameCount: Int64(seconds * 48_000), isOpen: false)]
            try store.save(meta)
            store.applyBackupExclusion(id: meta.id)
        } catch {
            try? store.delete(id: meta.id)
            lastError = String(localized: "导入失败:\(error.localizedDescription)")
            logger.error("[Recording] import failed: \(error.localizedDescription)")
            return nil
        }
        recordings = store.list()
        LeoPerf.record("rec.import", ms: meta.duration * 1000, extra: ["ext": safeExt])
        transcribe(meta.id)
        return meta.id
    }

    /// 分享扩展放进 App Group 的音频(`recording.pendingImports`)。
    func importPendingShares() async -> [String] {
        guard let defaults = SharedContainerStore.sharedDefaults,
              let dir = SharedContainerStore.sharedFileDirectory else { return [] }
        let names = defaults.stringArray(forKey: Self.pendingImportsKey) ?? []
        defaults.removeObject(forKey: Self.pendingImportsKey)
        var ids: [String] = []
        for name in names where SharedContainerStore.isSafeFileName(name) {
            let url = dir.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            // 分享扩展的暂存名是 `rec-xxxxxxxx_原文件名`。
            var original = name
            if name.hasPrefix("rec-"), let cut = name.firstIndex(of: "_") { original = String(name[name.index(after: cut)...]) }
            let title = (original as NSString).deletingPathExtension
            if let id = await importAudio(from: url, title: title, originalName: original) { ids.append(id) }
            try? FileManager.default.removeItem(at: url)
        }
        return ids
    }

    nonisolated static let pendingImportsKey = "recording.pendingImports"

    nonisolated static func isAudioFile(_ url: URL) -> Bool {
        guard url.isFileURL else { return false }
        if let type = UTType(filenameExtension: url.pathExtension.lowercased()) { return type.conforms(to: .audio) }
        return false
    }

    // MARK: - Transcription

    func isTranscribing(_ id: String) -> Bool { transcriptionTasks[id] != nil }

    /// 转写(或接着转没做完的部分)。本机默认;录音打开了云端转写才走云端。
    func transcribe(_ id: String, restart: Bool = false) {
        guard transcriptionTasks[id] == nil, let meta = metadata(id), meta.state == .finished else { return }
        let engine: RecordingTranscriptionEngine = meta.cloudTranscriptionEnabled ? .cloud : .onDevice
        // 重新转写,或换了引擎(本机 ↔ 云端):从头来,旧的分段作废。
        if restart || meta.transcription.engine != engine {
            update(id) { $0.transcription = RecordingTranscriptionState(phase: .none, engine: engine) }
            try? store.saveTranscript(RecordingTranscript(), id: id)
        }
        transcriptionTasks[id] = Task { @MainActor [weak self] in
            await self?.runTranscription(id: id, engine: engine)
            self?.transcriptionTasks[id] = nil
            self?.transcriptionProgress[id] = nil
        }
    }

    func cancelTranscription(_ id: String) {
        transcriptionTasks[id]?.cancel()
    }

    private func runTranscription(id: String, engine: RecordingTranscriptionEngine) async {
        guard let meta = metadata(id) else { return }
        let units = TranscriptionPlan.units(for: meta.chunks)
        var pending = TranscriptionPlan.pending(units, completed: meta.transcription.completedUnits)
        guard !pending.isEmpty else {
            update(id) { $0.transcription.phase = .done }
            return
        }
        update(id) {
            $0.transcription.phase = .running
            $0.transcription.engine = engine
            $0.transcription.errorMessage = nil
        }
        transcriptionProgress[id] = (units.count - pending.count, units.count)
        // 切到后台时多要一点时间把当前单元做完;做不完的下次进来接着转。
        var bgTask = UIBackgroundTaskIdentifier.invalid
        bgTask = UIApplication.shared.beginBackgroundTask(withName: "recording.transcribe") {
            UIApplication.shared.endBackgroundTask(bgTask)
            bgTask = .invalid
        }
        defer { if bgTask != .invalid { UIApplication.shared.endBackgroundTask(bgTask) } }
        let started = Date()
        var transcript = store.loadTranscript(id: id) ?? RecordingTranscript()
        while !pending.isEmpty {
            let unit = pending.removeFirst()
            if Task.isCancelled { break }
            do {
                let url = try store.audioURL(for: id, fileName: unit.fileName)
                let unitStart = Date()
                let local = try await RecordingTranscriber.transcribe(unit: unit, fileURL: url, engine: engine,
                                                                      localeIdentifier: meta.localeIdentifier)
                transcript.segments = TranscriptAssembler.merge(existing: transcript.segments, unit: unit, local: local,
                                                                approximate: engine == .cloud)
                transcript.updatedAt = Date()
                try store.saveTranscript(transcript, id: id)
                update(id) {
                    if !$0.transcription.completedUnits.contains(unit.id) { $0.transcription.completedUnits.append(unit.id) }
                    $0.transcription.updatedAt = Date()
                }
                transcriptionProgress[id] = (units.count - pending.count, units.count)
                LeoPerf.record("rec.transcribe.unit", ms: Date().timeIntervalSince(unitStart) * 1000,
                               extra: ["audioSec": Int(unit.duration), "segments": local.count, "engine": engine.rawValue])
            } catch is CancellationError {
                break
            } catch {
                let phase: RecordingTranscriptionState.Phase
                if let speech = error as? SystemSpeechError, speech.offersResourceManagement { phase = .needsAssets }
                else { phase = .failed }
                update(id) {
                    $0.transcription.phase = phase
                    $0.transcription.errorMessage = error.localizedDescription
                }
                logger.error("[Recording] transcription failed unit=\(unit.id) engine=\(engine.rawValue): \(error.localizedDescription)")
                return
            }
        }
        let finished = pending.isEmpty && !Task.isCancelled
        update(id) { $0.transcription.phase = finished ? .done : .none }
        if finished {
            LeoPerf.record("rec.transcribe", ms: Date().timeIntervalSince(started) * 1000,
                           extra: ["units": units.count, "audioSec": Int(meta.duration), "engine": engine.rawValue,
                                   "chars": transcript.characterCount])
        }
    }

    func transcript(_ id: String) -> RecordingTranscript {
        store.loadTranscript(id: id) ?? RecordingTranscript()
    }

    // MARK: - Speakers & minutes

    func inferSpeakers(_ id: String, groupId: String?) async {
        guard busyText[id] == nil, let meta = metadata(id) else { return }
        var transcript = transcript(id)
        busyText[id] = String(localized: "正在识别说话人…")
        defer { busyText[id] = nil }
        do {
            transcript.segments = try await MinutesGenerator.inferSpeakers(segments: transcript.segments, groupId: groupId) { [weak self] done, total in
                self?.busyText[id] = String(localized: "正在识别说话人 \(min(done + 1, total))/\(total)")
            }
            try store.saveTranscript(transcript, id: id)
            update(id) { $0.speakersInferred = true }
            _ = meta
        } catch is CancellationError {
        } catch {
            lastError = error.localizedDescription
        }
    }

    func clearSpeakers(_ id: String) {
        var transcript = transcript(id)
        transcript.segments = transcript.segments.map { var s = $0; s.speaker = nil; return s }
        try? store.saveTranscript(transcript, id: id)
        update(id) {
            $0.speakersInferred = false
            $0.speakerNames = [:]
        }
    }

    @discardableResult
    func generate(_ id: String, template: MinutesTemplate, customInstruction: String?, groupId: String?) async -> RecordingOutput? {
        guard busyText[id] == nil, let meta = metadata(id) else { return nil }
        let transcript = transcript(id)
        busyText[id] = String(localized: "正在准备…")
        defer { busyText[id] = nil }
        do {
            let started = try await MinutesGenerator.generate(
                meta: meta, transcript: transcript, template: template, customInstruction: customInstruction,
                groupId: groupId) { [weak self] text in self?.busyText[id] = text }
            let output = RecordingOutput(template: template.rawValue,
                                         title: "\(template.displayName) · \(meta.displayTitle)",
                                         sessionId: started.sessionId, runId: started.runId)
            update(id) { $0.outputs.insert(output, at: 0) }
            return output
        } catch is CancellationError {
            return nil
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    /// 生成完成后的正文;第一次拿到时缓存到 outputs/<id>.md。还在跑返回 nil。
    func outputText(_ id: String, output: RecordingOutput) async -> (finished: Bool, text: String?) {
        if output.hasCachedResult, let cached = store.loadOutputText(id: id, outputId: output.id) { return (true, cached) }
        let result = await MinutesGenerator.result(for: output)
        if result.finished, let text = result.text {
            try? store.saveOutputText(text, id: id, outputId: output.id)
            update(id) { meta in
                if let i = meta.outputs.firstIndex(where: { $0.id == output.id }) { meta.outputs[i].hasCachedResult = true }
            }
        }
        return result
    }

    // MARK: - Watch

    func watchStatus(message: String? = nil) -> WatchRecordingRemote.Status {
        guard let a = active else { return WatchRecordingRemote.Status(isRecording: false, isPaused: false, elapsed: 0,
                                                                       highlightCount: 0, message: message) }
        return .init(isRecording: true, isPaused: a.isPaused, elapsed: session?.elapsed ?? 0,
                     highlightCount: a.highlights, message: message)
    }

    func handleWatchCommand(_ action: WatchRecordingRemote.Action) async -> (Bool, WatchRecordingRemote.Status) {
        switch action {
        case .status:
            return (true, watchStatus())
        case .start:
            if active != nil { return (true, watchStatus()) }
            // iOS 不允许后台的 App 新开麦克风录音:手机在后台时请你在手机上点开。
            guard UIApplication.shared.applicationState != .background else {
                return (false, watchStatus(message: String(localized: "请先在 iPhone 上打开 LeoBot")))
            }
            let ok = await startRecording()
            return (ok, watchStatus(message: ok ? nil : lastError))
        case .stop:
            guard active != nil else { return (false, watchStatus(message: String(localized: "没有在录音"))) }
            let id = await stopRecording()
            return (true, watchStatus(message: id == nil ? String(localized: "太短,没有保存") : String(localized: "已保存,正在转写")))
        case .mark:
            guard active != nil else { return (false, watchStatus(message: String(localized: "没有在录音"))) }
            markHighlight()
            return (true, watchStatus())
        case .pause:
            guard let a = active, !a.isPaused else { return (active != nil, watchStatus()) }
            pause(byInterruption: false)
            return (true, watchStatus())
        case .resume:
            guard let a = active, a.isPaused else { return (active != nil, watchStatus()) }
            resume()
            return (active?.isPaused == false, watchStatus(message: active?.isPaused == true ? lastError : nil))
        }
    }
}
