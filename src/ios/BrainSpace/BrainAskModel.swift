//
//  BrainAskModel.swift
//  LeoPhoneAgent
//
//  [brain-space] 「问」页的请求与轮询所有者(只在内存,不落盘)。
//  · 服务端异步 /api/ask 只接 question / mode / file_ids(history 只有流式接口才收),所以「接着问」
//    把同一资料范围里本页前几轮问答折进 question:总长按 Unicode 码点 ≤ 3000,当前问题原样保留、
//    绝不截断;上文明确标注只用于理解指代、不作事实依据。界面显示用户原问题,可展开看实际发送内容。
//  · 每个回合由一个任务负责提交与轮询;停止等待只停本机轮询(服务器可能仍在生成);
//    隐藏、换连接后旧任务的回写一律丢弃。网络暂态有限退避,401/403 等立即停,不无休止轮询。
//

import Combine
import Foundation

/// The follow-up context wrapper. Shared by sending and by reading history back (so stored questions are recognisable).
enum BrainAskContext {
    static let limit = 3000
    static let header = "【上文,仅用于理解指代,不作为事实依据】"
    static let marker = "【当前问题】"
    private static let perQuestion = 200
    private static let perAnswer = 600

    struct Prior { let question: String; let answer: String }

    static func length(_ s: String) -> Int { s.unicodeScalars.count }

    /// Folded to one line so a prior block can never contain the marker line.
    private static func oneLine(_ s: String) -> String {
        s.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: " ")
    }

    private static func clip(_ s: String, _ n: Int) -> String {
        let scalars = s.unicodeScalars
        guard scalars.count > n else { return s }
        var out = String.UnicodeScalarView(scalars.prefix(max(0, n - 1)))
        out.append("…")
        return String(out)
    }

    /// nil: the question alone is over the limit (never truncated). Otherwise the text to send and how many prior turns fit;
    /// the newest prior turns are kept first, older ones dropped when the budget runs out.
    static func compose(_ question: String, prior: [Prior]) -> (text: String, used: Int)? {
        guard length(question) <= limit else { return nil }
        guard !prior.isEmpty else { return (question, 0) }
        var budget = limit - (length(header) + 1 + length(marker) + 1 + length(question))
        var blocks: [String] = []
        for p in prior.reversed() {
            let block = "问:" + clip(oneLine(p.question), perQuestion) + "\n答:" + clip(oneLine(p.answer), perAnswer) + "\n"
            guard length(block) <= budget else { break }
            budget -= length(block)
            blocks.insert(block, at: 0)
        }
        guard !blocks.isEmpty else { return (question, 0) }
        return (header + "\n" + blocks.joined() + marker + "\n" + question, blocks.count)
    }

    /// A stored question (history, today) → the user's own question and whether it carried context.
    static func parse(_ raw: String) -> (question: String, hasContext: Bool) {
        guard raw.hasPrefix(header + "\n"), let r = raw.range(of: "\n" + marker + "\n") else { return (raw, false) }
        return (String(raw[r.upperBound...]), true)
    }
}

@MainActor
final class BrainAskModel: ObservableObject {
    /// One connection snapshot: every closure uses the configuration captured when it was made.
    struct Client {
        var ask: @MainActor (_ question: String, _ fileIds: [String]) async throws -> String
        var answer: @MainActor (_ id: String) async throws -> BrainArchiveAnswer
        var history: @MainActor () async throws -> [BrainAnswerList.Item]
        var save: @MainActor (_ id: String, _ title: String) async throws -> Void
    }
    typealias Factory = @MainActor () throws -> Client

    enum Phase: Equatable {
        case submitting
        case waiting
        /// Page hidden while waiting; resumes on return.
        case paused
        /// The user stopped waiting locally. The server was not told and may still finish.
        case stopped
        case timedOut
        case completed
        /// `resumable`: an answer id exists, so retry means "wait again" instead of asking again.
        case failed(String, resumable: Bool)
    }

