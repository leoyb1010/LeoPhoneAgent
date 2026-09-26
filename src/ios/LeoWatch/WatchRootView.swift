//
//  WatchRootView.swift
//  LeoWatch
//
//  The watch is for talking: speak, read (or hear) the answer. Two vertical
//  pages — Ask and History — plus the approval card that pops over either when
//  a Mac is waiting on a yes/no. Task lists, schedules and session browsing
//  live on the phone.
//

import AVFoundation
import SwiftUI
import WatchKit

struct WatchRootView: View {
    @EnvironmentObject private var client: WatchConnectivityClient
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("leo.watch.autoSpeak") private var autoSpeak = true
    /// Read the whole answer instead of its first few sentences.
    @AppStorage("leo.watch.speakFull") private var speakFull = false
    @ObservedObject private var speaker = WatchSpeaker.shared

    var body: some View {
        TabView {
            AskPage()
            HistoryPage()
        }
        .tabViewStyle(.verticalPage)
        .reducedResourceAware()
        // [T-leogateway] An approval outranks whatever page you were on:
        // a Mac is sitting blocked until this is answered.
        // Writable binding: watchOS sheets are swipe-dismissible, and a no-op
        // setter would leave pendingApproval set with the card gone — the
        // approval would then be unanswerable from the wrist forever.
        .sheet(item: $client.pendingApproval) { approval in
            WatchApprovalSheet(approval: approval) { choice in
                client.answerApproval(choice: choice)
            }
        }
        // [T-watch-speak-stream] Read as it is written: each sentence goes out
        // the moment it is complete, not after the whole answer.
        .onChange(of: client.partialPulse) { _, _ in
            guard autoSpeak, scenePhase == .active, case .waiting = client.askState else { return }
            speaker.streamFeed(client.partialText, round: client.partialRound, full: speakFull)
        }
        .onChange(of: client.replyPulse) { _, _ in
            guard case .replied(let text) = client.askState, !client.lastReplyFailed else {
                speaker.stop()
                return
            }
            // Wrist down: finish() kept it for the next raise (no audio out of nowhere).
            guard autoSpeak, scenePhase == .active else { return }
            speaker.streamFinish(text, full: speakFull)
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                // [T-watch-wrist-down] An answer that landed with the wrist
                // down is read out if the wrist comes back within 5 minutes.
                // Continue a read that the wrist drop paused, then add what
                // arrived meanwhile.
                speaker.resume()
                if let pending = client.takePendingSpeech(), autoSpeak {
                    speaker.streamFinish(pending, full: speakFull)
                }
            case .inactive:
                speaker.pause()
            case .background:
                speaker.pause()
                // The foreground request dies with the suspended app.
                client.handOffToBackground()
            @unknown default:
                break
            }
        }
    }
}

/// Wrist-sized approval card. Choices come from the gateway, one button per
/// row so a 45mm screen never truncates a label into ambiguity.
///
/// Tap-only: the crown scrolls this card, so it must never also decide it.
/// Risk is shown (color + label), never an extra step — a one-person tool
/// shouldn't make its owner jump through hoops.
private struct WatchApprovalSheet: View {
    let approval: WatchApproval
    let onChoose: (String) -> Void

    private func label(for choice: String) -> String {
        switch choice {
        case "once": return "允许一次"
        case "session": return "本次会话允许"
        case "always": return "始终允许"
        case "deny": return "拒绝"
        default: return choice
        }
    }

    private var riskColor: Color {
        switch approval.risk {
        case "high": return .red
        case "low": return .green
        default: return .orange
        }
    }

    private var riskLabel: String {
        switch approval.risk {
        case "high": return "高风险"
        case "low": return "只读"
        default: return "会改动"
        }
    }

