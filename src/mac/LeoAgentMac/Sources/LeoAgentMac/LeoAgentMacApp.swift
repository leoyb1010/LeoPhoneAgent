//
//  LeoAgentMacApp.swift
//  LeoAgentMac
//
//  [T-leoagent-mac] The operator's console for the Mac half of the product.
//
//  Shape: menu-bar first. LeoAgent spends almost all of its life headless —
//  launchd keeps the daemon alive whether or not anyone is logged in — so the
//  app's job is not "be a chat window" but "tell me it's alive, tell me when
//  it needs me, let me take over at the keyboard". The phone stays the primary
//  control surface.
//
//  Native SwiftUI rather than Electron: this machine already runs the agent
//  engine and a Python server, and a second Chromium would be the heaviest
//  thing on it for the least benefit. The rest of this product is SwiftUI, so
//  the console reads like the phone.
//

import SwiftUI
import AppKit

@main
struct LeoAgentMacApp: App {
    @StateObject private var model = DaemonModel()

    var body: some Scene {
        MenuBarExtra {
            MenuContent(model: model)
        } label: {
            // Icon carries state at a glance: a filled bolt when the daemon is
            // up, an exclamation when something wants the operator.
            Image(systemName: model.menuBarSymbol)
        }
        .menuBarExtraStyle(.window)

        Window("LeoAgent", id: "main") {
            ConsoleView(model: model)
                .frame(minWidth: 720, minHeight: 460)
        }
        .defaultSize(width: 900, height: 560)
    }
}

// MARK: - Menu

private struct MenuContent: View {
    @ObservedObject var model: DaemonModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Circle()
                    .fill(model.isUp ? Color.green : Color.secondary)
                    .frame(width: 8, height: 8)
                Text(model.isUp ? "LeoAgent 运行中" : "LeoAgent 未运行")
                    .font(.system(size: 13, weight: .medium))
                Spacer()
                Text(model.version).font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
            }

            if !model.harnessNames.isEmpty {
                Text("可控 CLI:" + model.harnessNames.joined(separator: " · "))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }

            if model.waitingCount > 0 {
                // The one thing worth interrupting someone for.
                Label("\(model.waitingCount) 个会话等待审批", systemImage: "hand.raised.fill")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.orange)
            }

            Divider()

            Button("打开控制台") { openWindow(id: "main"); NSApp.activate(ignoringOtherApps: true) }
            Button(model.isUp ? "重启守护进程" : "启动守护进程") { Task { await model.restartDaemon() } }
            Button("刷新") { Task { await model.refresh() } }
            Divider()
            Button("退出 LeoAgent") { NSApp.terminate(nil) }
        }
        .padding(12)
        .frame(width: 260)
        .task { await model.startPolling() }
    }
}

// MARK: - Console

private struct ConsoleView: View {
    @ObservedObject var model: DaemonModel

    var body: some View {
        NavigationSplitView {
            List(selection: Binding(get: { model.selected }, set: { model.selected = $0 })) {
                Section("会话") {
                    if model.sessions.isEmpty {
                        Text("暂无编码会话").foregroundStyle(.secondary).font(.system(size: 12))
                    }
                    ForEach(model.sessions) { session in
                        HStack(spacing: 8) {
                            Image(systemName: session.waitingForApproval ? "hand.raised.fill" : "terminal")
                                .foregroundStyle(session.waitingForApproval ? .orange : .secondary)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(session.name).font(.system(size: 13))
                                Text(session.cwd)
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                            }
                            Spacer()
                            Text(session.status).font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(.tertiary)
                        }
                        .tag(session.id)
                    }
                }
            }
            .frame(minWidth: 240)
        } detail: {
            VStack(alignment: .leading, spacing: 14) {
                // One pane of glass: both halves of the Mac side, so nobody
                // has to remember there are two processes.
                GroupBox("本机状态") {
                    Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 6) {
                        GridRow {
                            Text("LeoAgent").foregroundStyle(.secondary)
                            statusPill(model.isUp, model.isUp ? "运行中 :8646" : "未运行")
                        }
                        GridRow {
                            Text("代理引擎").foregroundStyle(.secondary)
                            statusPill(model.engineUp, model.engineUp ? "运行中 :8642" : "未运行")
                        }
                        GridRow {
                            Text("可控 CLI").foregroundStyle(.secondary)
                            Text(model.harnessNames.isEmpty ? "未检测到" : model.harnessNames.joined(separator: " · "))
                        }
                    }
                    .font(.system(size: 12))
                    .padding(6)
                }

                if let error = model.lastError {
                    Text(error).font(.system(size: 12)).foregroundStyle(.red)
                }

                Text("手机端是主控制面。这里用来确认它活着、看它卡在哪、以及在键盘前直接接管。")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                Spacer()
            }
            .padding(18)
        }
        .navigationTitle("LeoAgent")
        .task { await model.startPolling() }
    }

    private func statusPill(_ ok: Bool, _ text: String) -> some View {
        HStack(spacing: 5) {
            Circle().fill(ok ? Color.green : Color.secondary).frame(width: 7, height: 7)
            Text(text)
        }
    }
}
