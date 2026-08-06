//
//  LeoAgentMacApp.swift
//  LeoAgentMac
//
//  [T-leoagent-mac] The operator's console for the Mac half of the product.
//
//  Shape: a real desktop app — Dock icon, a console window that opens on
//  launch and on reopen — plus a menu-bar extra for at-a-glance state. The
//  daemon is the thing that runs headless; the app is where a human takes
//  over at the keyboard, so hiding it behind a menu-bar-only icon read as
//  "the app is broken" the first time anyone double-clicked it.
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
        // Declared first: the primary scene, presented at launch and again
        // when the Dock icon or the app bundle is activated with no window.
        Window("LeoAgent", id: "main") {
            ConsoleView(model: model)
                .frame(minWidth: 760, minHeight: 480)
        }
        .defaultSize(width: 980, height: 620)

        MenuBarExtra {
            MenuContent(model: model)
        } label: {
            // Icon carries state at a glance: a filled bolt when the daemon is
            // up, an exclamation when something wants the operator.
            Image(systemName: model.menuBarSymbol)
        }
        .menuBarExtraStyle(.window)
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
