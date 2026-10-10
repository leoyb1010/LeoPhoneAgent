import EventKit
import Foundation
import UIKit

private let logger = AppLogger(category: "Recording")

/// [V-rec] 用你的模型分组做三件事:
/// 1. 说话人推断(直接调模型,结果只回写转写的说话人编号);
/// 2. 长转写的分段笔记(map);
/// 3. 最终纪要:建一个普通对话(带转写附件)用现有 agent 管线生成 —— 能同步、能追问。
/// 日志里只记字数、段数、耗时,不记转写内容。
@MainActor
enum MinutesGenerator {
    enum GenerateError: Error, LocalizedError {
        case noModel
        case emptyTranscript
        case notStarted
        case emptyReply

        var errorDescription: String? {
            switch self {
            case .noModel: return String(localized: "还没有可用的模型分组。请先在设置里连接一个模型。")
            case .emptyTranscript: return String(localized: "转写还是空的,先转写再生成。")
            case .notStarted: return String(localized: "生成没有开始,请稍后再试。")
            case .emptyReply: return String(localized: "模型没有返回内容。")
            }
        }
    }

    struct ResolvedModel {
        let groupId: String
        let entry: ModelEntry
    }

    /// 选中的分组(nil = 默认分组)解析到一个可用模型。
    static func resolveModel(groupId: String?) -> ResolvedModel? {
        let store = ProviderConfigStore.shared
        let candidates = [groupId, store.defaultPrimaryGroupId].compactMap { $0 } + store.modelGroups.map(\.id)
        for gid in candidates {
            guard let group = store.group(for: gid),
                  let entryId = ModelGroupRouter.resolve(group: group, sessionId: "recording", store: store, verbose: false),
                  let entry = store.entry(for: entryId) else { continue }
            return ResolvedModel(groupId: gid, entry: entry)
        }
        return nil
    }

    /// 一次不带工具、不思考的模型调用(说话人推断、分段笔记)。
    static func complete(system: String, user: String, entry: ModelEntry, maxTokens: Int) async throws -> String {
        let provider = await AIChatViewModel.makeAgentProvider(for: entry)
        let stream = try await provider.streamAgentMessage(
            messages: [AgentMessage(role: .user, parts: [.text(user)])],
            systemPrompt: system, tools: [], maxTokens: maxTokens, thinkingLevel: .off)
        var text = ""
        for try await event in stream {
            try Task.checkCancellation()
            if case .textDelta(let delta) = event { text += delta }
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw GenerateError.emptyReply }
        return trimmed
    }

    // MARK: - Speakers

    /// 按 120 行一窗让模型标注说话人,窗口之间带上「上一行是谁」。返回带说话人编号的分段。
    static func inferSpeakers(segments: [TranscriptSegment], groupId: String?,
                              progress: (Int, Int) -> Void) async throws -> [TranscriptSegment] {
        guard !segments.isEmpty else { throw GenerateError.emptyTranscript }
        guard let model = resolveModel(groupId: groupId) else { throw GenerateError.noModel }
        let window = 120
        let windows = stride(from: 0, to: segments.count, by: window).map { $0..<min($0 + window, segments.count) }
        var assignments: [Int: Int] = [:]
        var previous: Int?
        let started = Date()
        for (i, range) in windows.enumerated() {
            try Task.checkCancellation()
            progress(i, windows.count)
            let lines = TranscriptAssembler.numberedLines(segments, range: range)
            let reply = try await complete(system: MinutesPromptBuilder.speakerSystemPrompt,
                                           user: MinutesPromptBuilder.speakerUserPrompt(lines: lines, previousSpeaker: previous),
                                           entry: model.entry, maxTokens: 4_096)
            let parsed = TranscriptAssembler.parseSpeakerAssignments(reply, validLines: (range.lowerBound + 1)...range.upperBound)
            assignments.merge(parsed) { _, new in new }
            if let last = parsed.keys.max() { previous = parsed[last] }
        }
        progress(windows.count, windows.count)
        LeoPerf.record("rec.speakers", ms: Date().timeIntervalSince(started) * 1000,
                       extra: ["lines": segments.count, "windows": windows.count, "assigned": assignments.count])
        return TranscriptAssembler.applySpeakerAssignments(segments, assignments: assignments)
    }

    // MARK: - Minutes

    struct Started {
        let sessionId: String
        let runId: String?
    }

