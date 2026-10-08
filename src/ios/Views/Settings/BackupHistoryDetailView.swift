import SwiftUI

/// 一次备份 / 恢复的详情：结果、各类别、投递位置、未包含的文件和运行日志。
struct BackupHistoryDetailView: View {
    let recordId: UUID
    @ObservedObject private var history = BackupHistory.shared
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        if let r = history.record(recordId) {
            List {
                Section {
                    HStack {
                        BackupHistoryRow(record: r)
                    }
                    if let error = r.errorMessage {
                        Text(error).font(.footnote).foregroundStyle(LeoTheme.ColorToken.destructive)
                    }
                }
                Section("概况") {
                    row("开始", r.startedAt.formatted(date: .abbreviated, time: .standard))
                    if let d = r.duration { row("用时", BackupProgressReporter.durationText(d)) }
                    if r.kind == .export {
                        row("大小", ByteCountFormatter.string(fromByteCount: r.totalBytes, countStyle: .file))
                        if let name = r.packageName { row("文件名", name) }
                    }
                    row("加密", r.encrypted ? String(localized: "是") : String(localized: "否"))
                }
                if !r.categoryLines.isEmpty {
                    Section("类别") {
                        ForEach(r.categoryLines) { line in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(BackupCategory(rawValue: line.category)?.displayName ?? line.category)
                                Text(line.summary).font(.caption)
                                    .foregroundStyle(line.failed ? LeoTheme.ColorToken.destructive : LeoTheme.ColorToken.secondaryText)
                            }
                        }
                    }
                }
                if !r.destinations.isEmpty {
                    Section("保存位置") {
                        ForEach(r.destinations, id: \.self) { Text($0).font(.subheadline) }
                    }
                }
                if r.skippedFiles > 0 {
                    Section {
                        ForEach(r.skippedEntries) { e in
                            HStack {
                                Text(e.fileName).font(.subheadline).lineLimit(1)
                                Spacer()
                                Text(ByteCountFormatter.string(fromByteCount: e.size, countStyle: .file))
                                    .font(.caption).foregroundStyle(LeoTheme.ColorToken.secondaryText)
                            }
                        }
                    } header: {
                        Text("未包含的文件（\(r.skippedFiles)）")
                    } footer: {
                        Text("这些文件超出了大小上限，没有放进备份。")
                    }
                }
                if !r.log.isEmpty {
                    Section("日志") {
                        ForEach(r.log) { entry in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(entry.message).font(.footnote)
                                    .foregroundStyle(entry.isProblem ? LeoTheme.ColorToken.warning : LeoTheme.ColorToken.primaryText)
                                Text(entry.at.formatted(date: .omitted, time: .standard))
                                    .font(.caption2).foregroundStyle(LeoTheme.ColorToken.tertiaryText)
                            }
                        }
                    }
                }
                if r.status != .running {
                    Section {
                        Button("删除这条记录", role: .destructive) {
                            history.remove(recordId)
                            dismiss()
                        }
                    }
                }
            }
            .navigationTitle(r.kind == .export ? "备份详情" : "恢复详情")
            .navigationBarTitleDisplayMode(.inline)
        } else {
            LeoEmptyState(systemImage: "clock.badge.xmark", title: String(localized: "记录已删除"))
        }
    }

    private func row(_ title: String, _ value: String) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text(value).foregroundStyle(LeoTheme.ColorToken.secondaryText).multilineTextAlignment(.trailing)
        }
    }
}
