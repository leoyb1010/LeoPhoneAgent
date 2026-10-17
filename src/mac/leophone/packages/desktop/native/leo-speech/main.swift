// [leo][WP-60] LeoBot 的本地语音助手程序:听写(SpeechAnalyzer + SpeechTranscriber)与朗读(AVSpeechSynthesizer)。
//
// 为什么是独立二进制:Electron 渲染进程的 webkitSpeechRecognition 要走 Google 服务,在桌面版里不可用;
// SpeechAnalyzer 是系统自带的本地模型(macOS 26+),不用下载第三方模型,断网也能用(语言资源首次需下载一次)。
// 形态仿 native/macos-window-bounds:无 bundle 的命令行程序,stdout 一行一个 JSON,父进程逐行读。
//
// 用法:
//   leo-speech listen [--locale zh-CN] [--file <音频>]   麦克风流式听写;stdin 收到一行 "stop" 或 EOF 时收尾并退出。
//                                           --file 用音频文件按实时速度代替麦克风(开发态端到端验证用,不碰麦克风权限)
//   leo-speech transcribe <音频文件> [--locale zh-CN]   转写一个音频文件(验证 / 调试用)
//   leo-speech speak [--rate 0.5] [--voice <identifier>]  朗读 stdin 里的全部文字,读完退出
//   leo-speech status [--locale zh-CN]      语言是否支持、资源是否已装、麦克风授权状态
//
// 输出(每行一个 JSON):
//   {"type":"ready","locale":"zh_CN"}               开始收音
//   {"type":"installing"}                            正在下载该语言的系统语音资源
//   {"type":"partial","text":"…"}                    当前完整文本(已定稿 + 正在变化的部分),随时可能被下一条覆盖
//   {"type":"final","text":"…"}                      整段最终文本
//   {"type":"error","code":"…","message":"…"}        code: mic_denied | unsupported_locale | asset_unavailable | audio | failed
//   {"type":"done"}                                  正常结束

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

@available(macOS 26, *)
func makeTranscriber() async -> SpeechTranscriber {
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requestedLocale) else {
        fail("unsupported_locale", "系统语音识别不支持 \(requestedLocale.identifier)")
    }
    let transcriber = SpeechTranscriber(
        locale: locale,
        transcriptionOptions: [],
        reportingOptions: [.volatileResults, .fastResults],
        attributeOptions: []
    )
    // 语言资源由系统统一管理:没装就请求安装(只需联网一次),装好后离线可用。
    do {
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            emit(["type": "installing"])
            try await request.downloadAndInstall()
        }
    } catch {
        fail("asset_unavailable", "语音资源安装失败:\(error.localizedDescription)")
    }
    return transcriber
}

@available(macOS 26, *)
func consume(_ transcriber: SpeechTranscriber, into accumulator: TranscriptAccumulator) -> Task<Void, Error> {
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
    let transcriber = await makeTranscriber()
    let accumulator = TranscriptAccumulator()
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let results = consume(transcriber, into: accumulator)
    do {
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

@available(macOS 26, *)
func listen() async {
    let testFile = option("--file")
    if testFile == nil, !(await microphoneAuthorized()) {
        fail("mic_denied", "没有麦克风权限:系统设置 > 隐私与安全性 > 麦克风 里允许 LeoBot")
    }
    let transcriber = await makeTranscriber()
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
        fail("audio", "没有可用的音频格式")
    }
    let accumulator = TranscriptAccumulator()
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let feed = MicrophoneFeed()
    let results = consume(transcriber, into: accumulator)
    do {
        try await analyzer.prepareToAnalyze(in: format)
        if let testFile { try feed.startFile(testFile, format: format) } else { try feed.start(format: format) }
        try await analyzer.start(inputSequence: feed.stream)
    } catch {
        fail("audio", "麦克风启动失败:\(error.localizedDescription)")
    }
    emit(["type": "ready", "locale": transcriber.selectedLocales.first?.identifier ?? requestedLocale.identifier])
    // 父进程松开快捷键时写 "stop";父进程没了(stdin EOF)也收尾。
    await Task.detached {
        while let line = readLine() {
            if line.trimmingCharacters(in: .whitespaces) == "stop" { break }
        }
    }.value
    feed.stop()
    do {
        try await analyzer.finalizeAndFinishThroughEndOfInput()
        try await results.value
    } catch {
        fail("failed", error.localizedDescription)
    }
    emit(["type": "final", "text": accumulator.full])
    emit(["type": "done"])
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
case "listen":
    await listen()
case "transcribe":
    guard CommandLine.arguments.count > 2 else { fail("failed", "用法:leo-speech transcribe <音频文件>") }
    await transcribeFile(CommandLine.arguments[2])
case "speak":
    speak()
case "status":
    await status()
default:
    fail("failed", "未知子命令 \(command);可用:listen | transcribe | speak | status")
}
