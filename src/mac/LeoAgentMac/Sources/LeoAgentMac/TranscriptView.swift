//
//  TranscriptView.swift
//  LeoAgentMac
//
//  One session's conversation: live transcript, inline approval cards, an
//  input bar for steering, and stop. Read-only for sessions whose process
//  died with a previous daemon — history still replays exactly.
//

import SwiftUI

struct TranscriptView: View {
    @ObservedObject var store: SessionStore
    @State private var input = ""

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            transcript
            Divider()
            inputBar
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 10) {
            Text(store.harnessName).font(.system(size: 13, weight: .semibold))
            Text(store.cwd)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
            Spacer()
            statusBadge
            if store.detached {
                Button("重连") { store.reattach() }
                    .font(.system(size: 11))
            }
            if !store.isReadOnly {
                Button {
                    Task { await store.stop() }
                } label: {
                    Label("停止", systemImage: "stop.circle")
                }
                .help("终止这个会话的 CLI 进程")
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
    }

    private var statusBadge: some View {
        Text(statusLabel)
            .font(.system(size: 10, weight: .medium))
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(statusColor.opacity(0.15), in: Capsule())
            .foregroundStyle(statusColor)
    }

    private var statusLabel: String {
        switch store.status {
        case "running": return "运行中"
        case "starting": return "启动中"
        case "idle": return "待命,可继续下指令"
        case "waiting_for_approval": return "等待审批"
        case "orphaned": return "历史会话 · 只读"
        case "completed": return "完成"
        case "failed": return "失败"
        case "cancelled": return "已停止"
        default: return store.status
        }
    }

    private var statusColor: Color {
        switch store.status {
        case "running", "starting": return .green
        case "idle": return .blue
        case "waiting_for_approval": return .orange
        case "failed": return .red
        default: return .secondary
        }
    }

    // MARK: - Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(store.items) { item in
                        ItemView(item: item, store: store)
                            .id(item.id)
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .onChange(of: store.items.last?.id) { _, lastId in
                if let lastId {
                    withAnimation(.easeOut(duration: 0.15)) {
                        proxy.scrollTo(lastId, anchor: .bottom)
                    }
                }
            }
        }
    }

    // MARK: - Input

    private var inputBar: some View {
        VStack(spacing: 4) {
            if let error = store.lastError {
                Text(error)
                    .font(.system(size: 11)).foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
            }
            HStack(spacing: 8) {
                TextField(store.isReadOnly ? "历史会话,无法继续" : "给它下一步指令…",
                          text: $input, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...5)
                    .onSubmit(sendInput)
                    .disabled(store.isReadOnly)
                Button(action: sendInput) {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 20))
                }
                .buttonStyle(.plain)
                .disabled(store.isReadOnly ||
                          input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
        }
        .background(.bar)
    }

    private func sendInput() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !store.isReadOnly else { return }
        Task {
            // Clear only after the daemon accepted it; a failed send keeps the
            // draft instead of silently eating it.
            if await store.send(text) { input = "" }
        }
    }
}

// MARK: - Transcript items

private struct ItemView: View {
    let item: TranscriptItem
    let store: SessionStore

    var body: some View {
        switch item.kind {
        case .user:
            HStack {
                Spacer(minLength: 60)
                Text(item.text)
                    .font(.system(size: 13))
                    .textSelection(.enabled)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(Color.accentColor.opacity(0.14),
                                in: RoundedRectangle(cornerRadius: 10))
            }
        case .assistant:
            Text(item.text)
                .font(.system(size: 13))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .reasoning:
            DisclosureGroup {
                Text(item.text)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } label: {
                Label("思考过程", systemImage: "brain")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
        case .toolRunning, .toolDone, .toolError:
            HStack(spacing: 6) {
                switch item.kind {
                case .toolRunning: ProgressView().controlSize(.mini)
                case .toolDone: Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green).font(.system(size: 11))
                default: Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.red).font(.system(size: 11))
                }
                Text(item.text).font(.system(size: 12, weight: .medium, design: .monospaced))
                if !item.detail.isEmpty {
                    Text(item.detail)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 7))
        case .approval:
            ApprovalCard(item: item, store: store)
        case .info:
            Text(item.text)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.tertiary)
                .textSelection(.enabled)
                .lineLimit(6)
        case .done:
            Label(item.text, systemImage: "checkmark.circle")
                .font(.system(size: 11)).foregroundStyle(.secondary)
        case .failed:
            Label(item.text, systemImage: "exclamationmark.triangle.fill")
                .font(.system(size: 12)).foregroundStyle(.red)
        case .cancelled:
            Label(item.text, systemImage: "stop.circle")
                .font(.system(size: 11)).foregroundStyle(.secondary)
        }
    }
}

private struct ApprovalCard: View {
    let item: TranscriptItem
    let store: SessionStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(item.answered == nil ? "请求权限" : "权限请求 · 已答复",
                  systemImage: "hand.raised.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(item.answered == nil ? .orange : .secondary)
            if !item.text.isEmpty {
                Text(item.text)
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .textSelection(.enabled)
            }
            if !item.detail.isEmpty {
                Text(item.detail)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .lineLimit(4)
            }
            if let answered = item.answered {
                Text(answerLabel(answered))
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            } else if store.isReadOnly {
                Text("会话已结束,无法答复")
                    .font(.system(size: 11)).foregroundStyle(.tertiary)
            } else {
                HStack(spacing: 8) {
                    ForEach(item.choices, id: \.self) { choice in
                        Button(answerLabel(choice)) {
                            Task {
                                await store.approve(approvalId: item.approvalId,
                                                    choice: choice)
                            }
                        }
                        .buttonStyle(.bordered)
                        .tint(choice == "deny" ? .red : .accentColor)
                    }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background((item.answered == nil ? Color.orange : Color.secondary).opacity(0.08),
                    in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10)
            .strokeBorder((item.answered == nil ? Color.orange : .clear).opacity(0.4)))
    }

    private func answerLabel(_ choice: String) -> String {
        switch choice {
        case "once": return "允许一次"
        case "always": return "总是允许"
        case "deny": return "拒绝"
        default: return choice
        }
    }
}