    /// Allow-once first, deny last — same order as the phone's notification.
    /// Double tap (Series 9 / Ultra 2) is "allow once": answering from the
    /// wrist should take one gesture.
    private var visibleChoices: [String] {
        let order = ["once", "session", "always", "deny"]
        return approval.choices.sorted { (order.firstIndex(of: $0) ?? order.count) < (order.firstIndex(of: $1) ?? order.count) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 6) {
                    Image(systemName: "hand.raised.fill").foregroundStyle(riskColor)
                    Text("需要审批").font(.headline)
                    Spacer(minLength: 4)
                    Text(riskLabel)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(riskColor)
                }
                if !approval.detail.isEmpty {
                    // Capped and scrollable on its own: a long diff must not
                    // push the buttons off the first screen.
                    ScrollView {
                        Text(approval.detail)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 64)
                    .padding(6)
                    .background(riskColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                }
                ForEach(visibleChoices, id: \.self) { choice in
                    Button {
                        onChoose(choice)
                    } label: {
                        Text(label(for: choice)).frame(maxWidth: .infinity)
                    }
                    .tint(choice == "deny" ? .gray : riskColor)
                    .handGestureShortcut(.primaryAction, isEnabled: choice == "once")
                }
            }
            .padding(.horizontal, 4)
        }
    }
}

// MARK: - Page 1: Ask

private struct AskPage: View {
    @EnvironmentObject private var client: WatchConnectivityClient
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject private var standalone = WatchStandaloneClient.shared
    @StateObject private var recorder = WatchVoiceRecorder.shared
    @State private var pulseTrigger = 0
    @State private var showReply = false
    /// The question whose answer page already opened while streaming.
    @State private var streamSheetShownFor: String?

    private var isWaiting: Bool {
        if case .waiting = client.askState { return true }
        return false
    }

