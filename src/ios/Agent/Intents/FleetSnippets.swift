//
//  FleetSnippets.swift
//  MinisApp
//
//  [T-siri-snippets] Siri / Spotlight / 操作按钮里直接出卡片。
//
//  在这之前,舰队四件套只能靠 Siri 念一段话:念完想干点什么还得开 app。
//  Interactive Snippet 让结果、确认和后续动作直接出现在当前上下文里 ——
//  "LPA汇报"念完的同时给出一张卡,上面就有「批准」按钮。
//
//  三张卡:
//  ① 舰队状态卡:每台 Mac 一行,有待审批的显式标红并带批准按钮
//  ② 开工确认卡:指挥 Mac 之后回执,附「查看进度」
//  ③ 批准结果卡:批了什么、批给了谁
//
//  注意:控制中心发起的 intent 不能显示 snippet(系统限制),所以控制中心
//  那几个入口仍走"启动任务/打开界面",snippet 的主战场是 Siri、Spotlight、
//  快捷指令与操作按钮链路。
//

import AppIntents
import SwiftUI

// MARK: - 卡片数据

@available(iOS 26.0, *)
struct FleetSnapshotRow: Identifiable, Hashable {
    let id: String          // host id
    let name: String
    let activeCount: Int
    let waitingCount: Int
    let pendingCommand: String?
    let reachable: Bool
}

// MARK: - ① 舰队状态卡

@available(iOS 26.0, *)
struct FleetStatusSnippet: View {
    let rows: [FleetSnapshotRow]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Mac 舰队", systemImage: "desktopcomputer")
                .font(.headline)
            ForEach(rows) { row in
                HStack(alignment: .top, spacing: 8) {
                    Circle()
                        .fill(row.reachable ? (row.waitingCount > 0 ? Color.orange : .green) : .secondary)
                        .frame(width: 8, height: 8)
                        .padding(.top, 5)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.name).font(.system(size: 15, weight: .medium))
                        Text(subtitle(row))
                            .font(.caption)
                            .foregroundStyle(row.waitingCount > 0 ? .orange : .secondary)
                        if let cmd = row.pendingCommand, !cmd.isEmpty {
                            Text(cmd)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                    Spacer(minLength: 0)
                }
            }
            if rows.contains(where: { $0.waitingCount > 0 }) {
                Button(intent: ApprovePendingMacIntent()) {
                    Label("批准最近一条", systemImage: "checkmark.seal.fill")
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(4)
    }

    private func subtitle(_ row: FleetSnapshotRow) -> String {
        if !row.reachable { return "没连上" }
        if row.waitingCount > 0 { return "\(row.activeCount) 个进行中 · \(row.waitingCount) 个等你审批" }
        if row.activeCount > 0 { return "\(row.activeCount) 个进行中" }
        return "空闲"
    }
}

// MARK: - ② 开工确认卡

@available(iOS 26.0, *)
struct MacDispatchSnippet: View {
    let machine: String
    let cli: String
    let task: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("已开工", systemImage: "play.circle.fill")
                .font(.headline)
                .foregroundStyle(.green)
            Text("\(machine) · \(cli)")
                .font(.system(size: 15, weight: .medium))
            Text(task)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(3)
            Button(intent: MacFleetStatusIntent()) {
                Label("查看进度", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
        }
        .padding(4)
    }
}

// MARK: - ③ 批准结果卡

@available(iOS 26.0, *)
struct ApprovalResultSnippet: View {
    let machine: String
    let command: String
    let approved: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(approved ? "已批准" : "未能批准",
                  systemImage: approved ? "checkmark.seal.fill" : "exclamationmark.triangle.fill")
                .font(.headline)
                .foregroundStyle(approved ? .green : .orange)
            Text(machine).font(.system(size: 15, weight: .medium))
            Text(command)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(3)
            if approved {
                Button(intent: MacFleetStatusIntent()) {
                    Label("看看后续", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(4)
    }
}