    /// 生成纪要:必要时先分段提炼,再建对话发出最终一轮。返回新对话。
    static func generate(meta: RecordingMetadata, transcript: RecordingTranscript, template: MinutesTemplate,
                         customInstruction: String?, groupId: String?,
                         progress: (String) -> Void) async throws -> Started {
        guard !transcript.segments.isEmpty else { throw GenerateError.emptyTranscript }
        guard let model = resolveModel(groupId: groupId) else { throw GenerateError.noModel }
        let started = Date()
        let lines = TranscriptAssembler.compactLines(transcript.segments, names: meta.speakerNames)
            .map(MinutesPromptBuilder.neutralizeTags)
        let plan = MinutesPromptBuilder.plan(lines: lines, contextTokens: model.entry.model.contextWindow)
        let title = meta.displayTitle
        let durationText = TranscriptAssembler.timestamp(meta.duration)
        let hasSpeakers = transcript.segments.contains { $0.speaker != nil }

        var contextBody = lines.joined(separator: "\n")
        var isPartNotes = false
        if let parts = plan.parts, parts.count > 1 {
            isPartNotes = true
            var notes: [String] = []
            for (i, part) in parts.enumerated() {
                try Task.checkCancellation()
                progress(String(localized: "正在分段整理 \(i + 1)/\(parts.count)"))
                let note = try await complete(system: MinutesPromptBuilder.mapSystemPrompt,
                                              user: MinutesPromptBuilder.mapUserPrompt(part: i + 1, of: parts.count, title: title, text: part),
                                              entry: model.entry, maxTokens: MinutesPromptBuilder.partNotesMaxTokens)
                notes.append("## 第 \(i + 1)/\(parts.count) 部分\n" + MinutesPromptBuilder.neutralizeTags(note))
            }
            contextBody = notes.joined(separator: "\n\n")
        }
        progress(String(localized: "正在创建对话…"))

        let transcriptMarkdown = TranscriptAssembler.renderMarkdown(
            title: title, date: meta.createdAt, duration: meta.duration, segments: transcript.segments,
            names: meta.speakerNames, speakersInferred: meta.speakersInferred, highlights: meta.highlights)
        let context = MinutesPromptBuilder.transcriptContext(title: title, durationText: durationText, body: contextBody,
                                                             isPartNotes: isPartNotes, speakersInferred: meta.speakersInferred)
        let prompt = MinutesPromptBuilder.finalPrompt(template: template, title: title, customInstruction: customInstruction,
                                                      isPartNotes: isPartNotes, hasSpeakerLabels: hasSpeakers)

        // 新对话:和快捷指令一样无界面创建,绑定选中的模型分组。
        let vm = ViewModelCache.shared.createDraft()
        vm.sessionSource = "recording"
        vm.initialGroupId = model.groupId
        let onScreen = AIChatViewModel.activeSessionId
        let sid = await vm.ensureSessionReturningId()
        AIChatViewModel.activeSessionId = onScreen
        await ChatStore.shared.updateSessionTitle(sid, title: "\(template.displayName) · \(title)", category: "productivity")

        // 转写来自录音,是不可信资料:这一轮不允许发信、删除、远程执行之类有副作用的工具。
        vm.blocksSideEffectTools = true
        let tracker = SessionActivityTracker.shared
        let runId: String? = vm.withComposerSetAside {
            vm.addDataAttachment(data: Data(transcriptMarkdown.utf8),
                                 fileName: MinutesExport.fileName("录音转写-\(title)", ext: "md"))
            vm.inputText = prompt
            vm.pendingTreasuryContext = context
            tracker.setActive(sid, source: "Recording.minutes")
            let runId = tracker.currentRunId(for: sid)
            vm.send()
            return runId
        }
        guard vm.isProcessing || vm.isCompacting || vm.compactAndSendRequestId != nil else {
            vm.blocksSideEffectTools = false
            tracker.setInactive(sid, finalPhase: .failed, reason: .providerFailure, source: "Recording.notStarted")
            throw GenerateError.notStarted
        }
        LeoPerf.record("rec.minutes.dispatch", ms: Date().timeIntervalSince(started) * 1000,
                       extra: ["template": template.rawValue, "lines": lines.count, "parts": plan.parts?.count ?? 1])
        logger.info("[Recording] minutes dispatched template=\(template.rawValue) lines=\(lines.count) parts=\(plan.parts?.count ?? 1)")
        return Started(sessionId: sid, runId: runId)
    }

