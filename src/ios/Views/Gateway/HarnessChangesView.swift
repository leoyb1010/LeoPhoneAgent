//
//  HarnessChangesView.swift
//  MinisApp
//
//  Mac 会话的「改动」面板:工作区改了哪些文件 → 单文件统一 diff;每轮检查点可一键回到那一轮之前。
//  数据走 Leo Link 的 changes / diff / revert 路由(HarnessSessionDriver),解析是纯函数(HarnessSessionLogic)。
//

import SwiftUI
import UIKit

struct HarnessChangesSheet: View {
    @ObservedObject var driver: HarnessSessionDriver
    @Environment(\.dismiss) private var dismiss
    @State private var pendingCheckpoint: HarnessCheckpoint?
    @State private var working = false
    @State private var errorText: String?
    @State private var loaded = false

    var body: some View {
        NavigationStack {
            List {
                content
                if let errorText {
                    Section {
                        Label(errorText, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(Text("改动"))
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: HarnessChangedFile.self) { file in
                HarnessDiffView(driver: driver, file: file)
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
                ToolbarItem(placement: .topBarLeading) {
                    if working { ProgressView() }
                }
            }
            .refreshable { await driver.refreshChanges() }
            .task {
                await driver.refreshChanges()
                loaded = true
            }
            .confirmationDialog(
                Text("回到第 \(pendingCheckpoint?.turn ?? 0) 轮之前？"),
                isPresented: Binding(get: { pendingCheckpoint != nil }, set: { if !$0 { pendingCheckpoint = nil } }),
                titleVisibility: .visible,
                presenting: pendingCheckpoint
            ) { checkpoint in
                Button("回到这一轮之前", role: .destructive) { revert(to: checkpoint) }
                Button("取消", role: .cancel) {}
            } message: { _ in
                Text("这一轮开始之后对文件的改动都会撤销，这一轮里新建的文件会删除。提交历史不动。")
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let changes = driver.changes {
            if !changes.isRepo {
                Section {
                    emptyRow(symbol: "folder.badge.questionmark",
                             title: "这个目录不是 git 仓库",
                             detail: "看不到改动，也没有每轮检查点。\(changes.cwd)")
                }
            } else {
                Section {
                    if changes.files.isEmpty {
                        emptyRow(symbol: "checkmark.seal", title: "没有未提交的改动", detail: "工作区和 HEAD 一致。")
                    }
                    ForEach(changes.files) { file in
                        NavigationLink(value: file) { HarnessFileRow(file: file) }
                    }
                } header: {
                    HStack(spacing: 6) {
                        if let branch = changes.branch {
                            Label(branch, systemImage: "arrow.triangle.branch").lineLimit(1)
                        }
                        Spacer()
                        if !changes.files.isEmpty {
                            Text("\(changes.files.count) 个文件").foregroundStyle(.secondary)
                            DiffStat(additions: changes.additions, deletions: changes.deletions)
                        }
                    }
                    .textCase(nil)
                }
                if !changes.checkpoints.isEmpty {
                    Section {
                        ForEach(changes.checkpoints) { checkpoint in
                            Button { pendingCheckpoint = checkpoint } label: {
                                CheckpointRow(checkpoint: checkpoint)
                            }
                            .disabled(working)
                        }
                    } header: {
                        Text("每轮检查点")
                    } footer: {
                        Text("每轮开始时 Mac 自动记下工作区。点一轮可以回到它开始之前。")
                    }
                }
            }
        } else if loaded {
            Section {
                emptyRow(symbol: "wifi.exclamationmark", title: "暂时拿不到改动", detail: "下拉重试。")
            }
        } else {
            Section {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("正在读取改动…").foregroundStyle(.secondary)
                }
            }
        }
    }

    private func emptyRow(symbol: String, title: LocalizedStringKey, detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 20))
                .foregroundStyle(.secondary)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.medium))
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    private func revert(to checkpoint: HarnessCheckpoint) {
        working = true
        errorText = nil
        Task {
            do {
                try await driver.revert(checkpoint: checkpoint)
                LeoHaptics.notification(.success)
            } catch {
                errorText = LeoAgentClient.describeHarnessFeatureError(error)
                LeoHaptics.notification(.error)
            }
            working = false
        }
    }
}

// MARK: - Rows

private struct HarnessFileRow: View {
    let file: HarnessChangedFile

    private var name: String { (file.path as NSString).lastPathComponent }
    private var directory: String {
        let dir = (file.path as NSString).deletingLastPathComponent
        return dir.isEmpty ? "" : dir + "/"
    }

