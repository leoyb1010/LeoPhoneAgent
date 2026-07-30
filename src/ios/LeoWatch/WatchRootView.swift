//
//  WatchRootView.swift
//  LeoWatch
//
//  Four vertical pages: Ask (home), Quick Tasks, Sessions, Schedule+Briefing.
//  The wrist's job is "ask in three seconds": mic front and centre, double
//  tap triggers it, everything else one crown-scroll away.
//

import SwiftUI
import WatchKit

struct WatchRootView: View {
    @EnvironmentObject private var client: WatchConnectivityClient

    var body: some View {
        TabView {
            HomePage()
            QuickTasksPage()
            SessionsPage()
            SchedulePage()
        }
        .tabViewStyle(.verticalPage)
    }
}

// MARK: - Page 1: Ask

private struct HomePage: View {
    @EnvironmentObject private var client: WatchConnectivityClient
    @State private var pulseTrigger = 0
    @State private var showReply = false

    private var isStale: Bool {
        client.state == "running" && Date().timeIntervalSince(client.updatedAt) > 12 * 60
    }

    var body: some View {
        VStack(spacing: 8) {
            ZStack {
                LifeRing(state: client.state)
                    .frame(width: 92, height: 92)
                RadarPulseOnce(trigger: pulseTrigger)
                    .frame(width: 92, height: 92)
                Button {
                    startAsk()
                } label: {
                    if case .waiting = client.askState {
                        WorkingBars()
                    } else {
                        Image(systemName: "mic.fill")
                            .font(.title2)
                            .foregroundStyle(.teal)
                    }
                }
                .buttonStyle(.plain)
                .frame(width: 72, height: 72)
                .handGestureShortcut(.primaryAction)
            }
            Text(statusLine)
                .font(.caption2)
                .foregroundStyle(isStale ? .orange : .secondary)
                .lineLimit(2)
                .multilineTextAlignment(.center)
            if client.state == "running" || client.activeCount > 0 {
                HoldToConfirmButton(duration: 1.0, tint: .red, action: { client.stopAll() }) {
                    Label("按住停止全部", systemImage: "stop.fill")
                        .font(.caption2)
                        .foregroundStyle(.red)
                }
            }
        }
        .sheet(isPresented: $showReply) { ReplySheet() }
        .onChange(of: client.replyPulse) { _ in showReply = true }
        .onAppear {
            if UserDefaults.standard.bool(forKey: "leo.watch.pendingVoiceAsk") {
                UserDefaults.standard.set(false, forKey: "leo.watch.pendingVoiceAsk")
                startAsk()
            }
        }
    }

    private var statusLine: String {
        if case .waiting = client.askState { return "Leo 正在处理…" }
        if isStale { return "数据可能过期 · 打开 iPhone 同步" }
        switch client.state {
        case "running": return client.status.isEmpty ? "任务运行中" : client.status
        case "failed": return "上个任务失败"
        default: return "双击手势或点麦克风提问"
        }
    }

    private func startAsk() {
        pulseTrigger += 1
        WKExtension.shared().visibleInterfaceController?.presentTextInputController(
            withSuggestions: ["今天日程", "查下天气", "早间简报"],
            allowedInputMode: .plain
        ) { results in
            guard let text = results?.first as? String, !text.isEmpty else { return }
            Task { @MainActor in WatchConnectivityClient.shared.ask(text) }
        }
    }
}

private struct ReplySheet: View {
    @EnvironmentObject private var client: WatchConnectivityClient
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            if case .replied(let text) = client.askState {
                Text(text)
                    .font(.footnote)
                    .settleIn(trigger: client.replyPulse)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                WorkingBars().padding(.top, 20)
            }
        }
        .navigationTitle("Leo")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("完成") { client.askState = .idle; dismiss() }
            }
        }
    }
}

// MARK: - Page 2: Quick tasks (crown-native list)

private struct QuickTasksPage: View {
    @EnvironmentObject private var client: WatchConnectivityClient