    var body: some View {
        VStack(spacing: 8) {
            ZStack {
                LifeRing(state: ringState)
                    .frame(width: 92, height: 92)
                RadarPulseOnce(trigger: pulseTrigger)
                    .frame(width: 92, height: 92)
                primaryControl
            }
            Text(statusLine)
                .font(.caption2)
                .foregroundStyle(client.lastActionMessage == nil ? Color.secondary : Color.orange)
                .lineLimit(3)
                .multilineTextAlignment(.center)
                .contentTransition(.opacity)
                .animation(.easeOut(duration: 0.2), value: statusLine)
        }
        .sheet(isPresented: $showReply) { ReplySheet() }
        .onChange(of: client.replyPulse) { _, _ in showReply = true }
        // [T-watch-stream] Open the answer page as soon as the first words
        // arrive — once per question, so "收起" sticks.
        .onChange(of: client.partialPulse) { _, _ in
            guard case .waiting(let id, _) = client.askState, id != streamSheetShownFor,
                  !client.partialText.isEmpty else { return }
            streamSheetShownFor = id
            showReply = true
        }
        // Siri / Action Button "问 Leo" can land on a cold launch (appear), on a
        // suspended app coming back (active) or on the app already in front.
        .onAppear(perform: consumePendingVoiceAsk)
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { consumePendingVoiceAsk() }
        }
        .onReceive(NotificationCenter.default.publisher(for: AskLeoIntent.requested)) { _ in
            consumePendingVoiceAsk()
        }
    }

    /// Dictation can't be opened programmatically, so only the phone route
    /// starts listening by itself; the flag is cleared either way.
    private func consumePendingVoiceAsk() {
        guard UserDefaults.standard.bool(forKey: AskLeoIntent.pendingKey) else { return }
        UserDefaults.standard.set(false, forKey: AskLeoIntent.pendingKey)
        if client.route == .phone, !recorder.isRecording, !isWaiting { toggleVoice() }
    }

    /// The phone is working on something of its own (not this wrist's ask).
    private var phoneBusy: Bool {
        client.route == .phone && (client.state == "running" || client.state == "waiting_for_user")
    }

    /// One control that becomes whatever the moment needs: mic → level bars
    /// while recording (tap sends) → stop while waiting (tap cancels). The
    /// Button keeps its identity across mic ⇄ stop so the symbol morphs
    /// instead of snapping. Without the phone the watch dictates and answers
    /// directly; with neither, the mic is off and the line below says why.
    @ViewBuilder
    private var primaryControl: some View {
        if isWaiting || recorder.isRecording || client.route == .phone {
            Button(action: primaryAction) { primaryLabel }
                .buttonStyle(.plain)
                .handGestureShortcut(.primaryAction)
                .accessibilityLabel(isWaiting ? "停止" : (recorder.isRecording ? "发送" : "说话"))
        } else if client.route == .direct {
            TextFieldLink(prompt: Text("说吧")) {
                primaryLabel
            } onSubmit: { text in
                pulseTrigger += 1
                client.ask(text)
            }
            .buttonStyle(.plain)
            .handGestureShortcut(.primaryAction)
            .accessibilityLabel("说话")
        } else {
            primaryLabel.opacity(0.35).accessibilityLabel("暂不可用")
        }
    }

    private var primaryLabel: some View {
        Group {
            if recorder.isRecording {
                LiveLevelBars(level: recorder.level)
            } else {
                Image(systemName: isWaiting ? "stop.fill" : "mic.fill")
                    .font(.title2)
                    .foregroundStyle(isWaiting ? Color.orange : Color.teal)
                    .contentTransition(.symbolEffect(.replace))
            }
        }
        .frame(width: 72, height: 72)
        .contentShape(Circle())
    }

    private var ringState: String {
        if isWaiting || (phoneBusy && client.lastActionMessage == nil) { return "running" }
        if case .replied = client.askState { return client.lastReplyFailed ? "failed" : "completed" }
        return client.lastActionMessage == nil ? "idle" : "failed"
    }

    private var statusLine: String {
        if recorder.isRecording { return "说完再点一下发送" }
        if isWaiting {
            if !client.partialStep.isEmpty { return "\(client.partialStep)… 点一下停止" }
            return client.route == .direct
                ? "\(standalone.config?.modelName ?? "模型")正在回答… 点一下停止"
                : "iPhone 上的 Leo 正在处理… 点一下停止"
        }
        if let message = client.lastActionMessage { return message }
        if phoneBusy {
            let what = client.activeCount > 1 ? "\(client.activeCount) 个任务" : "任务"
            let lead = client.state == "waiting_for_user" ? "iPhone 上的\(what)在等你处理" : "iPhone 上的\(what)在跑"
            return client.status.isEmpty ? lead : "\(lead) · \(client.status)"
        }
        switch client.route {
        case .phone: return "点一下说话 · 经 iPhone"
        case .direct:
            let tools = standalone.toolServerNames.isEmpty ? "" : " · 可用 \(standalone.toolServerNames.joined(separator: "、"))"
            return "点一下说话 · 直连 \(standalone.config?.modelName ?? "")\(tools)"
        case nil: return standalone.unavailableReason ?? "iPhone 不在身边，也没有可直连的模型。"
        }
    }

    private func primaryAction() {
        if isWaiting {
            client.cancelAsk()
        } else {
            toggleVoice()
        }
    }

    /// [T-watch-native-voice] One tap records with the product's own pipeline;
    /// second tap sends.
    private func toggleVoice() {
        if recorder.isRecording {
            if let audio = recorder.stop() {
                client.askAudio(audio)
            } else {
                WKInterfaceDevice.current().play(.failure)
                client.noteTooShort()
            }
            return
        }
        WatchSpeaker.shared.stop()   // the mic always wins over read-aloud
        client.wakePhone()
        recorder.onAutoStop = { data in Task { @MainActor in client.askAudio(data) } }
        pulseTrigger += 1
        Task {
            if await !recorder.start() {
                client.noteMicUnavailable()
            }
        }
    }
}

private struct ReplySheet: View {
    @EnvironmentObject private var client: WatchConnectivityClient
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var speaker = WatchSpeaker.shared
    @AppStorage("leo.watch.speakFull") private var speakFull = false

