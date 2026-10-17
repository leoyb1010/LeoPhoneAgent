// [leo][WP-60] LeoBot 的本地语音助手程序:听写(SpeechAnalyzer + SpeechTranscriber)与朗读(AVSpeechSynthesizer)。
//
// 为什么是独立二进制:Electron 渲染进程的 webkitSpeechRecognition 要走 Google 服务,在桌面版里不可用;
// SpeechAnalyzer 是系统自带的本地模型(macOS 26+),不用下载第三方模型,断网也能用(语言资源首次需下载一次)。
// 形态仿 native/macos-window-bounds:无 bundle 的命令行程序,stdout 一行一个 JSON,父进程逐行读。
//
// 用法:
//   leo-speech serve [--locale zh-CN] [--no-vocab]   常驻:先把识别模型与分析器备好(不碰麦克风),再按 stdin 指令逐段听写。
//       stdin 每行一个 JSON 指令:{"cmd":"start"} 开麦 | {"cmd":"start","file":"<音频>"} 用文件按实时速度代替麦克风
//       (开发态端到端验证用,不碰麦克风权限)| {"cmd":"stop"} 收尾出 final | {"cmd":"cancel"} 丢弃 | EOF 退出。
//   leo-speech transcribe <音频文件> [--locale zh-CN] [--no-vocab]   转写一个音频文件(验证 / 调试 / 词表对比用)
//   leo-speech speak [--rate 0.5] [--voice <identifier>]  朗读 stdin 里的全部文字,读完退出
//   leo-speech status [--locale zh-CN]      语言是否支持、资源是否已装、麦克风授权状态
//
// 输出(每行一个 JSON):
//   {"type":"warm","locale":"zh_CN"}                serve:模型已就绪,可以随时 start(每段结束后会自动备好下一段)
//   {"type":"ready","locale":"zh_CN"}               开始收音
//   {"type":"installing"}                            正在下载该语言的系统语音资源
//   {"type":"partial","text":"…"}                    当前完整文本(已定稿 + 正在变化的部分),随时可能被下一条覆盖
//   {"type":"final","text":"…"}                      整段最终文本
//   {"type":"error","code":"…","message":"…"}        code: mic_denied | unsupported_locale | asset_unavailable | audio | failed
//   {"type":"done"}                                  这一段结束(serve 进程继续常驻;其余子命令随后退出)

import AVFoundation
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
        let line = String(data: data, encoding: .utf8)
    else { return }
    print(line)
}

func fail(_ code: String, _ message: String) -> Never {
    emit(["type": "error", "code": code, "message": message])
    exit(1)
}

func option(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
    return args[index + 1]
}

let command = CommandLine.arguments.dropFirst().first ?? ""
let requestedLocale = Locale(identifier: option("--locale") ?? Locale.current.identifier)

/// 文本合并:定稿片段依次累加;未定稿(volatile)的只保留最新一段,下一次结果会把它整段替换掉。
final class TranscriptAccumulator: @unchecked Sendable {
    private var finalized = ""
    private var volatile = ""
    private let lock = NSLock()

    func apply(text: String, isFinal: Bool) -> String {
        lock.lock()
        defer { lock.unlock() }
        if isFinal {
            finalized += text
            volatile = ""
        } else {
            volatile = text
        }
        return finalized + volatile
    }

    var full: String {
        lock.lock()
        defer { lock.unlock() }
        return finalized + volatile
    }
}

/// 中英混说时系统模型常把技术词听成同音中文(「提交一个 PR」→「提交一个皮二」)。
/// AnalysisContext.contextualStrings 给识别器一份偏好词表;--no-vocab 关掉,用来做前后对比。
let vocabulary = [
    "pull request", "PR", "commit", "push", "pull", "merge", "rebase", "branch", "main", "diff",
    "Claude", "Claude Code", "Codex", "LeoBot", "GitHub", "Git", "README", "API", "SDK", "MCP",
    "token", "prompt", "bug", "debug", "build", "deploy", "release", "npm", "pnpm", "TypeScript",
    "Swift", "Xcode", "iOS", "macOS", "Electron", "JSON", "terminal", "worktree", "agent",
]

@available(macOS 26, *)
func makeContext() -> AnalysisContext {
    let context = AnalysisContext()
    if !CommandLine.arguments.contains("--no-vocab") {
        context.contextualStrings[.general] = vocabulary
    }
    return context
}

