import AVFoundation
import SwiftUI

/// [V-rec] 录音详情:回放(可拖动)、转写(带时间戳 / 说话人)、生成纪要和对结果的操作。
struct RecordingDetailView: View {
    let recordingId: String
    @ObservedObject private var controller = RecordingController.shared
    @ObservedObject private var providerStore = ProviderConfigStore.shared
    @StateObject private var player = RecordingPlayer()
    @State private var transcript = RecordingTranscript()
    @State private var renaming = false
    @State private var renameText = ""
    @State private var speakerToRename: Int?
    @State private var speakerName = ""
    @State private var template: MinutesTemplate = .meeting
    @State private var customInstruction = ""
    @State private var groupId: String = ""
    @State private var showResources = false
    @State private var share: ShareItem?
    @State private var outputTexts: [String: String] = [:]
    @State private var expandedOutput: String?
    @State private var reminderDraft: ReminderDraft?
    @State private var confirmDelete = false
    @State private var confirmRetranscribe = false
    @State private var toast: String?
    @Environment(\.dismiss) private var dismiss

    private var meta: RecordingMetadata? { controller.recordings.first { $0.id == recordingId } ?? controller.metadata(recordingId) }

    var body: some View {
        Group {
            if let meta {
                content(meta)
            } else {
                LeoEmptyState(systemImage: "waveform.slash", title: String(localized: "录音不存在"),
                              message: String(localized: "它可能已经被删除了。"))
            }
        }
        .navigationTitle(meta?.displayTitle ?? String(localized: "录音"))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            reloadTranscript()
            if let meta { player.load(meta: meta, store: controller.store) }
        }
        .onDisappear { player.stop() }
        .onReceive(controller.$recordings) { _ in reloadTranscript() }
        .sheet(item: $share) { item in MinisShareSheet(url: item.url) }
        .sheet(isPresented: $showResources) {
            NavigationStack {
                SystemSpeechResourcesView()
                    .navigationTitle("系统语音与语言资源")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { showResources = false } } }
            }
        }
        .sheet(item: $reminderDraft) { draft in
            ReminderPickerSheet(draft: draft) { selected in
                Task { await createReminders(selected, title: draft.recordingTitle) }
            }
        }
        .alert("重命名录音", isPresented: $renaming) {
            TextField("标题", text: $renameText)
            Button("保存") { controller.rename(recordingId, to: renameText) }
            Button("取消", role: .cancel) {}
        }
        .alert("说话人改名", isPresented: Binding(get: { speakerToRename != nil }, set: { if !$0 { speakerToRename = nil } })) {
            TextField("名字", text: $speakerName)
            Button("保存") {
                if let s = speakerToRename { controller.renameSpeaker(recordingId, speaker: s, to: speakerName) }
            }
            Button("恢复默认") {
                if let s = speakerToRename { controller.renameSpeaker(recordingId, speaker: s, to: "") }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("只改这条录音里的显示名,之后生成纪要会用新名字。")
        }
        .confirmationDialog("删除这条录音?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("删除录音和转写", role: .destructive) {
                player.stop()
                controller.delete(recordingId)
                dismiss()
            }
        } message: {
            Text("音频、转写和缓存的纪要会从这台设备上删除。已经生成的对话保留在对话列表里。")
        }
        .confirmationDialog("重新转写?", isPresented: $confirmRetranscribe, titleVisibility: .visible) {
            Button("重新转写") { controller.transcribe(recordingId, restart: true) }
        } message: {
            Text("现有的转写和说话人标注会被替换。")
        }
    }

    // MARK: - Content

    private func content(_ meta: RecordingMetadata) -> some View {
        List {
            if let error = controller.lastError {
                LeoInlineError(message: error, onDismiss: { controller.lastError = nil })
                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            if let toast {
                Label(toast, systemImage: "checkmark.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(LeoTheme.ColorToken.success)
                    .listRowBackground(Color.clear)
            }
            headerSection(meta)
            playerSection(meta)
            if !meta.highlights.isEmpty { highlightsSection(meta) }
            transcriptSection(meta)
            generateSection(meta)
            if !meta.outputs.isEmpty { outputsSection(meta) }
        }
        .listStyle(.insetGrouped)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button { renameText = meta.title; renaming = true } label: { Label("重命名", systemImage: "pencil") }
                    Button { shareTranscript(meta) } label: { Label("导出转写(Markdown)", systemImage: "square.and.arrow.up") }
                        .disabled(transcript.segments.isEmpty)
                    Button { confirmRetranscribe = true } label: { Label("重新转写", systemImage: "arrow.clockwise") }
                        .disabled(controller.isTranscribing(recordingId))
                    Divider()
                    Button(role: .destructive) { confirmDelete = true } label: { Label("删除录音", systemImage: "trash") }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel(Text("更多"))
            }
        }
    }

    private func headerSection(_ meta: RecordingMetadata) -> some View {
        Section {
            Button { renameText = meta.title; renaming = true } label: {
                VStack(alignment: .leading, spacing: 4) {
                    Text(meta.displayTitle)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(LeoTheme.ColorToken.primaryText)
                        .multilineTextAlignment(.leading)
                    HStack(spacing: 6) {
                        Text(meta.createdAt, format: .dateTime.year().month().day().hour().minute())
                        Text("·")
                        Text(TranscriptAssembler.timestamp(meta.duration)).monospacedDigit()
                        if meta.source == .imported {
                            Text("·")
                            Text("导入")
                        }
                    }
                    .font(.subheadline)
                    .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .accessibilityHint(Text("重命名"))
        }
    }

    // MARK: - Player

    private func playerSection(_ meta: RecordingMetadata) -> some View {
        Section {
            VStack(spacing: LeoTheme.Spacing.xs) {
                Slider(value: Binding(get: { player.currentTime }, set: { player.seek(to: $0) }),
                       in: 0...max(0.1, player.duration))
                    .accessibilityLabel(Text("播放进度"))
                HStack {
                    Text(TranscriptAssembler.timestamp(player.currentTime)).monospacedDigit()
                    Spacer()
                    Text(TranscriptAssembler.timestamp(player.duration)).monospacedDigit()
                }
                .font(.caption)
                .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                HStack(spacing: LeoTheme.Spacing.xl) {
                    Button { player.skip(-15) } label: { Image(systemName: "gobackward.15").font(.title2) }
                        .accessibilityLabel(Text("后退 15 秒"))
                    Button { player.toggle() } label: {
                        Image(systemName: player.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                            .font(.system(size: 48))
                    }
                    .accessibilityLabel(Text(player.isPlaying ? String(localized: "暂停") : String(localized: "播放")))
                    Button { player.skip(15) } label: { Image(systemName: "goforward.15").font(.title2) }
                        .accessibilityLabel(Text("前进 15 秒"))
                }
                .buttonStyle(.plain)
                .foregroundStyle(LeoTheme.ColorToken.accent)
                .disabled(!player.isReady || controller.isRecording)
                if controller.isRecording {
                    Text("录音进行中,停止后才能回放。")
                        .font(.caption)
                        .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                }
            }
            .padding(.vertical, LeoTheme.Spacing.xs)
        }
    }

    private func highlightsSection(_ meta: RecordingMetadata) -> some View {
        Section("重点标记") {
            ForEach(meta.highlights.sorted { $0.time < $1.time }) { mark in
                Button { player.seek(to: mark.time, play: true) } label: {
                    Label {
                        Text(mark.note ?? String(localized: "重点"))
                    } icon: {
                        Text(TranscriptAssembler.timestamp(mark.time)).monospacedDigit().font(.caption.weight(.semibold))
                    }
                }
            }
        }
    }

    // MARK: - Transcript

    @ViewBuilder
    private func transcriptSection(_ meta: RecordingMetadata) -> some View {
        Section {
            transcriptStatus(meta)
            Toggle(isOn: Binding(get: { meta.cloudTranscriptionEnabled },
                                 set: { controller.setCloudTranscription(recordingId, enabled: $0) })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("云端转写")
                    Text(meta.cloudTranscriptionEnabled
                         ? String(localized: "音频会分段发送给「语音输入」里配置的服务商,时间戳为估算。")
                         : String(localized: "关闭:在本机转写,音频不离开设备。"))
                        .font(.caption)
                        .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                }
            }
            .disabled(controller.isTranscribing(recordingId))
            if meta.transcription.phase == .done, !transcript.segments.isEmpty {
                speakerControls(meta)
                ForEach(Array(TranscriptAssembler.paragraphs(transcript.segments).enumerated()), id: \.offset) { _, p in
                    paragraphRow(p, meta: meta)
                }
            }
        } header: {
            Text("转写")
        } footer: {
            if meta.speakersInferred {
                Text("说话人是模型根据语义推断的,可能有误;点名字可以改名。")
            }
        }
    }

    @ViewBuilder
    private func transcriptStatus(_ meta: RecordingMetadata) -> some View {
        if let progress = controller.transcriptionProgress[recordingId] {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(meta.transcription.engine == .cloud ? String(localized: "正在云端转写") : String(localized: "正在本机转写"))
                    Spacer()
                    Text("\(progress.done)/\(progress.total)").monospacedDigit()
                        .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                }
                ProgressView(value: Double(progress.done), total: Double(max(1, progress.total)))
                Button("停止转写") { controller.cancelTranscription(recordingId) }
                    .font(.footnote)
            }
        } else {
            switch meta.transcription.phase {
            case .none:
                Button { controller.transcribe(recordingId) } label: {
                    Label(meta.transcription.completedUnits.isEmpty ? String(localized: "开始转写") : String(localized: "继续转写"),
                          systemImage: "text.bubble")
                }
            case .running:
                Button { controller.transcribe(recordingId) } label: { Label("继续转写", systemImage: "text.bubble") }
            case .needsAssets:
                VStack(alignment: .leading, spacing: 6) {
                    Text(meta.transcription.errorMessage ?? String(localized: "本机缺少这个语言的转写资源。"))
                        .font(.footnote)
                        .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                    HStack {
                        Button("下载语言资源") { showResources = true }
                        Spacer()
                        Button("重试") { controller.transcribe(recordingId) }
                    }
                    .buttonStyle(.borderless)
                }
            case .failed:
                LeoInlineError(message: meta.transcription.errorMessage ?? String(localized: "转写失败"),
                               onRetry: { controller.transcribe(recordingId) })
            case .done:
                if transcript.segments.isEmpty {
                    Text("没有识别出文字。可以换个语言资源或打开云端转写后重新转写。")
                        .font(.footnote)
                        .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                }
            }
        }
    }

    @ViewBuilder
    private func speakerControls(_ meta: RecordingMetadata) -> some View {
        let speakers = TranscriptAssembler.speakers(in: transcript.segments)
        if let busy = controller.busyText[recordingId], busy.contains(String(localized: "说话人")) {
            HStack { ProgressView(); Text(busy).font(.footnote) }
        } else if speakers.isEmpty {
            Button {
                Task { await controller.inferSpeakers(recordingId, groupId: groupId.isEmpty ? nil : groupId) }
            } label: {
                Label("区分说话人(模型推断)", systemImage: "person.2.wave.2")
            }
            .disabled(controller.busyText[recordingId] != nil)
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(speakers, id: \.self) { s in
                        Button {
                            speakerName = meta.speakerNames[String(s)] ?? ""
                            speakerToRename = s
                        } label: {
                            Label(TranscriptAssembler.speakerLabel(s, names: meta.speakerNames), systemImage: "person.crop.circle")
                                .font(.footnote.weight(.medium))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(speakerColor(s).opacity(0.14), in: Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                    Button(role: .destructive) { controller.clearSpeakers(recordingId) } label: {
                        Label("清除", systemImage: "xmark.circle")
                            .font(.footnote)
                    }
                    .buttonStyle(.borderless)
                }
            }
        }
    }

    private func paragraphRow(_ p: TranscriptAssembler.Paragraph, meta: RecordingMetadata) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Button { player.seek(to: p.start, play: true) } label: {
                    Text((p.approximate ? "≈" : "") + TranscriptAssembler.timestamp(p.start))
                        .font(.caption.weight(.semibold))
                        .monospacedDigit()
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(Text("从 \(TranscriptAssembler.timestamp(p.start)) 播放"))
                if let s = p.speaker {
                    Text(TranscriptAssembler.speakerLabel(s, names: meta.speakerNames))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(speakerColor(s))
                }
            }
            Text(p.text)
                .font(.body)
                .textSelection(.enabled)
        }
        .padding(.vertical, 2)
    }

    private func speakerColor(_ s: Int) -> Color {
        let palette: [Color] = [.blue, .orange, .green, .purple, .pink, .teal, .indigo, .brown]
        return palette[(max(1, s) - 1) % palette.count]
    }

    // MARK: - Generate

    private func generateSection(_ meta: RecordingMetadata) -> some View {
        Section {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(MinutesTemplate.allCases) { t in
                        Button { template = t } label: {
                            Label(t.displayName, systemImage: t.symbolName)
                                .font(.footnote.weight(.semibold))
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .foregroundStyle(template == t ? Color.white : LeoTheme.ColorToken.primaryText)
                                .background(template == t ? LeoTheme.ColorToken.accent : LeoTheme.ColorToken.surface, in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(template == t ? .isSelected : [])
                    }
                }
                .padding(.vertical, 2)
            }
            if template == .custom {
                TextField(String(localized: "想怎么整理?例如:列出所有提到的数字和日期"), text: $customInstruction, axis: .vertical)
                    .lineLimit(2...5)
            }
            Picker("模型分组", selection: $groupId) {
                Text("默认").tag("")
                ForEach(providerStore.modelGroups, id: \.id) { g in
                    Text(g.name).tag(g.id)
                }
            }
            if let busy = controller.busyText[recordingId], !busy.contains(String(localized: "说话人")) {
                HStack { ProgressView(); Text(busy).font(.footnote) }
            } else {
                Button {
                    Task {
                        if let output = await controller.generate(recordingId, template: template,
                                                                  customInstruction: customInstruction,
                                                                  groupId: groupId.isEmpty ? nil : groupId) {
                            expandedOutput = output.id
                        }
                    }
                } label: {
                    Label("生成\(template.displayName)", systemImage: "sparkles")
                        .font(.body.weight(.semibold))
                }
                .disabled(transcript.segments.isEmpty || controller.busyText[recordingId] != nil
                          || (template == .custom && customInstruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
            }
        } header: {
            Text("整理成文")
        } footer: {
            Text("结果在一个新对话里生成(附带转写),能继续追问,和其他对话一样同步。转写较长时会先分段提炼再合并。")
        }
    }

    // MARK: - Outputs

    private func outputsSection(_ meta: RecordingMetadata) -> some View {
        Section("已生成") {
            ForEach(meta.outputs) { output in
                OutputRow(recordingId: recordingId, output: output, text: outputTexts[output.id],
                          expanded: expandedOutput == output.id,
                          onToggle: { expandedOutput = expandedOutput == output.id ? nil : output.id },
                          onOpenChat: { RecordingPresenter.openSession(output.sessionId) },
                          onSave: { text in Task { await saveToTreasury(output: output, text: text) } },
                          onReminders: { text in
                              let items = MinutesActionItemParser.parse(text)
                              if items.isEmpty { toast = String(localized: "纪要里没有找到待办。") }
                              else { reminderDraft = ReminderDraft(items: items, recordingTitle: meta.displayTitle) }
                          },
                          onExport: { text, pdf in
                              if let url = MinutesGenerator.exportFile(markdown: text, title: output.title, pdf: pdf) {
                                  share = ShareItem(url: url)
                              }
                          },
                          onLoaded: { text in outputTexts[output.id] = text })
                    .swipeActions {
                        Button(role: .destructive) { controller.removeOutput(recordingId, outputId: output.id) } label: {
                            Label("移除", systemImage: "minus.circle")
                        }
                    }
            }
        }
    }

    // MARK: - Actions

    private func reloadTranscript() {
        transcript = controller.transcript(recordingId)
    }

    private func shareTranscript(_ meta: RecordingMetadata) {
        let md = TranscriptAssembler.renderMarkdown(title: meta.displayTitle, date: meta.createdAt, duration: meta.duration,
                                                    segments: transcript.segments, names: meta.speakerNames,
                                                    speakersInferred: meta.speakersInferred, highlights: meta.highlights)
        if let url = MinutesGenerator.exportFile(markdown: md, title: String(localized: "转写-\(meta.displayTitle)"), pdf: false) {
            share = ShareItem(url: url)
        }
    }

    private func saveToTreasury(output: RecordingOutput, text: String) async {
        let ok = await MinutesGenerator.saveToTreasury(title: output.title, markdown: text)
        toast = ok ? String(localized: "已存入藏宝阁") : nil
        if !ok { controller.lastError = String(localized: "没能存入藏宝阁,请重试。") }
    }

    private func createReminders(_ items: [MinutesActionItem], title: String) async {
        guard !items.isEmpty else { return }
        if let count = await MinutesGenerator.createReminders(items, recordingTitle: title) {
            toast = String(localized: "已添加 \(count) 条提醒事项")
        } else {
            controller.lastError = String(localized: "没有提醒事项权限。请在系统设置 › LeoBot 里允许访问提醒事项。")
        }
    }
}

struct ShareItem: Identifiable {
    let url: URL
    var id: String { url.path }
}

struct ReminderDraft: Identifiable {
    let id = UUID()
    let items: [MinutesActionItem]
    let recordingTitle: String
}

/// 一次生成:进行中显示进度,完成后可展开看结果并操作。
private struct OutputRow: View {
    let recordingId: String
    let output: RecordingOutput
    let text: String?
    let expanded: Bool
    let onToggle: () -> Void
    let onOpenChat: () -> Void
    let onSave: (String) -> Void
    let onReminders: (String) -> Void
    let onExport: (String, Bool) -> Void
    let onLoaded: (String) -> Void
    @State private var finished = false

    var body: some View {
        VStack(alignment: .leading, spacing: LeoTheme.Spacing.xs) {
            Button(action: onToggle) {
                HStack {
                    Image(systemName: MinutesTemplate(rawValue: output.template)?.symbolName ?? "doc.text")
                        .foregroundStyle(LeoTheme.ColorToken.accent)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(output.title).font(.body.weight(.medium)).lineLimit(1)
                        Text(output.createdAt, format: .dateTime.month().day().hour().minute())
                            .font(.caption)
                            .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                    }
                    Spacer()
                    if text == nil && !finished {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: expanded ? "chevron.up" : "chevron.down")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded {
                if let text {
                    SelectableMarkdownView(markdown: text)
                        .padding(.vertical, 4)
                    actions(text)
                } else if finished {
                    Text("没有拿到生成结果。打开对话看看发生了什么。")
                        .font(.footnote)
                        .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                } else {
                    Text("正在生成,可以先打开对话看过程。")
                        .font(.footnote)
                        .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                }
                Button(action: onOpenChat) {
                    Label("在对话中继续追问", systemImage: "bubble.left.and.text.bubble.right")
                }
                .buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 4)
        .task(id: output.id) {
            guard text == nil else { finished = true; return }
            while !Task.isCancelled {
                let result = await RecordingController.shared.outputText(recordingId, output: output)
                if result.finished {
                    finished = true
                    if let t = result.text { onLoaded(t) }
                    return
                }
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private func actions(_ text: String) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip("存入藏宝阁", "star") { onSave(text) }
                chip("建提醒事项", "checklist") { onReminders(text) }
                chip("导出 Markdown", "doc.plaintext") { onExport(text, false) }
                chip("导出 PDF", "doc.richtext") { onExport(text, true) }
            }
        }
    }

    private func chip(_ title: LocalizedStringKey, _ icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(.footnote.weight(.semibold))
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(LeoTheme.ColorToken.surface, in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

/// 选择要建成提醒事项的待办。
private struct ReminderPickerSheet: View {
    let draft: ReminderDraft
    let onConfirm: ([MinutesActionItem]) -> Void
    @State private var selected: Set<Int> = []
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List(draft.items) { item in
                Button {
                    if selected.contains(item.id) { selected.remove(item.id) } else { selected.insert(item.id) }
                } label: {
                    HStack(alignment: .top) {
                        Image(systemName: selected.contains(item.id) ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(LeoTheme.ColorToken.accent)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.title).foregroundStyle(LeoTheme.ColorToken.primaryText)
                            let meta = [item.owner.map { String(localized: "负责人:\($0)") },
                                        item.due.map { String(localized: "期限:\($0)") }].compactMap { $0 }
                            if !meta.isEmpty {
                                Text(meta.joined(separator: " · "))
                                    .font(.caption)
                                    .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                            }
                        }
                    }
                }
            }
            .navigationTitle("建提醒事项")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("添加 \(selected.count) 条") {
                        onConfirm(draft.items.filter { selected.contains($0.id) })
                        dismiss()
                    }
                    .disabled(selected.isEmpty)
                }
            }
            .onAppear { selected = Set(draft.items.map(\.id)) }
        }
        .presentationDetents([.medium, .large])
    }
}

/// [V-rec] 回放:把各块音频按顺序拼成一个 AVComposition,一个进度条拖遍整条录音。
@MainActor
final class RecordingPlayer: ObservableObject {
    @Published private(set) var isPlaying = false
    @Published private(set) var isReady = false
    @Published private(set) var currentTime: Double = 0
    @Published private(set) var duration: Double = 0

    private var player: AVPlayer?
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var loadedId: String?
    private var holdsSession = false

    func load(meta: RecordingMetadata, store: RecordingStore) {
        guard loadedId != meta.id || !isReady else { return }
        loadedId = meta.id
        let chunks = meta.chunks.sorted { $0.index < $1.index }
        Task {
            let composition = AVMutableComposition()
            guard let track = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { return }
            var cursor = CMTime.zero
            for chunk in chunks {
                guard let url = try? store.audioURL(for: meta.id, fileName: chunk.fileName) else { continue }
                let asset = AVURLAsset(url: url)
                guard let source = try? await asset.loadTracks(withMediaType: .audio).first,
                      let range = try? await source.load(.timeRange), range.duration.seconds > 0 else { continue }
                try? track.insertTimeRange(range, of: source, at: cursor)
                cursor = cursor + range.duration
            }
            let item = AVPlayerItem(asset: composition)
            let player = AVPlayer(playerItem: item)
            self.player = player
            self.duration = cursor.seconds.isFinite ? cursor.seconds : meta.duration
            self.isReady = cursor.seconds > 0
            self.timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600),
                                                               queue: .main) { [weak self] time in
                MainActor.assumeIsolated { self?.currentTime = time.seconds.isFinite ? time.seconds : 0 }
            }
            self.endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime,
                                                                      object: item, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.isPlaying = false
                    self?.releaseSession()
                    self?.player?.seek(to: .zero)
                }
            }
        }
    }

    func toggle() { isPlaying ? pause() : play() }

    func play() {
        guard let player, isReady, !RecordingController.shared.isRecording else { return }
        if !holdsSession {
            AudioSessionCoordinator.shared.begin(.mediaAttachment)
            holdsSession = true
        }
        player.play()
        isPlaying = true
    }

    func pause() {
        player?.pause()
        isPlaying = false
        releaseSession()
    }

    func stop() {
        pause()
        if let timeObserver { player?.removeTimeObserver(timeObserver) }
        timeObserver = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        player = nil
        isReady = false
        loadedId = nil
    }

    func seek(to seconds: Double, play: Bool = false) {
        guard let player else { return }
        let t = max(0, min(seconds, duration))
        currentTime = t
        player.seek(to: CMTime(seconds: t, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        if play { self.play() }
    }

    func skip(_ delta: Double) { seek(to: currentTime + delta) }

    private func releaseSession() {
        guard holdsSession else { return }
        holdsSession = false
        AudioSessionCoordinator.shared.end(.mediaAttachment)
    }
}