    private var isWaiting: Bool {
        if case .waiting = client.askState { return true }
        return false
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if case .replied(let text) = client.askState {
                        Text(text)
                            .font(.footnote)
                            .settleIn(trigger: client.replyPulse)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        HStack {
                            Button {
                                speaker.toggle(text, full: speakFull)
                            } label: {
                                Image(systemName: speaker.isSpeaking ? "stop.fill" : "speaker.wave.2.fill")
                                    .contentTransition(.symbolEffect(.replace))
                            }
                            .accessibilityLabel(speaker.isSpeaking ? "停止朗读" : "朗读")
                            TextFieldLink(prompt: Text("追问")) {
                                Image(systemName: "mic.fill")
                            } onSubmit: { followUp in
                                speaker.stop()
                                dismiss()
                                client.ask(followUp)
                            }
                            .accessibilityLabel("追问")
                        }
                    } else if isWaiting {
                        // [T-watch-stream] The answer as it is being written.
                        if !client.partialText.isEmpty {
                            Text(client.partialText)
                                .font(.footnote)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .animation(.easeOut(duration: 0.15), value: client.partialText)
                        }
                        HStack(spacing: 6) {
                            WorkingBars().frame(width: 18, height: 12)
                            Text(client.partialStep.isEmpty ? "正在回答…" : client.partialStep)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        Button(role: .destructive) {
                            speaker.stop()
                            client.cancelAsk()
                            dismiss()
                        } label: {
                            Label("停止", systemImage: "stop.fill")
                        }
                    } else {
                        WorkingBars().padding(.top, 20)
                    }
                    Color.clear.frame(height: 1).id("replyBottom")
                }
            }
            .onChange(of: client.partialPulse) { _, _ in
                guard isWaiting else { return }
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("replyBottom", anchor: .bottom) }
            }
        }
        .navigationTitle("Leo")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                // While it is still answering, closing only hides the page.
                Button(isWaiting ? "收起" : "完成") {
                    if !isWaiting {
                        speaker.stop()
                        client.askState = .idle
                    }
                    dismiss()
                }
            }
        }
    }
}

// MARK: - Page 2: History

private struct HistoryPage: View {
    @EnvironmentObject private var client: WatchConnectivityClient
    @AppStorage("leo.watch.autoSpeak") private var autoSpeak = true
    @AppStorage("leo.watch.speakFull") private var speakFull = false

    var body: some View {
        NavigationStack {
            List {
                if client.history.isEmpty {
                    Text("问过的问题会留在这里。")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                ForEach(client.history) { entry in
                    NavigationLink {
                        HistoryDetail(entry: entry)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.question).font(.caption).lineLimit(1)
                            Text(entry.answer).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                }
                Section {
                    Toggle("自动朗读回答", isOn: $autoSpeak)
                        .font(.caption)
                    Picker("朗读", selection: $speakFull) {
                        Text("前几句").tag(false)
                        Text("全文").tag(true)
                    }
                    .font(.caption)
                } footer: {
                    Text("边回答边读：第一句写完就开始读。抬着手腕时自动读，放下就暂停；放下手腕时答完的，5 分钟内抬腕会读出来。")
                }
            }
            .navigationTitle("记录")
        }
    }
}

private struct HistoryDetail: View {
    let entry: WatchHistoryEntry
    @ObservedObject private var speaker = WatchSpeaker.shared
    @AppStorage("leo.watch.speakFull") private var speakFull = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text(entry.question).font(.caption).foregroundStyle(.secondary)
                Text(entry.answer).font(.footnote)
                HStack(spacing: 6) {
                    Image(systemName: entry.route == .phone ? "iphone" : "antenna.radiowaves.left.and.right")
                    Text(entry.date, style: .relative)
                }
                .font(.caption2).foregroundStyle(.tertiary)
                Button {
                    speaker.toggle(entry.answer, full: speakFull)
                } label: {
                    Label(speaker.isSpeaking ? "停止" : "朗读",
                          systemImage: speaker.isSpeaking ? "stop.fill" : "speaker.wave.2.fill")
                }
            }
        }
        .onDisappear { speaker.stop() }
    }
}

// MARK: - Speech out

