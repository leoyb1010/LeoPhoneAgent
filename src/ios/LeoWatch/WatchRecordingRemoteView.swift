//
//  WatchRecordingRemoteView.swift
//  LeoWatch
//
//  [V-watch] 遥控 iPhone 录音:开始 / 标记重点 / 暂停继续 / 停止。录音在 iPhone 上,
//  手表只发指令(不传音频)。消息格式见 Shared/WatchRecordingRemote.swift。
//

import SwiftUI
import WatchConnectivity
import WatchKit

@MainActor
final class WatchRecordingRemoteModel: ObservableObject {
    @Published private(set) var status = WatchRecordingRemote.Status.idle
    @Published private(set) var message: String?
    @Published private(set) var busy = false
    /// 最近一次拿到状态的时刻(本地走秒的起点)。
    @Published private(set) var statusAt = Date()

    func send(_ action: WatchRecordingRemote.Action) {
        let session = WCSession.default
        guard session.activationState == .activated, session.isReachable else {
            message = String(localized: "iPhone 不在附近")
            return
        }
        busy = true
        session.sendMessage(WatchRecordingRemote.payload(action), replyHandler: { reply in
            let parsed = WatchRecordingRemote.status(fromReply: reply)
            Task { @MainActor in
                self.busy = false
                self.status = parsed.status
                self.statusAt = Date()
                self.message = parsed.status.message
                if parsed.ok, action != .status { WKInterfaceDevice.current().play(.click) }
            }
        }, errorHandler: { _ in
            Task { @MainActor in
                self.busy = false
                self.message = String(localized: "没连上 iPhone,请再试一次")
            }
        })
    }
}

struct WatchRecordingRemoteView: View {
    @StateObject private var model = WatchRecordingRemoteModel()

    var body: some View {
        VStack(spacing: 8) {
            header
            if model.status.isRecording {
                HStack(spacing: 8) {
                    controlButton("flag.fill", tint: .orange, label: "标记重点") { model.send(.mark) }
                        .disabled(model.status.isPaused)
                    controlButton(model.status.isPaused ? "play.fill" : "pause.fill", tint: .gray,
                                  label: model.status.isPaused ? LocalizedStringKey("继续") : LocalizedStringKey("暂停")) {
                        model.send(model.status.isPaused ? .resume : .pause)
                    }
                    controlButton("stop.fill", tint: .red, label: "停止") { model.send(.stop) }
                }
            } else {
                Button { model.send(.start) } label: {
                    Label("在 iPhone 上录音", systemImage: "mic.fill")
                }
                .tint(.red)
                .disabled(model.busy)
            }
            if let message = model.message {
                Text(message)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(.horizontal, 4)
        .onAppear { model.send(.status) }
    }

    @ViewBuilder
    private var header: some View {
        if model.status.isRecording {
            VStack(spacing: 2) {
                if model.status.isPaused {
                    Text(WatchRecordingRemote.elapsedText(model.status.elapsed))
                        .font(.title2.monospacedDigit())
                } else {
                    Text(timerInterval: model.statusAt.addingTimeInterval(-model.status.elapsed)...Date.distantFuture,
                         countsDown: false)
                        .font(.title2.monospacedDigit())
                }
                Text(model.status.isPaused ? LocalizedStringKey("已暂停") : LocalizedStringKey("iPhone 正在录音"))
                    .font(.caption2)
                    .foregroundStyle(model.status.isPaused ? Color.secondary : Color.red)
                if model.status.highlightCount > 0 {
                    Text("\(model.status.highlightCount) 个重点")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        } else {
            VStack(spacing: 2) {
                Image(systemName: "waveform")
                    .font(.title3)
                    .foregroundStyle(.red)
                Text("录音遥控")
                    .font(.headline)
                Text("录音保存在 iPhone 上")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func controlButton(_ icon: String, tint: Color, label: LocalizedStringKey,
                               action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 36)
        }
        .tint(tint)
        .disabled(model.busy)
        .accessibilityLabel(Text(label))
    }
}