@available(macOS 26, *)
func makeTranscriber(_ locale: Locale) -> SpeechTranscriber {
    SpeechTranscriber(
        locale: locale,
        transcriptionOptions: [],
        reportingOptions: [.volatileResults, .fastResults],
        attributeOptions: []
    )
}

/// 选定语言并确保系统语言资源已装(没装就请求安装,只需联网一次,装好后离线可用)。
@available(macOS 26, *)
func resolveLocale() async -> Locale {
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requestedLocale) else {
        fail("unsupported_locale", "系统语音识别不支持 \(requestedLocale.identifier)")
    }
    do {
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [makeTranscriber(locale)]) {
            emit(["type": "installing"])
            try await request.downloadAndInstall()
        }
    } catch {
        fail("asset_unavailable", "语音资源安装失败:\(error.localizedDescription)")
    }
    return locale
}

@available(macOS 26, *)
func consumeTranscriber(_ transcriber: SpeechTranscriber, into accumulator: TranscriptAccumulator) -> Task<Void, Error> {
    Task {
        for try await result in transcriber.results {
            let text = String(result.text.characters)
            let full = accumulator.apply(text: text, isFinal: result.isFinal)
            emit(["type": "partial", "text": full])
        }
    }
}

@available(macOS 26, *)
func transcribeFile(_ path: String) async {
    let transcriber = makeTranscriber(await resolveLocale())
    let accumulator = TranscriptAccumulator()
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let results = consumeTranscriber(transcriber, into: accumulator)
    do {
        try await analyzer.setContext(makeContext())
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
        if let end = try await analyzer.analyzeSequence(from: file) {
            try await analyzer.finalizeAndFinish(through: end)
        } else {
            await analyzer.cancelAndFinishNow()
        }
        try await results.value
    } catch {
        fail("failed", error.localizedDescription)
    }
    emit(["type": "final", "text": accumulator.full])
    emit(["type": "done"])
}

func microphoneAuthorized() async -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return true
    case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
    default: return false
    }
}

/// 把麦克风的 PCM 转成分析器要的格式后送进 AsyncStream。
@available(macOS 26, *)
final class MicrophoneFeed: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    /// 只有真的开了麦克风才去碰 inputNode:取 inputNode 本身就可能触发麦克风授权弹窗。
    private var usingMicrophone = false
    let stream: AsyncStream<AnalyzerInput>
    private let continuation: AsyncStream<AnalyzerInput>.Continuation

    init() {
        (stream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
    }

    func start(format target: AVAudioFormat) throws {
        usingMicrophone = true
        let input = engine.inputNode
        let source = input.outputFormat(forBus: 0)
        converter = AVAudioConverter(from: source, to: target)
        input.installTap(onBus: 0, bufferSize: 4096, format: source) { [weak self] buffer, _ in
            guard let self, let converter = self.converter else { return }
            let ratio = target.sampleRate / source.sampleRate
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
            guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
            var consumed = false
            var error: NSError?
            converter.convert(to: out, error: &error) { _, status in
                if consumed {
                    status.pointee = .noDataNow
                    return nil
                }
                consumed = true
                status.pointee = .haveData
                return buffer
            }
            if error == nil, out.frameLength > 0 {
                self.continuation.yield(AnalyzerInput(buffer: out))
            }
        }
        engine.prepare()
        try engine.start()
    }

    /// 开发验证:按实时速度把音频文件喂给分析器,行为与麦克风一致(partial 逐步出现)。
    func startFile(_ path: String, format target: AVAudioFormat) throws {
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
        let source = file.processingFormat
        guard let converter = AVAudioConverter(from: source, to: target) else { throw CocoaError(.fileReadCorruptFile) }
        let chunk = AVAudioFrameCount(source.sampleRate / 10)
        Task.detached { [continuation] in
            while true {
                guard let buffer = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: chunk) else { break }
                do { try file.read(into: buffer, frameCount: chunk) } catch { break }
                if buffer.frameLength == 0 { break }
                let capacity = AVAudioFrameCount(Double(buffer.frameLength) * target.sampleRate / source.sampleRate) + 1024
                guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { break }
                var consumed = false
                converter.convert(to: out, error: nil) { _, status in
                    if consumed { status.pointee = .noDataNow; return nil }
                    consumed = true
                    status.pointee = .haveData
                    return buffer
                }
                continuation.yield(AnalyzerInput(buffer: out))
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }
    }

    func stop() {
        if usingMicrophone {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        continuation.finish()
    }
}

/// 一段听写所需的、可以提前备好的东西。分析器结束(finish)后不能复用,所以每段用完立刻备下一套。
@available(macOS 26, *)
struct PreparedAnalyzer: Sendable {
    let analyzer: SpeechAnalyzer
    let transcriber: SpeechTranscriber
    /// 实测(本机 macOS 27,开头无静音的音频按实时喂入):SpeechTranscriber 首字 ~1.05s,预热也压不下去(模型自身攒音频);
    /// DictationTranscriber 首字 ~0.53s 但中英混说明显更差。两个模块挂在同一个分析器上:
    /// SpeechTranscriber 出字之前先显示 Dictation 的临时文字,出字后整段换成 SpeechTranscriber 的,最终文本只用它的。
    let early: DictationTranscriber?
    let format: AVAudioFormat
}

/// [WP-60 预热] 之前每次按键才拉起进程、装资源、建分析器、加载模型(~1.2s,这段时间说的话会丢)。
/// 现在这些都在按键前做完;模型用 processLifetime 留在内存里,下一套分析器几乎零成本。
@available(macOS 26, *)
func prepareAnalyzer(_ locale: Locale, early earlyLocale: Locale?) async throws -> PreparedAnalyzer {
    let transcriber = makeTranscriber(locale)
    let early = earlyLocale.map {
        DictationTranscriber(
            locale: $0, contentHints: [], transcriptionOptions: [.punctuation],
            reportingOptions: [.volatileResults], attributeOptions: []
        )
    }
    let modules: [any SpeechModule] = [transcriber] + (early.map { [$0] } ?? [])
    let analyzer = SpeechAnalyzer(
        modules: modules,
        options: .init(priority: .userInitiated, modelRetention: .processLifetime)
    )
    try await analyzer.setContext(makeContext())
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: modules) else {
        throw CocoaError(.featureUnsupported)
    }
    try await analyzer.prepareToAnalyze(in: format)
    return PreparedAnalyzer(analyzer: analyzer, transcriber: transcriber, early: early, format: format)
}