    var body: some View {
        List {
            Section("快捷任务") {
                if client.quickTasks.isEmpty {
                    Text("打开一次 iPhone App 后这里会显示任务。")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                ForEach(client.quickTasks) { task in
                    Button {
                        client.runQuickTask(task)
                    } label: {
                        Label(task.name, systemImage: task.symbolName)
                            .font(.caption)
                    }
                }
            }
            if let message = client.lastActionMessage {
                Text(message).font(.caption2).foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: - Page 3: Sessions

private struct SessionsPage: View {
    @EnvironmentObject private var client: WatchConnectivityClient

    var body: some View {
        NavigationStack {
            List {
                Section("最近会话") {
                    if client.sessions.isEmpty {
                        Text("暂无会话数据").font(.caption2).foregroundStyle(.secondary)
                    }
                    ForEach(client.sessions) { item in
                        NavigationLink {
                            SessionDetailPage(item: item)
                        } label: {
                            HStack(spacing: 6) {
                                Circle()
                                    .fill(item.state == "running" ? Color.orange : Color.secondary.opacity(0.4))
                                    .frame(width: 6, height: 6)
                                    .leoWatchPulse(active: item.state == "running")
                                Text(item.title.isEmpty ? "未命名会话" : item.title)
                                    .font(.caption)
                                    .lineLimit(1)
                                if item.unread {
                                    Circle().fill(.teal).frame(width: 5, height: 5)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

private struct SessionDetailPage: View {
    @EnvironmentObject private var client: WatchConnectivityClient
    let item: WatchSessionItem
    @State private var transcript: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                if let transcript {
                    Text(transcript)
                        .font(.system(size: 12))
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    HStack { Spacer(); WorkingBars(); Spacer() }
                }
                Button {
                    askFollowUp()
                } label: {
                    Label("语音追问", systemImage: "mic.fill").font(.caption)
                }
                if item.state == "running" {
                    HoldToConfirmButton(duration: 1.0, tint: .red, action: { client.stopSession(item.id) }) {
                        Label("按住停止此任务", systemImage: "stop.fill")
                            .font(.caption2).foregroundStyle(.red)
                    }
                }
            }
        }
        .navigationTitle(Text(item.title.isEmpty ? "会话" : item.title))
        .onAppear {
            client.requestTranscript(sessionId: item.id) { transcript = $0 }
        }
    }

    private func askFollowUp() {
        let sessionId = item.id
        WKExtension.shared().visibleInterfaceController?.presentTextInputController(
            withSuggestions: nil, allowedInputMode: .plain
        ) { results in
            guard let text = results?.first as? String, !text.isEmpty else { return }
            Task { @MainActor in WatchConnectivityClient.shared.ask(text, sessionId: sessionId) }
        }
    }
}

// MARK: - Page 4: Schedule + briefing

private struct SchedulePage: View {
    @EnvironmentObject private var client: WatchConnectivityClient

    var body: some View {
        List {
            if !client.briefingText.isEmpty {
                Section(client.briefingTask.isEmpty ? "简报" : client.briefingTask) {
                    Text(client.briefingText)
                        .font(.caption2)
                        .lineLimit(8)
                }
            }
            Section("定时任务") {
                if client.scheduled.isEmpty {
                    Text("暂无定时任务").font(.caption2).foregroundStyle(.secondary)
                }
                ForEach(client.scheduled) { task in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(task.name).font(.caption).lineLimit(1)
                            Spacer()
                            Button {
                                client.toggleScheduled(task.id)
                            } label: {
                                Image(systemName: task.enabled ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(task.enabled ? .teal : .secondary)
                            }
                            .buttonStyle(.plain)
                        }
                        HStack {
                            Text(task.timeText).font(.caption2).foregroundStyle(.secondary)
                            Spacer()
                            Button("立即跑") { client.runScheduled(task.id) }
                                .font(.caption2)
                                .buttonStyle(.borderless)
                                .foregroundStyle(.teal)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Tiny pulse for list dots

private struct WatchDotPulse: ViewModifier {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    func body(content: Content) -> some View {
        content
            .opacity(active && dim && !reduceMotion ? 0.35 : 1)
            .onAppear {
                guard active, !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true }
            }
    }
}

extension View {
    func leoWatchPulse(active: Bool) -> some View { modifier(WatchDotPulse(active: active)) }
}