    struct Turn: Identifiable {
        let id = UUID()
        /// What the user typed; this is what the page shows.
        let question: String
        /// What /ask received (equal to `question` unless context was folded in).
        let sent: String
        let hasContext: Bool
        let fileIds: [String]
        let scopeEpoch: Int
        let fromHistory: Bool
        var answerId: String?
        var answer: BrainArchiveAnswer?
        var phase: Phase
        var saved = false
    }

    @Published private(set) var turns: [Turn] = []
    @Published private(set) var history: [BrainAnswerList.Item] = []
    @Published private(set) var fileIds: [String] = []
    @Published private(set) var followUp: UUID?
    @Published private(set) var composeError: String?
    @Published private(set) var savingId: UUID?
    @Published var draft = ""

    private let makeClient: Factory
    private var client: Client?
    private var revision: Int?
    private var visible = false
    /// Bumped whenever the asking scope changes; context never crosses epochs.
    private var scopeEpoch = 0
    private var tasks: [UUID: (token: UUID, task: Task<Void, Never>)] = [:]
    private var historyToken: UUID?

    private static let maxWait: TimeInterval = 240
    private static let pollInterval: UInt64 = 1_500_000_000
    private static let maxTransientFailures = 4

    init(makeClient: @escaping Factory) { self.makeClient = makeClient }

    /// Seeds wait for the page to be on screen; a hidden page never sends.
    var isVisible: Bool { visible }

    var followUpTurn: Turn? { followUp.flatMap { id in turns.first { $0.id == id } } }

    func canFollowUp(_ t: Turn) -> Bool {
        t.phase == .completed && !t.fromHistory && t.scopeEpoch == scopeEpoch && t.fileIds == fileIds
    }

    var draftLength: Int { BrainAskContext.length(draft.trimmingCharacters(in: .whitespacesAndNewlines)) }

    // MARK: Lifecycle

    func appear(revision newRevision: Int) {
        if newRevision != revision { reset(newRevision) }
        visible = true
        if history.isEmpty { loadHistory() }
        for t in turns where t.phase == .paused { if let id = t.answerId { startPoll(t.id, id) } }
    }

    func disappear() {
        visible = false
        historyToken = nil
        for (id, entry) in tasks {
            entry.task.cancel()
            update(id) { t in
                switch t.phase {
                case .waiting: t.phase = t.answerId == nil ? .failed("离开页面时提问还没确认送达,可以重试", resumable: false) : .paused
                case .submitting: t.phase = .failed("离开页面时提问还没确认送达,可以重试", resumable: false)
                default: break
                }
            }
        }
        tasks = [:]
    }

    func connectionChanged(to newRevision: Int) {
        guard newRevision != revision else { return }
        reset(newRevision)
        if visible { loadHistory() }
    }

    /// New connection: nothing asked through the old one (turns, scope, history, follow-up) stays.
    private func reset(_ newRevision: Int) {
        tasks.values.forEach { $0.task.cancel() }
        tasks = [:]
        historyToken = nil
        revision = newRevision
        client = nil
        turns = []; history = []; fileIds = []; followUp = nil; composeError = nil; savingId = nil
        draft = ""
        scopeEpoch &+= 1
    }

    private func currentClient() -> Client? {
        if let client { return client }
        do { let c = try makeClient(); client = c; return c } catch {
            composeError = error.localizedDescription
            return nil
        }
    }

    // MARK: Scope & follow-up

    /// From a seed (「问这份资料」): a new scope starts a new thread; earlier answers are never context for it.
    func setScope(_ ids: [String]) {
        guard ids != fileIds else { return }
        fileIds = ids
        scopeEpoch &+= 1
        followUp = nil
    }

    func clearScope() { setScope([]) }

    func startFollowUp(_ id: UUID) {
        guard let t = turns.first(where: { $0.id == id }), canFollowUp(t) else { followUp = nil; return }
        followUp = id
        composeError = nil
    }

    func cancelFollowUp() { followUp = nil }

    // MARK: Asking