    /// 生成结束后的结果文字;还在跑返回 nil。结束时解除这一轮的工具限制。
    static func result(for output: RecordingOutput) async -> (finished: Bool, text: String?) {
        if let runId = output.runId {
            let outcome = AgentRunOutcome(state: AgentActivityLog.shared.runState(runId: runId), expectedRunId: runId)
            if outcome.shouldKeepObserving { return (false, nil) }
            releaseToolLimit(sessionId: output.sessionId)
            let text = await AgentRunResultReader.text(sessionId: output.sessionId, runId: runId)
            if !text.isEmpty { return (true, text) }
        }
        if let vm = ViewModelCache.shared.get(for: output.sessionId), vm.isProcessing { return (false, nil) }
        releaseToolLimit(sessionId: output.sessionId)
        // 兜底:对话里最后一条助手消息。
        let messages = await ChatStore.shared.loadMessages(sessionId: output.sessionId)
        let last = messages.last { $0.role == .assistant }
        let text = last?.parts.compactMap { part -> String? in
            if case .text(let t) = part { return t }
            return nil
        }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return (true, (text?.isEmpty == false) ? text : nil)
    }

    private static func releaseToolLimit(sessionId: String) {
        if let vm = ViewModelCache.shared.get(for: sessionId), !vm.isProcessing {
            vm.blocksSideEffectTools = false
        }
    }

    // MARK: - Actions on a result

    /// 收进藏宝阁:一条笔记,正文是纪要。
    static func saveToTreasury(title: String, markdown: String) async -> Bool {
        var note = CollectedItem.newNote(title: title)
        note.value = String(markdown.prefix(200))
        note.tags = ["录音纪要"]
        if let file = note.bodyFile {
            guard await NoteBodyStore.save(markdown, to: file) else { return false }
        }
        CollectionStore.add([note])
        await CollectionSearchIndex.shared.index(itemId: note.id, title: note.title ?? "", body: markdown)
        return true
    }

    /// 待办 → 提醒事项。返回成功建了几条;没有权限返回 nil。
    static func createReminders(_ items: [MinutesActionItem], recordingTitle: String) async -> Int? {
        let store = EKEventStore()
        let granted = (try? await store.requestFullAccessToReminders()) ?? false
        guard granted else { return nil }
        var created = 0
        for item in items {
            let reminder = EKReminder(eventStore: store)
            reminder.title = item.title
            var notes: [String] = [String(localized: "来自录音「\(recordingTitle)」")]
            if let owner = item.owner { notes.append(String(localized: "负责人:\(owner)")) }
            if let due = item.due { notes.append(String(localized: "期限:\(due)")) }
            reminder.notes = notes.joined(separator: "\n")
            if let due = item.due, let date = MinutesActionItemParser.dueDate(from: due) {
                reminder.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: date)
            }
            reminder.calendar = store.defaultCalendarForNewReminders()
            do {
                try store.save(reminder, commit: false)
                created += 1
            } catch {
                logger.error("[Recording] reminder save failed: \(error.localizedDescription)")
            }
        }
        do { try store.commit() } catch {
            logger.error("[Recording] reminder commit failed: \(error.localizedDescription)")
            return 0
        }
        return created
    }

    /// 导出成临时文件(交给系统分享面板)。
    static func exportFile(markdown: String, title: String, pdf: Bool) -> URL? {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("minutes-export", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(MinutesExport.fileName(title, ext: pdf ? "pdf" : "md"))
        try? FileManager.default.removeItem(at: url)
        if !pdf {
            return (try? Data(markdown.utf8).write(to: url)) != nil ? url : nil
        }
        let formatter = UIMarkupTextPrintFormatter(markupText: MinutesExport.html(fromMarkdown: markdown, title: title))
        let renderer = A4PageRenderer()
        renderer.addPrintFormatter(formatter, startingAtPageAt: 0)
        let data = NSMutableData()
        UIGraphicsBeginPDFContextToData(data, A4PageRenderer.paper, nil)
        renderer.prepare(forDrawingPages: NSRange(location: 0, length: renderer.numberOfPages))
        for page in 0..<renderer.numberOfPages {
            UIGraphicsBeginPDFPage()
            renderer.drawPage(at: page, in: UIGraphicsGetPDFContextBounds())
        }
        UIGraphicsEndPDFContext()
        return data.write(to: url, atomically: true) ? url : nil
    }

    private final class A4PageRenderer: UIPrintPageRenderer {
        static let paper = CGRect(x: 0, y: 0, width: 595.2, height: 841.8)
        override var paperRect: CGRect { Self.paper }
        override var printableRect: CGRect { Self.paper.insetBy(dx: 48, dy: 54) }
    }
}