    var body: some View {
        HStack(spacing: 10) {
            FileStatusBadge(status: file.status)
            VStack(alignment: .leading, spacing: 1) {
                Text(name)
                    .font(.system(size: 15, weight: .medium, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let old = file.oldPath {
                    Text("← \(old)")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.head)
                } else if !directory.isEmpty {
                    Text(directory)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.head)
                }
            }
            Spacer(minLength: 6)
            DiffStat(additions: file.additions, deletions: file.deletions)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

private struct FileStatusBadge: View {
    let status: String

    private var style: (String, Color) {
        switch status {
        case "A": return ("A", .green)
        case "D": return ("D", .red)
        case "R": return ("R", .blue)
        case "?": return ("U", .green)
        default: return ("M", LeoTheme.ColorToken.attention)
        }
    }

    var body: some View {
        Text(style.0)
            .font(.system(size: 11, weight: .bold, design: .monospaced))
            .foregroundStyle(style.1)
            .frame(width: 20, height: 20)
            .background(style.1.opacity(0.14), in: RoundedRectangle(cornerRadius: 5))
            .accessibilityLabel(Text(status == "A" || status == "?" ? "新增" : status == "D" ? "删除" : status == "R" ? "重命名" : "修改"))
    }
}

private struct DiffStat: View {
    let additions: Int
    let deletions: Int

    var body: some View {
        HStack(spacing: 4) {
            if additions > 0 { Text("+\(additions)").foregroundStyle(.green) }
            if deletions > 0 { Text("−\(deletions)").foregroundStyle(.red) }
        }
        .font(.system(size: 12, weight: .medium, design: .monospaced))
        .monospacedDigit()
    }
}

private struct CheckpointRow: View {
    let checkpoint: HarnessCheckpoint

    var body: some View {
        HStack(spacing: 12) {
            Text("\(checkpoint.turn)")
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(width: 28, height: 28)
                .background(Color.secondary.opacity(0.12), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(checkpoint.label.isEmpty ? AppLocalized("第 \(checkpoint.turn) 轮") : checkpoint.label)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                if let date = checkpoint.createdAt {
                    Text(date, format: .relative(presentation: .named))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 6)
            Label("回到这一轮之前", systemImage: "arrow.uturn.backward")
                .labelStyle(.iconOnly)
                .foregroundStyle(.tint)
        }
        .contentShape(Rectangle())
    }
}

// MARK: - Diff

struct HarnessDiffView: View {
    @ObservedObject var driver: HarnessSessionDriver
    let file: HarnessChangedFile
    var checkpoint: String? = nil
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    @State private var diff: HarnessFileDiff?
    @State private var lines: [UnifiedDiffLine] = []
    @State private var errorText: String?
    @State private var showAll = false
    @State private var confirmRevert = false
    @State private var reverting = false

    /// 超过这么多行先折起来(几千行的 diff 一次铺开会卡,也没人一口气看完)。
    private static let foldLimit = 600
    private static let fontSize: CGFloat = 12

    var body: some View {
        Group {
            if let errorText {
                ContentUnavailableView {
                    Label("没拿到 diff", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(errorText)
                } actions: {
                    Button("重试") { Task { await load() } }
                }
            } else if let diff {
                if diff.binary {
                    ContentUnavailableView("二进制文件", systemImage: "doc.zipper", description: Text("这个文件不是文本，没法逐行比较。"))
                } else if lines.isEmpty {
                    ContentUnavailableView("没有差异", systemImage: "equal.circle", description: Text("这个文件和对比的版本一致。"))
                } else {
                    diffBody(diff)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(Text((file.path as NSString).lastPathComponent))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(role: .destructive) { confirmRevert = true } label: {
                    if reverting { ProgressView() } else { Label("撤销这个文件的改动", systemImage: "arrow.uturn.backward.circle") }
                }
                .disabled(reverting)
            }
        }
        .confirmationDialog(Text("撤销这个文件的改动？"), isPresented: $confirmRevert, titleVisibility: .visible) {
            Button("撤销改动", role: .destructive) { revert() }
            Button("取消", role: .cancel) {}
        } message: {
            Text(file.status == "?" || file.status == "A"
                 ? "这是新文件，撤销会把它删掉。"
                 : "文件会恢复成最近一次提交（HEAD）的样子。")
        }
        .task { await load() }
    }

    private func diffBody(_ diff: HarnessFileDiff) -> some View {
        let visible = showAll ? lines[...] : lines.prefix(Self.foldLimit)
        let gutter = max(3, String(lines.compactMap { $0.newNumber ?? $0.oldNumber }.max() ?? 0).count)
        let charWidth = ("M" as NSString).size(withAttributes: [.font: UIFont.monospacedSystemFont(ofSize: Self.fontSize, weight: .regular)]).width
        let longest = visible.map(\.text.count).max() ?? 0
        let contentWidth = CGFloat(longest + gutter * 2 + 4) * charWidth + 24
        return GeometryReader { geo in
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 0) {
                    ScrollView(.horizontal, showsIndicators: true) {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(visible.enumerated()), id: \.offset) { _, line in
                                DiffLineRow(line: line, gutter: gutter, fontSize: Self.fontSize, dark: colorScheme == .dark)
                            }
                        }
                        .frame(width: max(geo.size.width, contentWidth), alignment: .leading)
                    }
                    if !showAll && lines.count > Self.foldLimit {
                        Button {
                            showAll = true
                        } label: {
                            Label("展开其余 \(lines.count - Self.foldLimit) 行", systemImage: "chevron.down")
                                .font(.footnote.weight(.medium))
                                .frame(maxWidth: .infinity, minHeight: LeoTheme.TouchTarget.minimum)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.tint)
                    }
                    if diff.truncated {
                        Text("diff 太长，Mac 只回传了前 256KB。完整内容请在 Mac 上看。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(16)
                    }
                }
            }
        }
    }

    private func load() async {
        errorText = nil
        do {
            let fresh = try await driver.fileDiff(path: file.path, checkpoint: checkpoint)
            // 解析放到后台:几千行的 diff 在主线程拆会掉帧。
            let parsed = await Task.detached(priority: .userInitiated) {
                UnifiedDiff.parse(fresh.diff).filter { line in
                    // 文件头(diff --git / index / --- / +++)在标题里已经有了,不重复显示。
                    guard line.kind == .meta else { return true }
                    return !["diff --git", "index ", "--- ", "+++ "].contains { line.text.hasPrefix($0) } && !line.text.isEmpty
                }
            }.value
            lines = parsed
            diff = fresh
        } catch {
            errorText = LeoAgentClient.describeHarnessFeatureError(error)
        }
    }

    private func revert() {
        reverting = true
        Task {
            do {
                try await driver.revert(checkpoint: nil, paths: [file.path])
                LeoHaptics.notification(.success)
                dismiss()
            } catch {
                errorText = LeoAgentClient.describeHarnessFeatureError(error)
                LeoHaptics.notification(.error)
            }
            reverting = false
        }
    }
}

private struct DiffLineRow: View {
    let line: UnifiedDiffLine
    let gutter: Int
    let fontSize: CGFloat
    let dark: Bool

    private var tint: Color? {
        switch line.kind {
        case .added: return .green
        case .removed: return .red
        default: return nil
        }
    }

    private var background: Color {
        switch line.kind {
        case .added: return Color.green.opacity(dark ? 0.18 : 0.12)
        case .removed: return Color.red.opacity(dark ? 0.18 : 0.10)
        case .hunk: return Color.accentColor.opacity(dark ? 0.16 : 0.08)
        default: return .clear
        }
    }

    private var marker: String {
        switch line.kind {
        case .added: return "+"
        case .removed: return "−"
        default: return " "
        }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            if line.kind == .hunk || line.kind == .meta || line.kind == .noNewline {
                Text(line.text)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 12)
                    .padding(.vertical, line.kind == .hunk ? 4 : 1)
            } else {
                number(line.oldNumber)
                number(line.newNumber)
                Text(marker)
                    .foregroundStyle(tint ?? .secondary)
                    .frame(width: fontSize * 1.2)
                Text(highlighted)
                    .padding(.trailing, 12)
            }
            Spacer(minLength: 0)
        }
        .font(.system(size: fontSize, design: .monospaced))
        .lineLimit(1)
        .fixedSize(horizontal: false, vertical: true)
        .background(background)
        .textSelection(.enabled)
    }

    private func number(_ value: Int?) -> some View {
        Text(value.map(String.init) ?? "")
            .foregroundStyle(.tertiary)
            .frame(width: CGFloat(gutter) * fontSize * 0.62 + 10, alignment: .trailing)
            .padding(.trailing, 4)
    }

    /// 字内高亮:真正改动的那一段加深底色。
    private var highlighted: AttributedString {
        var text = AttributedString(line.text.isEmpty ? " " : line.text)
        if let range = line.highlight, let tint, range.upperBound <= line.text.count {
            let start = text.index(text.startIndex, offsetByCharacters: range.lowerBound)
            let end = text.index(text.startIndex, offsetByCharacters: range.upperBound)
            text[start..<end].backgroundColor = tint.opacity(dark ? 0.38 : 0.26)
        }
        return text
    }
}
