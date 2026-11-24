//
//  HomeMacScreenCover.swift
//  MinisApp
//
//  [up-home] 首页「进行中」旁的「看屏」:不用先开一个 Mac 任务也能看那台 Mac 的屏幕。
//  直接复用任务页的全屏查看(视频优先、截图兜底、可操控)。
//

import SwiftUI

/// 通知冷启动立即展示目标，拿到 Mac 的摘要后才选择实际执行器。
struct HomeMacSessionCover: View {
    let row: MacLiveSessionsStore.Row
    let client: LeoAgentClient?
    let onClose: () -> Void
    @State private var fetchedSession: HarnessSessionSummary?
    @State private var fetchFailed = false
    @State private var fetchAttempt = 0

    private var session: HarnessSessionSummary? {
        row.session.harness.isEmpty ? fetchedSession : row.session
    }

    var body: some View {
        NavigationStack {
            Group {
                if let client, let session {
                    HarnessConsoleView(
                        driver: HarnessSessionDriver(
                            client: client, harness: HarnessKind(key: session.harness, name: session.name),
                            cwd: session.cwd),
                        firstPrompt: "", attachSessionId: session.id, attachStatus: session.status
                    )
                } else if client == nil || fetchFailed {
                    ContentUnavailableView {
                        Label("暂时无法连接 Mac", systemImage: "desktopcomputer")
                    } description: {
                        Text("任务仍保留在 \(row.hostName)，连接恢复后可以继续。")
                    } actions: {
                        if client != nil {
                            Button("Retry") { fetchAttempt += 1 }
                                .buttonStyle(.borderedProminent)
                        }
                    }
                } else {
                    ProgressView("正在连接 \(row.hostName)…")
                }
            }
            .navigationTitle("\(row.hostName) · \(session?.displayTitle ?? row.session.displayTitle)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", action: onClose)
                }
            }
            .task(id: fetchAttempt) {
                guard let client, session == nil else { return }
                fetchFailed = false
                let result = try? await client.harnessSessions().first {
                    $0.id == row.session.id && !$0.harness.isEmpty
                }
                guard !Task.isCancelled else { return }
                fetchedSession = result
                fetchFailed = result == nil
            }
        }
    }
}

struct HomeMacScreenTarget: Identifiable {
    let host: GatewayHost
    let client: LeoAgentClient
    var id: String { host.id }
}

struct HomeMacScreenCover: View {
    let target: HomeMacScreenTarget
    @StateObject private var poller = MacScreenPoller()

    var body: some View {
        MacScreenFullscreen(poller: poller, hostName: target.host.name)
            .onAppear { poller.client = target.client }
    }
}