    /// Returns false when nothing was sent (empty, over the limit, no connection); the draft is kept.
    @discardableResult
    func send(_ raw: String) -> Bool {
        composeError = nil
        let question = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty, visible else { return false }
        var prior: [BrainAskContext.Prior] = []
        if let anchor = followUp, let end = turns.firstIndex(where: { $0.id == anchor }) {
            prior = turns[...end].filter(canFollowUp).compactMap { t in
                t.answer?.result?.answer.map { BrainAskContext.Prior(question: t.question, answer: $0) }
            }
        }
        guard let composed = BrainAskContext.compose(question, prior: prior) else {
            composeError = "问题有 \(BrainAskContext.length(question)) 字,超过 \(BrainAskContext.limit) 字上限,请缩短后再发。"
            return false
        }
        guard currentClient() != nil else { return false }
        let turn = Turn(question: question, sent: composed.text, hasContext: composed.used > 0, fileIds: fileIds,
                        scopeEpoch: scopeEpoch, fromHistory: false, answerId: nil, answer: nil, phase: .submitting)
        turns.append(turn)
        followUp = nil
        if raw == draft { draft = "" }
        startSubmit(turn.id)
        return true
    }

    /// An answer from history or the Today page: show it and wait for its real status. Its scope is unknown,
    /// so it is never used as follow-up context.
    func openHistory(id answerId: String, question raw: String) {
        guard visible, currentClient() != nil else { return }
        let parsed = BrainAskContext.parse(raw)
        let turn = Turn(question: parsed.question, sent: raw, hasContext: parsed.hasContext, fileIds: [],
                        scopeEpoch: -1, fromHistory: true, answerId: answerId, answer: nil, phase: .waiting)
        turns.append(turn)
        startPoll(turn.id, answerId)
    }

    /// Stop waiting locally. Does not (and cannot) cancel generation on the server.
    func stop(_ id: UUID) {
        guard let entry = tasks.removeValue(forKey: id) else { return }
        entry.task.cancel()
        update(id) { t in
            if t.answerId == nil { t.phase = .failed("已停止。提问可能已经送达,稍后可在「最近问过」里查看", resumable: false) }
            else { t.phase = .stopped }
        }
    }

    func retry(_ id: UUID) {
        guard visible, tasks[id] == nil, let t = turns.first(where: { $0.id == id }) else { return }
        switch t.phase {
        case .stopped, .timedOut, .paused, .failed(_, resumable: true):
            if let answerId = t.answerId { startPoll(id, answerId) }
        case .failed(_, resumable: false):
            // A history answer's scope is unknown: re-asking could widen it. Only re-check its status.
            guard !t.fromHistory else { if let answerId = t.answerId { startPoll(id, answerId) }; return }
            // Ask again with exactly what this turn sent, in its own scope.
            update(id) { $0.answerId = nil; $0.answer = nil; $0.saved = false; $0.phase = .submitting }
            startSubmit(id)
        default:
            break
        }
    }

    /// Save as a knowledge-card draft (existing /answers/save contract). Returns a message to show, or nil if stale.
    func save(_ id: UUID) async -> String? {
        guard visible, savingId == nil, let t = turns.first(where: { $0.id == id }), let answerId = t.answerId,
              let client = currentClient(), let r = revision else { return nil }
        savingId = id
        defer { if savingId == id { savingId = nil } }
        do {
            try await client.save(answerId, String(t.question.prefix(80)))
            guard visible, r == revision else { return nil }
            update(id) { $0.saved = true }
            return "已保存为成果(知识卡草稿)"
        } catch {
            guard visible, r == revision, !(error is CancellationError) else { return nil }
            return error.localizedDescription
        }
    }

    // MARK: Tasks

