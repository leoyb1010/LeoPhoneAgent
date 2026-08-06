//
//  ConsoleView.swift
//  LeoAgentMac
//
//  The console window: every harness session on this Mac in the sidebar, a
//  live transcript with steering, approvals and stop in the detail pane, and
//  a new-session sheet. Feature parity with what the phone can do to this
//  machine — the desk chair just gets a bigger screen.
//

import SwiftUI

struct ConsoleView: View {
    @ObservedObject var model: DaemonModel
    @State private var showNewSession = false

    var body: some View {
        NavigationSplitView {
            List(selection: $model.selected) {
                Section("会话") {
                    if model.sessions.isEmpty {
                        Text("暂无编码会话")
                            .foregroundStyle(.secondary).font(.system(size: 12))
                    }
                    ForEach(model.sessions) { session in
                        SessionRowView(session: session)
                            .tag(session.id)
                    }
                }
            }
            .frame(minWidth: 250)
            .toolbar {
                ToolbarItem {
                    Button {
                        showNewSession = true
                    } label: {
                        Label("新建会话", systemImage: "plus")
                    }
                    .disabled(!model.isUp || model.harnessKinds.isEmpty)
                    .help(model.isUp ? "启动一个新的编码会话" : "本机守护进程未运行")
                }
            }
            .safeAreaInset(edge: .bottom) { statusFooter }
        } detail: {
            if let row = model.sessions.first(where: { $0.id == model.selected }),
               let store = model.store(for: row) {
                TranscriptView(store: store)
            } else {
                emptyState
            }
        }
        .navigationTitle("LeoAgent")
        .sheet(isPresented: $showNewSession) {
            NewSessionSheet(model: model)
        }
        .task { await model.startPolling() }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "bolt.horizontal.circle")
                .font(.system(size: 42)).foregroundStyle(.tertiary)
            Text("选择一个会话,或新建一个")
                .foregroundStyle(.secondary)
            Text("手机端是主控制面。这里用来确认它活着、看它卡在哪、以及在键盘前直接接管。")
                .font(.system(size: 12)).foregroundStyle(.tertiary)
                .frame(maxWidth: 380).multilineTextAlignment(.center)
            if let error = model.lastError {
                Text(error).font(.system(size: 12)).foregroundStyle(.red)
            }
        }
        .padding()
    }

    private var statusFooter: some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider()
            HStack(spacing: 12) {
                statusPill(model.isUp, "LeoAgent", model.isUp ? ":8646" : "未运行")
                statusPill(model.engineUp, "引擎", model.engineUp ? ":8642" : "未运行")
                Spacer()
                Button {
                    Task { await model.restartDaemon() }
                } label: {
                    Image(systemName: "arrow.clockwise.circle")
                }
                .buttonStyle(.plain)
                .help(model.isUp ? "重启守护进程" : "启动守护进程")
            }
            .padding(.horizontal, 10).padding(.bottom, 8)
        }
    }

    private func statusPill(_ ok: Bool, _ name: String, _ detail: String) -> some View {
        HStack(spacing: 5) {
            Circle().fill(ok ? Color.green : Color.secondary).frame(width: 7, height: 7)
            Text(name).font(.system(size: 11, weight: .medium))
            Text(detail).font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Sidebar row

private struct SessionRowView: View {
    let session: HarnessRow

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .foregroundStyle(iconColor)
            VStack(alignment: .leading, spacing: 1) {
                Text(session.name).font(.system(size: 13))
                Text(session.cwd)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
            }
            Spacer()
            Text(statusLabel).font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.tertiary)
        }
    }

    private var icon: String {
        if session.waitingForApproval { return "hand.raised.fill" }
        switch session.status {
        case "running", "starting": return "bolt.fill"
        case "idle": return "terminal"
        case "orphaned": return "archivebox"
        default: return "terminal"
        }
    }

    private var iconColor: Color {
        if session.waitingForApproval { return .orange }
        switch session.status {
        case "running", "starting": return .green
        case "idle": return .blue
        default: return .secondary
        }
    }

    private var statusLabel: String {
        switch session.status {
        case "running": return "运行中"
        case "starting": return "启动中"
        case "idle": return "待命"
        case "waiting_for_approval": return "等审批"
        case "orphaned": return "历史"
        case "completed": return "完成"
        case "failed": return "失败"
        case "cancelled": return "已停止"
        default: return session.status
        }
    }
}

// MARK: - New session

private struct NewSessionSheet: View {
    @ObservedObject var model: DaemonModel
    @Environment(\.dismiss) private var dismiss

    @State private var harness = ""
    @State private var cwd = FileManager.default.homeDirectoryForCurrentUser.path
    @State private var prompt = ""
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("新建编码会话").font(.headline)

            Picker("CLI", selection: $harness) {
                ForEach(model.harnessKinds) { kind in
                    Text(kind.name).tag(kind.id)
                }
            }

            HStack {
                TextField("工作目录", text: $cwd)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
                Button("选择…") { pickDirectory() }
            }

            TextField("第一条指令(可留空)", text: $prompt, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(3...6)

            if let error = model.lastError {
                Text(error).font(.system(size: 12)).foregroundStyle(.red)
            }

            HStack {
                Spacer()
                Button("取消") { dismiss() }
                Button(busy ? "启动中…" : "开始") {
                    busy = true
                    Task {
                        let ok = await model.createSession(
                            harness: harness, cwd: cwd, prompt: prompt)
                        busy = false
                        if ok { dismiss() }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(busy || harness.isEmpty || cwd.isEmpty)
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear { harness = model.harnessKinds.first?.id ?? "" }
    }

    private func pickDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.directoryURL = URL(fileURLWithPath: cwd)
        if panel.runModal() == .OK, let url = panel.url {
            cwd = url.path
        }
    }
}