/// Reads an answer aloud — the other half of "a watch you talk to". Ducks
/// other audio while speaking and hands it back afterwards, pauses when the
/// wrist drops and resumes when it comes back up.
///
/// [T-watch-speak-stream] Sentences are queued as they become complete, so
/// speech starts with the first sentence of an answer still being written.
/// Each utterance is tracked by identity: a late callback from a stopped
/// answer must not count against the next one.
@MainActor
final class WatchSpeaker: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    static let shared = WatchSpeaker()

    @Published private(set) var isSpeaking = false
    private let synthesizer = AVSpeechSynthesizer()
    private var audioActive = false
    /// The answer being written, while it is still growing.
    private var stream: WatchSentenceStream?
    private var streamRound = 0
    /// Utterances handed to the synthesizer and not yet finished.
    private var inFlight: Set<ObjectIdentifier> = []
    /// No more sentences are coming for the current answer.
    private var inputEnded = true

    override private init() {
        super.init()
        synthesizer.delegate = self
    }

    func toggle(_ text: String, full: Bool) {
        if isSpeaking { stop() } else { speak(text, full: full) }
    }

    /// The whole answer at once (history, the speaker button, a missed answer).
    func speak(_ text: String, full: Bool) {
        stop()
        var sentences = WatchSentenceStream(full: full)
        for sentence in sentences.take(text, final: true) { enqueue(sentence) }
        inputEnded = true
        settleIfDone()
    }

    /// The answer so far; complete sentences are spoken right away.
    func streamFeed(_ text: String, round: Int, full: Bool) {
        if stream == nil {
            stop()
            stream = WatchSentenceStream(full: full)
            streamRound = round
            inputEnded = false
        } else if round != streamRound {
            stream?.startNewRound()
            streamRound = round
        }
        guard var current = stream else { return }
        let sentences = current.take(text, final: false)
        stream = current
        for sentence in sentences { enqueue(sentence) }
    }

    /// The final answer: speak what the stream hasn't reached yet — or all of
    /// it when nothing was streamed.
    func streamFinish(_ text: String, full: Bool) {
        guard var current = stream else { return speak(text, full: full) }
        let sentences = current.take(text, final: true)
        stream = nil
        inputEnded = true
        for sentence in sentences { enqueue(sentence) }
        settleIfDone()
    }

    func pause() {
        if synthesizer.isSpeaking { synthesizer.pauseSpeaking(at: .word) }
    }

    func resume() {
        if synthesizer.isPaused { synthesizer.continueSpeaking() }
    }

    func stop() {
        stream = nil
        inputEnded = true
        guard isSpeaking || synthesizer.isSpeaking || synthesizer.isPaused || !inFlight.isEmpty else { return }
        inFlight.removeAll()
        synthesizer.stopSpeaking(at: .immediate)
        finished()
    }

    private func enqueue(_ sentence: String) {
        if !audioActive { activateAudio() }
        let utterance = AVSpeechUtterance(string: sentence)
        utterance.voice = Self.voice(for: sentence)
        inFlight.insert(ObjectIdentifier(utterance))
        synthesizer.speak(utterance)
        isSpeaking = true
    }

    private func utteranceEnded(_ id: ObjectIdentifier) {
        guard inFlight.remove(id) != nil else { return }   // from an answer already stopped
        settleIfDone()
    }

    /// Release the audio only when the answer is fully spoken; between two
    /// streamed sentences the session stays up (no duck/unduck flutter).
    private func settleIfDone() {
        if inFlight.isEmpty, inputEnded { finished() }
    }

    private func finished() {
        isSpeaking = false
        releaseAudio()
    }

    /// The best installed voice for the language (premium > enhanced > default).
    private static var voiceCache: [String: AVSpeechSynthesisVoice] = [:]
    private static func voice(for text: String) -> AVSpeechSynthesisVoice? {
        guard WatchSpeechText.isMostlyChinese(text) else { return nil }
        if let cached = voiceCache["zh-CN"] { return cached }
        let candidates = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == "zh-CN" }
        let best = candidates.max { $0.quality.rawValue < $1.quality.rawValue } ?? AVSpeechSynthesisVoice(language: "zh-CN")
        if let best { voiceCache["zh-CN"] = best }
        return best
    }

    private func activateAudio() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .voicePrompt, options: [.duckOthers])
        session.activate(options: []) { _, _ in }
        audioActive = true
    }

    /// Give ducked music back. watchOS 27 deactivates without blocking; before
    /// that the synchronous call runs off the main thread.
    private func releaseAudio() {
        guard audioActive else { return }
        audioActive = false
        let session = AVAudioSession.sharedInstance()
        if #available(watchOS 27.0, *) {
            session.deactivate(options: .notifyOthersOnDeactivation) { _, _ in }
        } else {
            DispatchQueue.global(qos: .utility).async {
                try? session.setActive(false, options: .notifyOthersOnDeactivation)
            }
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        Task { @MainActor in self.utteranceEnded(id) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        Task { @MainActor in self.utteranceEnded(id) }
    }
}
