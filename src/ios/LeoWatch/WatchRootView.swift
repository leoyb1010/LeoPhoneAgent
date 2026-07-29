//
//  WatchRootView.swift
//  LeoWatch
//

import SwiftUI

struct WatchRootView: View {
    @EnvironmentObject private var client: WatchConnectivityClient

    private var isStale: Bool {
        client.state == "running" && Date().timeIntervalSince(client.updatedAt) > 12 * 60
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    statusCard

                    if !client.quickTasks.isEmpty {
                        Text("快捷任务")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        ForEach(client.quickTasks) { task in
                            Button {
                                client.runQuickTask(task)
                            } label: {
                                Label(task.name, systemImage: task.symbolName)
                                    .font(.caption)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.glass)
                        }
                    }

                    if let message = client.lastActionMessage {
                        Text(message)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 4)
            }
            .navigationTitle("LeoAgent")
        }
    }

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 5) {
                Image(systemName: symbol)
                    .foregroundStyle(tint)
                Text(headline)
                    .font(.headline)
                    .lineLimit(2)
            }
            if isStale {
                Text("状态可能已过期")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            } else if !client.status.isEmpty {
                Text(client.status)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var headline: String {
        if client.activeCount > 0 {
            return client.title.isEmpty ? "\(client.activeCount) 个任务运行中" : client.title
        }
        switch client.state {
        case "completed": return "已完成"
        case "failed": return "需要处理"
        case "suspended": return "已暂停"
        default: return "空闲"
        }
    }

    private var symbol: String {
        switch client.state {
        case "running": return "sparkles"
        case "completed": return "checkmark.circle.fill"
        case "failed": return "exclamationmark.circle.fill"
        case "suspended": return "pause.circle.fill"
        default: return "moon.zzz.fill"
        }
    }

    private var tint: Color {
        switch client.state {
        case "running": return .accentColor
        case "completed": return .green
        case "failed": return .red
        case "suspended": return .orange
        default: return .secondary
        }
    }
}
