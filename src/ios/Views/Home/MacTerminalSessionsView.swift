//
//  MacTerminalSessionsView.swift
//  MinisApp
//
//  [takeover] 「终端里的会话」:Mac 终端里用 claude 干到一半出门,手机上点一下接着干。
//  入口在首页「进行中」标题行(看屏 / 登录旁)和 设置 → 远程机器 的每台 Mac 上;
//  打开会话复用 HarnessConsoleView(历史由 Mac 回放进事件流)。
//

import SwiftUI

/// 入口按钮:自带全屏列表(挂在这个小视图上,不进 ContentView 的修饰链)。旧 Mac 不支持时整个按钮不出现。
struct MacTerminalSessionsButton: View {
    /// nil = 所有能看的 Mac(首页);远程机器页只传这一台。
    var hostIds: [String]? = nil
    @ObservedObject private var store = MacTerminalSessionsStore.shared
    @State private var showList = false

    var body: some View {
        // 不支持时也留一个零尺寸占位:空的 Group 不会触发 .task,探测就永远不跑了。
        Group {
            if !store.isSupported(hostIds) {
                Color.clear.frame(width: 0, height: 0).accessibilityHidden(true)
            } else {
                Button {
                    showList = true
                    LeoHaptics.selection()
                } label: {
                    Label {
                        Text("终端会话")
                    } icon: {
                        Image(systemName: "macbook.and.iphone")
                            .overlay(alignment: .topTrailing) {
                                // 终端里有还开着的 claude:一个小绿点,不用点开也知道。
                                if store.hasRunning(hostIds) {
                                    Circle().fill(Color.green)
                                        .frame(width: 6, height: 6)
                                        .offset(x: 3, y: -2)
                                }
                            }
                    }
                    .font(.caption.weight(.semibold))
                }
                .buttonStyle(.borderless)
                .accessibilityIdentifier("takeover.entry")
                .accessibilityHint(Text("列出 Mac 终端里的 Claude Code 会话，点一下在手机上接着干"))
                .fullScreenCover(isPresented: $showList) {
                    MacTerminalSessionsView(hostIds: hostIds) { showList = false }
                }
            }
        }
        .task { await store.refresh() }
    }
}

struct MacTerminalSessionsView: View {
    var hostIds: [String]? = nil
    let onClose: () -> Void

    @ObservedObject private var store = MacTerminalSessionsStore.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// 正在接管的那一行(行尾转圈,别的行先不让点)。
    @State private var takingOver: String?
    @State private var opened: OpenedSession?
    @State private var failure: String?

    struct OpenedSession: Identifiable, Hashable {
        let host: GatewayHost
        let result: MacTakeoverResult
        var id: String { host.id + result.sessionId }
        static func == (a: Self, b: Self) -> Bool { a.id == b.id }
        func hash(into hasher: inout Hasher) { hasher.combine(id) }
    }