    private func startSubmit(_ turnId: UUID) {
        guard let client = currentClient(), let t = turns.first(where: { $0.id == turnId }) else { return }
        let token = UUID()
        let sent = t.sent, ids = t.fileIds
        let task = Task { [weak self] in
            guard let self else { return }
            defer { self.finish(turnId, token) }
            do {
                let answerId = try await client.ask(sent, ids)
                guard self.isLive(turnId, token) else { return }
                self.update(turnId) { $0.answerId = answerId; $0.phase = .waiting }
                await self.poll(turnId, answerId, client, token)
            } catch {
                guard self.isLive(turnId, token), !(error is CancellationError) else { return }
                self.update(turnId) { $0.phase = .failed(error.localizedDescription, resumable: false) }
            }
        }
        tasks[turnId] = (token, task)
    }

    private func startPoll(_ turnId: UUID, _ answerId: String) {
        guard visible, let client = currentClient() else { return }
        tasks[turnId]?.task.cancel()
        let token = UUID()
        update(turnId) { $0.phase = .waiting }
        let task = Task { [weak self] in
            guard let self else { return }
            defer { self.finish(turnId, token) }
            await self.poll(turnId, answerId, client, token)
        }
        tasks[turnId] = (token, task)
    }

    /// Polls the real status only. Transient network trouble backs off a few times; anything else stops at once.
    private func poll(_ turnId: UUID, _ answerId: String, _ client: Client, _ token: UUID) async {
        let deadline = Date().addingTimeInterval(Self.maxWait)
        var transient = 0
        while isLive(turnId, token) {
            do {
                let a = try await client.answer(answerId)
                guard isLive(turnId, token) else { return }
                transient = 0
                switch a.status {
                case "completed":
                    if a.result?.answer?.isEmpty == false {
                        update(turnId) { $0.answer = a; $0.phase = .completed }
                    } else {
                        update(turnId) { $0.phase = .failed("服务器说已完成,但没有返回回答内容", resumable: false) }
                    }
                    return
                case "failed", "interrupted", "cancelled":
                    update(turnId) { $0.phase = .failed(a.error ?? "这次没答完,可以再问一次", resumable: false) }
                    return
                default:
                    break
                }
            } catch {
                guard isLive(turnId, token), !(error is CancellationError) else { return }
                guard Self.isTransient(error) else {
                    update(turnId) { $0.phase = .failed(error.localizedDescription, resumable: true) }
                    return
                }
                transient += 1
                guard transient < Self.maxTransientFailures else {
                    update(turnId) { $0.phase = .failed("网络不稳,已停止等待。可以稍后继续等待", resumable: true) }
                    return
                }
                do { try await Task.sleep(nanoseconds: UInt64(1 << transient) * 1_000_000_000) } catch { return }
                continue
            }
            guard Date() < deadline else {
                update(turnId) { $0.phase = .timedOut }
                return
            }
            do { try await Task.sleep(nanoseconds: Self.pollInterval) } catch { return }
        }
    }

    private static func isTransient(_ error: Error) -> Bool {
        if error is URLError { return true }
        if case .http(let code, _)? = error as? BrainSpaceError {
            return code == 0 || code == 408 || code == 429 || code >= 500
        }
        return false
    }

    private func loadHistory() {
        guard let client = currentClient(), let r = revision else { return }
        let token = UUID()
        historyToken = token
        Task { [weak self] in
            let items = (try? await client.history()) ?? []
            guard let self, self.historyToken == token, self.revision == r, self.visible else { return }
            self.history = items
        }
    }

    private func isLive(_ turnId: UUID, _ token: UUID) -> Bool {
        !Task.isCancelled && visible && tasks[turnId]?.token == token
    }

    private func finish(_ turnId: UUID, _ token: UUID) {
        guard tasks[turnId]?.token == token else { return }
        tasks[turnId] = nil
        // A cancellation thrown by the transport itself must not leave a spinner without an owning task.
        update(turnId) { turn in
            switch turn.phase {
            case .submitting:
                turn.phase = .failed("提问尚未确认送达,请先在「最近问过」里查看,避免重复提交", resumable: false)
            case .waiting:
                turn.phase = .stopped
            default:
                break
            }
        }
    }

    private func update(_ id: UUID, _ change: (inout Turn) -> Void) {
        guard let i = turns.firstIndex(where: { $0.id == id }) else { return }
        change(&turns[i])
    }
}