/// Dictation 模块的资源装不上就不用它(只是首字慢一点),不影响听写本身。
@available(macOS 26, *)
func resolveEarlyLocale() async -> Locale? {
    guard let locale = await DictationTranscriber.supportedLocale(equivalentTo: requestedLocale) else { return nil }
    let probe = DictationTranscriber(
        locale: locale, contentHints: [], transcriptionOptions: [], reportingOptions: [], attributeOptions: []
    )
    do {
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [probe]) {
            try await request.downloadAndInstall()
        }
        return locale
    } catch {
        return nil
    }
}

/// 一段听写的两路结果:SpeechTranscriber 有字就用它,否则先用 Dictation 的。
@available(macOS 26, *)
func consume(_ prepared: PreparedAnalyzer, into main: TranscriptAccumulator) -> Task<Void, Error> {
    let early = TranscriptAccumulator()
    let report = { emit(["type": "partial", "text": main.full.isEmpty ? early.full : main.full]) }
    let earlyTask = prepared.early.map { module in
        Task {
            for try await result in module.results {
                _ = early.apply(text: String(result.text.characters), isFinal: result.isFinal)
                if main.full.isEmpty { report() }
            }
        }
    }
    return Task {
        for try await result in prepared.transcriber.results {
            _ = main.apply(text: String(result.text.characters), isFinal: result.isFinal)
            report()
        }
        _ = try await earlyTask?.value
        if main.full.isEmpty { _ = main.apply(text: early.full, isFinal: true) }
    }
}

struct ServeCommand {
    let cmd: String
    let file: String?

    init?(_ line: String) {
        guard let data = line.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let cmd = object["cmd"] as? String
        else { return nil }
        self.cmd = cmd
        file = object["file"] as? String
    }
}