    private var groups: [MacTerminalSessionsStore.HostSessions] {
        store.groups.filter { hostIds?.contains($0.host.id) ?? true }
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(Text("终端里的会话"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("关闭", action: onClose)
                    }
                }
                .navigationDestination(item: $opened) { opened in
                    console(opened)
                }
                .alert("没接上", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
                    Button("好", role: .cancel) {}
                } message: { Text(failure ?? "") }
        }
        .task { await store.refresh(force: true) }
    }

    @ViewBuilder
    private var content: some View {
        let sessions = groups.flatMap(\.sessions)
        if sessions.isEmpty {
            switch store.phase {
            case .idle, .loading:
                VStack(spacing: 12) {
                    ProgressView()
                    Text("正在读 Mac 上的会话…").font(.subheadline).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message):
                ContentUnavailableView {
                    Label("连不上 Mac", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(message)
                } actions: {
                    Button("重试") { Task { await store.refresh(force: true) } }
                        .buttonStyle(.borderedProminent)
                }
            case .loaded:
                ContentUnavailableView {
                    Label("终端里没有 Claude Code 会话", systemImage: "apple.terminal")
                } description: {
                    Text("在 Mac 终端里用 claude 开的会话会出现在这里，点一下就能在手机上看到之前的对话、接着发消息。")
                } actions: {
                    Button("刷新") { Task { await store.refresh(force: true) } }
                }
            }
        } else {
            List {
                ForEach(groups) { group in
                    if !group.sessions.isEmpty {
                        Section {
                            ForEach(group.sessions) { session in
                                row(session, host: group.host)
                            }
                        } header: {
                            if groups.count > 1 { Text(group.host.name) }
                        }
                    }
                }
                Section {
                } footer: {
                    Text("接管后就是 Mac 上的一个 Claude Code 任务：历史从终端同步过来，之后的消息在原会话上继续。终端里还开着的，最好先在终端退出 claude，免得两边同时发消息。")
                }
            }
            .refreshable { await store.refresh(force: true) }
        }
    }

    private func row(_ session: MacExternalSession, host: GatewayHost) -> some View {
        Button {
            Task { await takeOver(session, on: host) }
        } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: HarnessCatalog.symbol(key: session.agent))
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.orange)
                    .frame(width: 32, height: 32)
                    .background(Color.orange.opacity(0.14), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                VStack(alignment: .leading, spacing: 4) {
                    Text(session.displayTitle)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    HStack(spacing: 6) {
                        Label(session.folderName, systemImage: "folder")
                            .labelStyle(.titleAndIcon)
                            .lineLimit(1)
                        if let date = session.updatedAt {
                            Text("·")
                            Text(date, format: .relative(presentation: .named))
                                .lineLimit(1)
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    // 已接管的会话由手机这边续写同一个文件,「还开着」不再说明终端的情况。
                    let terminalOpen = session.running && session.leobotSessionId == nil
                    if terminalOpen || session.leobotSessionId != nil {
                        HStack(spacing: 6) {
                            if terminalOpen {
                                HStack(spacing: 4) {
                                    Image(systemName: "circle.fill")
                                        .font(.system(size: 6))
                                        .foregroundStyle(.green)
                                        .symbolEffect(.pulse, options: .repeating, isActive: !reduceMotion)
                                    Text("终端里还开着")
                                }
                                .foregroundStyle(.green)
                            }
                            if session.leobotSessionId != nil {
                                Text("已在手机上接管")
                                    .padding(.horizontal, 6).padding(.vertical, 1)
                                    .background(Color.accentColor.opacity(0.12), in: Capsule())
                                    .foregroundStyle(Color.accentColor)
                            }
                        }
                        .font(.caption2.weight(.semibold))
                    }
                }
                Spacer(minLength: 0)
                if takingOver == session.id {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .padding(.top, 10)
                }
            }
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(takingOver != nil)
        .accessibilityElement(children: .combine)
        .accessibilityHint(Text("在手机上接着这个会话"))
    }

    private func takeOver(_ session: MacExternalSession, on host: GatewayHost) async {
        guard takingOver == nil else { return }
        takingOver = session.id
        defer { takingOver = nil }
        do {
            let result = try await store.takeOver(session, on: host)
            LeoHaptics.selection()
            opened = OpenedSession(host: host, result: result)
        } catch {
            guard !LeoLinkProblem.isCancellation(error) else { return }
            failure = error.localizedDescription
        }
    }

    @ViewBuilder
    private func console(_ opened: OpenedSession) -> some View {
        if let client = GatewayHostStore.shared.client(for: opened.host) {
            HarnessConsoleView(
                driver: HarnessSessionDriver(
                    client: client,
                    harness: HarnessKind(key: opened.result.harness, name: opened.result.name),
                    cwd: opened.result.cwd),
                firstPrompt: "",
                attachSessionId: opened.result.sessionId,
                attachStatus: opened.result.status)
            .navigationTitle("\(opened.host.name) · \(opened.result.title)")
            .navigationBarTitleDisplayMode(.inline)
        } else {
            ContentUnavailableView("缺少访问密钥", systemImage: "key",
                                   description: Text("去 设置 → 远程机器 里补上这台 Mac 的密钥。"))
        }
    }
}
