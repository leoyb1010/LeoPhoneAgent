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

    var body: some View {
        TabView {
            AskPage()
            HistoryPage()
        }
        .tabViewStyle(.verticalPage)
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
    }
}

/// Wrist-sized approval card. Choices come from the gateway, one button per
/// row so a 45mm screen never truncates a label into ambiguity.
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

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 6) {
                    Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
                    Text("需要审批").font(.headline)
                }
                if !approval.detail.isEmpty {
                    Text(approval.detail)
                        .font(.system(size: 13, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(6)
                }
                ForEach(approval.choices, id: \.self) { choice in
                    Button {
                        onChoose(choice)
                    } label: {
                        Text(label(for: choice)).frame(maxWidth: .infinity)
                    }
                    .tint(choice == "deny" ? .red : .accentColor)
                }
            }
            .padding(.horizontal, 4)
        }
    }
}

// MARK: - Page 1: Ask

private struct AskPage: View {
    @EnvironmentObject private var client: WatchConnectivityClient
    @ObservedObject private var standalone = WatchStandaloneClient.shared
    @StateObject private var recorder = WatchVoiceRecorder.shared
    @State private var pulseTrigger = 0
    @State private var showReply = false

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
                micControl
                    .frame(width: 72, height: 72)
            }
            Text(statusLine)
                .font(.caption2)
                .foregroundStyle(client.lastActionMessage == nil ? Color.secondary : Color.orange)
                .lineLimit(3)
                .multilineTextAlignment(.center)
            if isWaiting {
                Button("取消", role: .cancel) { client.cancelAsk() }
                    .font(.caption2)
                    .buttonStyle(.borderless)
            }
        }
        .sheet(isPresented: $showReply) { ReplySheet() }
        .onChange(of: client.replyPulse) { _, _ in showReply = true }
        .onAppear {
            // Siri / Action Button "问 Leo" lands here with a pending ask.
            // Dictation can't be opened programmatically, so only the phone
            // route starts listening by itself; the flag is cleared either way.
            if UserDefaults.standard.bool(forKey: "leo.watch.pendingVoiceAsk") {
                UserDefaults.standard.set(false, forKey: "leo.watch.pendingVoiceAsk")
                if client.route == .phone { toggleVoice() }
            }
        }
    }

    /// Recording goes to the phone (its speech stack is better and the full
    /// agent runs there). Without the phone the watch dictates and answers
    /// directly; with neither, the mic is off and the line below says why.
    @ViewBuilder
    private var micControl: some View {
        if isWaiting {
            WorkingBars()
        } else {
            switch client.route {
            case .phone:
                Button { toggleVoice() } label: { micLabel }
                    .buttonStyle(.plain)
                    .handGestureShortcut(.primaryAction)
                    .accessibilityLabel(recorder.isRecording ? "发送" : "说话")
            case .direct:
                TextFieldLink(prompt: Text("说吧")) {
                    micLabel
                } onSubmit: { text in
                    pulseTrigger += 1
                    client.ask(text)
                }
                .buttonStyle(.plain)
                .handGestureShortcut(.primaryAction)
                .accessibilityLabel("说话")
            case nil:
                micLabel.opacity(0.35).accessibilityLabel("暂不可用")
            }
        }
    }

    @ViewBuilder
    private var micLabel: some View {
        if recorder.isRecording {
            LiveLevelBars(level: recorder.level)
        } else {
            Image(systemName: "mic.fill")
                .font(.title2)
                .foregroundStyle(.teal)
        }
    }

    private var ringState: String {
        if isWaiting { return "running" }
        if case .replied = client.askState { return "completed" }
        return client.lastActionMessage == nil ? "idle" : "failed"
    }

    private var statusLine: String {
        if recorder.isRecording { return "说完再点一下发送" }
        if isWaiting {
            return client.route == .direct
                ? "\(standalone.config?.modelName ?? "模型")正在回答…"
                : "iPhone 上的 Leo 正在处理…"
        }
        if let message = client.lastActionMessage { return message }
        switch client.route {
        case .phone: return "点一下说话 · 经 iPhone"
        case .direct: return "点一下说话 · 直连 \(standalone.config?.modelName ?? "")"
        case nil: return standalone.unavailableReason ?? "iPhone 不在身边，也没有可直连的模型。"
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

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if case .replied(let text) = client.askState {
                    Text(text)
                        .font(.footnote)
                        .settleIn(trigger: client.replyPulse)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    HStack {
                        Button {
                            speaker.toggle(text)
                        } label: {
                            Image(systemName: speaker.isSpeaking ? "stop.fill" : "speaker.wave.2.fill")
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
                } else {
                    WorkingBars().padding(.top, 20)
                }
            }
        }
        .navigationTitle("Leo")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("完成") {
                    speaker.stop()
                    client.askState = .idle
                    dismiss()
                }
            }
        }
    }
}

// MARK: - Page 2: History

private struct HistoryPage: View {
    @EnvironmentObject private var client: WatchConnectivityClient

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
            }
            .navigationTitle("记录")
        }
    }
}

private struct HistoryDetail: View {
    let entry: WatchHistoryEntry
    @ObservedObject private var speaker = WatchSpeaker.shared

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
                    speaker.toggle(entry.answer)
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

/// Reads an answer aloud — the other half of "a watch you talk to".
@MainActor
final class WatchSpeaker: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    static let shared = WatchSpeaker()

    @Published private(set) var isSpeaking = false
    private let synthesizer = AVSpeechSynthesizer()

    override private init() {
        super.init()
        synthesizer.delegate = self
    }

    func toggle(_ text: String) {
        if isSpeaking { return stop() }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: Locale.current.identifier.hasPrefix("zh") ? "zh-CN" : nil)
        synthesizer.speak(utterance)
        isSpeaking = true
    }

    func stop() {
        guard isSpeaking else { return }
        synthesizer.stopSpeaking(at: .immediate)
        isSpeaking = false
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.isSpeaking = false }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.isSpeaking = false }
    }
}