@available(macOS 26, *)
func serve() async {
    let locale = await resolveLocale()
    let earlyLocale = await resolveEarlyLocale()
    let (commands, sink) = AsyncStream.makeStream(of: ServeCommand.self)
    Task.detached {
        while let line = readLine() {
            if let command = ServeCommand(line) { sink.yield(command) }
        }
        sink.finish()
    }
    var next = Task { try await prepareAnalyzer(locale, early: earlyLocale) }
    do {
        _ = try await next.value
    } catch {
        fail("failed", "语音模型准备失败:\(error.localizedDescription)")
    }
    emit(["type": "warm", "locale": locale.identifier])
    var iterator = commands.makeAsyncIterator()
    var micChecked = false
    while let command = await iterator.next() {
        guard command.cmd == "start" else { continue }
        if command.file == nil, !micChecked {
            guard await microphoneAuthorized() else {
                emit(["type": "error", "code": "mic_denied", "message": "没有麦克风权限:系统设置 > 隐私与安全性 > 麦克风 里允许 LeoBot"])
                emit(["type": "done"])
                continue
            }
            micChecked = true
        }
        let prepared: PreparedAnalyzer
        do {
            prepared = try await next.value
        } catch {
            fail("failed", "语音模型准备失败:\(error.localizedDescription)")
        }
        let accumulator = TranscriptAccumulator()
        let feed = MicrophoneFeed()
        let results = consume(prepared, into: accumulator)
        do {
            if let file = command.file {
                try feed.startFile(file, format: prepared.format)
            } else {
                try feed.start(format: prepared.format)
            }
            try await prepared.analyzer.start(inputSequence: feed.stream)
        } catch {
            feed.stop()
            await prepared.analyzer.cancelAndFinishNow()
            emit(["type": "error", "code": "audio", "message": "麦克风启动失败:\(error.localizedDescription)"])
            emit(["type": "done"])
            next = Task { try await prepareAnalyzer(locale, early: earlyLocale) }
            continue
        }
        emit(["type": "ready", "locale": locale.identifier])
        // 等 stop / cancel;父进程没了(EOF)也收尾。
        var cancelled = false
        while let inner = await iterator.next() {
            if inner.cmd == "stop" { break }
            if inner.cmd == "cancel" { cancelled = true; break }
        }
        feed.stop()
        if cancelled {
            await prepared.analyzer.cancelAndFinishNow()
            results.cancel()
        } else {
            do {
                try await prepared.analyzer.finalizeAndFinishThroughEndOfInput()
                try await results.value
                emit(["type": "final", "text": accumulator.full])
            } catch {
                emit(["type": "error", "code": "failed", "message": error.localizedDescription])
            }
        }
        emit(["type": "done"])
        next = Task { try await prepareAnalyzer(locale, early: earlyLocale) }
    }
}

/// 朗读:AVSpeechSynthesizer 的代理回调在主线程,用 RunLoop 等它读完。
final class SpeakDelegate: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    var finished = false
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        finished = true
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        finished = true
    }
}

func speak() {
    let text = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !text.isEmpty else {
        emit(["type": "done"])
        exit(0)
    }
    let synthesizer = AVSpeechSynthesizer()
    let delegate = SpeakDelegate()
    synthesizer.delegate = delegate
    let utterance = AVSpeechUtterance(string: text)
    if let identifier = option("--voice"), let voice = AVSpeechSynthesisVoice(identifier: identifier) {
        utterance.voice = voice
    } else {
        // 按文字里有没有汉字挑系统默认中文 / 英文声音。
        let hasHan = text.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) }
        utterance.voice = AVSpeechSynthesisVoice(language: hasHan ? "zh-CN" : "en-US")
    }
    if let rate = option("--rate").flatMap(Float.init) {
        utterance.rate = max(AVSpeechUtteranceMinimumSpeechRate, min(AVSpeechUtteranceMaximumSpeechRate, rate))
    }
    signal(SIGTERM) { _ in exit(0) }
    synthesizer.speak(utterance)
    emit(["type": "ready"])
    while !delegate.finished {
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
    }
    emit(["type": "done"])
}

@available(macOS 26, *)
func status() async {
    let supported = await SpeechTranscriber.supportedLocale(equivalentTo: requestedLocale)
    var installed = false
    if let locale = supported {
        let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
        installed = await AssetInventory.status(forModules: [transcriber]) == .installed
    }
    let mic: String
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: mic = "granted"
    case .denied, .restricted: mic = "denied"
    default: mic = "undetermined"
    }
    emit([
        "type": "status",
        "locale": supported?.identifier ?? NSNull(),
        "supported": supported != nil,
        "installed": installed,
        "microphone": mic,
    ])
}

guard #available(macOS 26, *) else {
    fail("unsupported_os", "需要 macOS 26 或更新版本")
}

switch command {
case "serve":
    await serve()
case "transcribe":
    guard CommandLine.arguments.count > 2 else { fail("failed", "用法:leo-speech transcribe <音频文件>") }
    await transcribeFile(CommandLine.arguments[2])
case "speak":
    speak()
case "status":
    await status()
default:
    fail("failed", "未知子命令 \(command);可用:serve | transcribe | speak | status")
}
