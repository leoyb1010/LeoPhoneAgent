import SwiftUI
import UniformTypeIdentifiers

/// [V-rec] 录音列表:开始录音、导入音频、每条录音的日期 / 时长 / 标题 / 状态。
struct RecordingListView: View {
    let onClose: () -> Void
    @ObservedObject private var controller = RecordingController.shared
    @EnvironmentObject private var navigation: RecordingNavigation
    @State private var showImporter = false
    @State private var pendingDelete: RecordingMetadata?
    @State private var starting = false

    var body: some View {
        List {
            if let error = controller.lastError {
                LeoInlineError(message: error, onDismiss: { controller.lastError = nil })
                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            Section {
                if let active = controller.active {
                    activeCard(active)
                } else {
                    startCard
                }
            } footer: {
                Text("音频只保存在这台设备上,不进 iCloud,也不进备份。转写默认在本机完成;只有你在录音详情里打开云端转写,或生成纪要时,文字才会交给你选的服务。")
            }

            if controller.recordings.filter({ $0.id != controller.active?.id }).isEmpty {
                LeoEmptyState(systemImage: "waveform",
                              title: String(localized: "还没有录音"),
                              message: String(localized: "录下会议、访谈或一次沟通,停止后自动转写,一键整理成纪要。"),
                              actionTitle: String(localized: "导入音频"),
                              actionSystemImage: "square.and.arrow.down",
                              action: { showImporter = true },
                              actionIdentifier: "recordings.empty.import")
            } else {
                Section("全部录音") {
                    ForEach(controller.recordings.filter { $0.id != controller.active?.id }) { meta in
                        NavigationLink(value: RecordingNavigation.Route.detail(meta.id)) {
                            RecordingRow(meta: meta, progress: controller.transcriptionProgress[meta.id])
                        }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { pendingDelete = meta } label: {
                                Label("删除", systemImage: "trash")
                            }
                        }
                        .contextMenu {
                            Button(role: .destructive) { pendingDelete = meta } label: {
                                Label("删除录音", systemImage: "trash")
                            }
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("录音")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("完成", action: onClose)
            }
            ToolbarItem(placement: .primaryAction) {
                Button { showImporter = true } label: {
                    Label("导入音频", systemImage: "square.and.arrow.down")
                }
                .accessibilityIdentifier("recordings.import")
            }
        }
        .fileImporter(isPresented: $showImporter, allowedContentTypes: [.audio], allowsMultipleSelection: false) { result in
            guard case .success(let urls) = result, let url = urls.first else { return }
            Task {
                if let id = await controller.importAudio(from: url) {
                    navigation.path = [.detail(id)]
                }
            }
        }
        .confirmationDialog("删除这条录音?", isPresented: Binding(get: { pendingDelete != nil },
                                                               set: { if !$0 { pendingDelete = nil } }),
                            titleVisibility: .visible, presenting: pendingDelete) { meta in
            Button("删除录音和转写", role: .destructive) { controller.delete(meta.id) }
        } message: { _ in
            Text("音频、转写和缓存的纪要会从这台设备上删除。已经生成的对话保留在对话列表里。")
        }
        .onAppear { controller.reload() }
    }

    private func start() {
        guard !starting else { return }
        starting = true
        Task {
            let ok = await controller.startRecording()
            starting = false
            if ok { navigation.path = [.recorder] }
        }
    }

    private var startCard: some View {
        Button(action: start) {
            HStack(spacing: LeoTheme.Spacing.md) {
                ZStack {
                    Circle().fill(LeoTheme.ColorToken.destructive)
                    if starting {
                        ProgressView().tint(.white)
                    } else {
                        Image(systemName: "mic.fill")
                            .font(.system(size: 22, weight: .semibold))
                            .foregroundStyle(.white)
                    }
                }
                .frame(width: 56, height: 56)
                VStack(alignment: .leading, spacing: 4) {
                    Text("开始录音")
                        .font(.headline)
                        .foregroundStyle(LeoTheme.ColorToken.primaryText)
                    Text("锁屏后继续录,可随时暂停和标记重点")
                        .font(.subheadline)
                        .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, LeoTheme.Spacing.xs)
            .contentShape(Rectangle())
        }
        .buttonStyle(LeoSquishButtonStyle())
        .disabled(starting)
        .accessibilityIdentifier("recordings.start")
    }

    private func activeCard(_ active: RecordingController.Active) -> some View {
        NavigationLink(value: RecordingNavigation.Route.recorder) {
            HStack(spacing: LeoTheme.Spacing.md) {
                ZStack {
                    Circle().fill(LeoTheme.ColorToken.destructive.opacity(active.isPaused ? 0.35 : 1))
                    Image(systemName: active.isPaused ? "pause.fill" : "waveform")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(.white)
                        .symbolEffect(.variableColor.iterative, isActive: !active.isPaused)
                }
                .frame(width: 56, height: 56)
                VStack(alignment: .leading, spacing: 4) {
                    Text(active.title)
                        .font(.headline)
                        .lineLimit(1)
                    RecordingElapsedText(prefix: active.isPaused ? String(localized: "已暂停") : String(localized: "正在录音"))
                }
            }
            .padding(.vertical, LeoTheme.Spacing.xs)
        }
        .accessibilityIdentifier("recordings.active")
    }
}

/// 列表里的一行。
struct RecordingRow: View {
    let meta: RecordingMetadata
    let progress: (done: Int, total: Int)?

    var body: some View {
        HStack(alignment: .center, spacing: LeoTheme.Spacing.sm) {
            Image(systemName: meta.source == .imported ? "square.and.arrow.down" : "waveform")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(LeoTheme.ColorToken.accent)
                .frame(width: 36, height: 36)
                .background(LeoTheme.ColorToken.accent.opacity(0.10), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(meta.displayTitle)
                    .font(.body)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Text(meta.createdAt, format: .dateTime.month().day().hour().minute())
                    Text("·")
                    Text(TranscriptAssembler.timestamp(meta.duration))
                        .monospacedDigit()
                }
                .font(.caption)
                .foregroundStyle(LeoTheme.ColorToken.secondaryText)
            }
            Spacer(minLength: 4)
            statusChip
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var statusChip: some View {
        let text: String
        if let progress, progress.total > 0 {
            text = String(localized: "转写 \(progress.done)/\(progress.total)")
        } else {
            text = meta.statusLabel
        }
        let tint: Color
        switch meta.transcription.phase {
        case .failed, .needsAssets: tint = LeoTheme.ColorToken.warning
        case .done: tint = LeoTheme.ColorToken.success
        default: tint = LeoTheme.ColorToken.secondaryText
        }
        return Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(tint.opacity(0.12), in: Capsule())
    }
}

/// 录音时长,半秒刷新(只有这一个小视图订阅实时状态)。
struct RecordingElapsedText: View {
    var prefix: String? = nil
    @ObservedObject private var live = RecordingController.shared.live

    var body: some View {
        HStack(spacing: 4) {
            if let prefix { Text(prefix) }
            Text(TranscriptAssembler.timestamp(live.elapsed)).monospacedDigit()
        }
        .font(.subheadline)
        .foregroundStyle(LeoTheme.ColorToken.secondaryText)
    }
}
