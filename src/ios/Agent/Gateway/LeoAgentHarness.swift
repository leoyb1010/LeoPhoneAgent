//
//  LeoAgentHarness.swift
//  MinisApp
//
//  [T-leoagent-harness] Drive a real coding CLI on the Mac from the phone.
//
//  This is the half of LeoAgent that has no equivalent on the engine side: a
//  harness session is Claude Code / Codex / Grok actually working in a real
//  directory, steerable and approvable mid-run.
//
//  The protocol is ours, so it has the one property the engine's stream lacks:
//  every event carries a monotonic `seq` and the server keeps the log, so
//  `?after=N` replays what a dropped connection missed instead of losing it.
//  That is why this client reconnects by resuming rather than by polling.
//

import Foundation
import QuartzCore

struct HarnessSessionSummary: Sendable, Identifiable, Hashable {
    let id: String
    let harness: String
    let name: String
    let cwd: String
    let status: String
    let seq: Int
    let waitingForApproval: Bool
    /// 队首待审批(Siri「批准」与通知按钮按它寻址);无待审批为 nil。
    var pendingApprovalId: String? = nil
    var pendingApprovalCommand: String? = nil
    var windowLabel: String? = nil
    /// 任务标题(LeoPhoneAgent 任务有;同一个项目里的几个任务靠它区分)。
    var title: String? = nil
    /// 权限模式;旧版 Mac 不报(nil),会话页据此隐藏模式胶囊。
    var mode: HarnessMode? = nil

    /// 列表里显示的名字:有标题用标题,没有就用会话类型名。
    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        return name
    }
}

/// One event from a harness session. Same vocabulary as a gateway run, plus a
/// sequence number — the thing that makes the stream resumable.
struct HarnessEvent: Sendable {
    let seq: Int
    let event: GatewayEvent
    var journal: HarnessJournalStatus? = nil
    var durability: String? = nil
}

extension LeoAgentClient {

    // MARK: Discovery

    /// Which coding CLIs this Mac can actually run.
    ///
    /// The server only reports what it can locate on disk, so a CLI the user
    /// has not installed never appears as a choice that would fail on use.
    func harnessKinds() async throws -> [HarnessKind] {
        let obj = try await getJSON("/v1/capabilities", service: .harness)
        // [fix-remote] 以 Mac 为准，不过滤；记到主机上，对话框的「指挥 Mac」菜单也用这份。
        let kinds = HarnessCatalog.parse(obj["harnesses"] as? [[String: Any]] ?? [])
        if let hostId {
            await GatewayHostStore.shared.recordCapabilities(
                id: hostId, kinds: kinds, ssh: MacSSHTarget.parse(obj["ssh"]),
                hostKeys: (obj["ssh_host_keys"] as? [String] ?? []).compactMap(RemoteSSHTrust.normalizedPublicKey))
        }
        return kinds
    }

    func harnessSessions() async throws -> [HarnessSessionSummary] {
        let obj = try await getJSON("/harness/sessions", service: .harness)
        let rows = obj["sessions"] as? [[String: Any]] ?? []
        return rows.compactMap { row in
            guard let id = row["session_id"] as? String else { return nil }
            let pending = (row["pending_approvals"] as? [[String: Any]])?.first
            return HarnessSessionSummary(
                id: id,
                harness: row["harness"] as? String ?? "",
                name: row["name"] as? String ?? "",
                cwd: row["cwd"] as? String ?? "",
                status: row["status"] as? String ?? "unknown",
                seq: row["seq"] as? Int ?? 0,
                waitingForApproval: row["waiting_for_approval"] as? Bool ?? false,
                pendingApprovalId: pending?["approval_id"] as? String,
                pendingApprovalCommand: pending?["command"] as? String,
                windowLabel: {
                    guard let window = row["window"] as? [String: Any] else { return nil }
                    let app = window["app"] as? String ?? ""
                    let title = window["title"] as? String ?? ""
                    let parts = [app, title].filter { !$0.isEmpty }
                    return parts.isEmpty ? nil : parts.joined(separator: " · ")
                }(),
                title: (row["title"] as? String).flatMap { $0.isEmpty ? nil : $0 },
                mode: HarnessMode.parse(row["mode"]))
        }
    }

    // MARK: Control

    /// `fullAuto`:让 Mac 用全自动(免审批)跑这个任务。[A2] 对所有 CLI 生效(Claude Code / Codex /
    /// Grok / LeoPhoneAgent);Mac 只接受认得出的 iPhone 发来的,不接受时返回 403 和原因与修复步骤。
    /// `mode`:新版 Mac 按它定权限模式(优先于 full_auto);旧版 Mac 不认这个字段,照 full_auto 走。
    func createHarnessSession(harness: String, cwd: String, prompt: String?, thinking: String? = nil,
                              fullAuto: Bool = false, mode: HarnessMode? = nil,
                              phoneSessionId: String? = nil) async throws -> String {
        var payload = HarnessFullAuto.createPayload(harness: harness, cwd: cwd, prompt: prompt,
                                                    thinking: thinking, fullAuto: fullAuto,
                                                    phoneSessionId: phoneSessionId)
        if let mode { payload["mode"] = mode.rawValue }
        let sentAt = CACurrentMediaTime()
        let obj = try await postJSON("/harness/sessions", body: payload, service: .harness)
        guard let id = obj["session_id"] as? String else {
            throw GatewayError.malformedResponse("missing session_id")
        }
        LeoPerf.macSendBegan(id, at: sentAt)
        LeoPerf.macAck(id)
        return id
    }

    /// `fullAuto` 非 nil 时,Mac 按它把这个任务切到全自动或切回「先问我」(接着聊的老任务也跟着开关走)。
    ///
    /// [T-relay-outbox] Mac 不在线时中继替它排队(`X-Leo-Queue`),上线即按顺序投递;
    /// `X-Leo-Request-Id` 让重试不会投递两次。返回 true = 已排队、还没到 Mac。
    @discardableResult
    func steerHarness(sessionId: String, text: String, fullAuto: Bool? = nil,
                      requestId: String = UUID().uuidString, phoneSessionId: String? = nil) async throws -> Bool {
        LeoPerf.macSendBegan(sessionId)
        var body: [String: Any] = ["text": text]
        if let fullAuto { body["full_auto"] = fullAuto }
        if let phone = HarnessFullAuto.phoneSessionValue(phoneSessionId) { body["phone_session_id"] = phone }
        let obj = try await postJSON("/harness/sessions/\(sessionId)/send", body: body, service: .harness,
                                     headers: ["X-Leo-Queue": "1", "X-Leo-Request-Id": requestId])
        let queued = (obj["queued"] as? Bool) == true
        if !queued { LeoPerf.macAck(sessionId) }
        return queued
    }

    /// 手机关掉全自动:这台 Mac 上由本机发起、还在全自动跑的任务切回「先问我」。
    func turnOffFullAuto() async throws {
        _ = try await postJSON("/harness/full-auto", body: ["enabled": false], service: .harness)
    }

    /// `approvalId` is the server's own id for the request. Without it the
    /// server can only fall back to "the one pending approval" — and 409s the
    /// moment a CLI raises two at once.
    func approveHarness(sessionId: String, choice: String, approvalId: String?) async throws {
        var body: [String: Any] = ["choice": choice]
        if let approvalId { body["approval_id"] = approvalId }
        _ = try await postJSON("/harness/sessions/\(sessionId)/approval", body: body,
                               service: .harness)
    }

    func stopHarness(sessionId: String) async throws {
        _ = try await postJSON("/harness/sessions/\(sessionId)/stop", body: [:],
                               service: .harness)
    }

    /// 手机「清理」:请 Mac 把这个任务从手机的列表里拿掉(Mac 上的对话不动;还在跑的 Mac 回 409)。
    /// Mac 1.3.1 起才有这条路,老版本 404 —— 调用方那时只在本机藏起来。
    func archiveHarness(sessionId: String) async throws {
        _ = try await postJSON("/harness/sessions/\(sessionId)/archive", body: [:],
                               service: .harness)
    }

    // MARK: Resumable stream

    /// Events from `after` onwards: replay first, then follow live.
    ///
    /// Passing the last seq you rendered is what makes a reconnect lossless —
    /// the caller never has to reason about what it might have missed.
    nonisolated func harnessEvents(sessionId: String, after: Int) -> AsyncThrowingStream<HarnessEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                await self.pumpHarness(sessionId: sessionId, after: after, into: continuation)
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func pumpHarness(
        sessionId: String,
        after: Int,
        into continuation: AsyncThrowingStream<HarnessEvent, Error>.Continuation
    ) async {
        var viaDirect = false
        do {
            var req = try request("/harness/sessions/\(sessionId)/events?after=\(after)&journal_status=1",
                                  service: .harness)
            req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            req.timeoutInterval = 3600
            let (lines, response) = try await routedLines(for: req)
            viaDirect = response.url?.host != req.url?.host
            guard let http = response as? HTTPURLResponse else {
                throw GatewayError.malformedResponse("not an HTTP response")
            }
            guard (200..<300).contains(http.statusCode) else {
                if http.statusCode == 401 || http.statusCode == 403 { throw GatewayError.unauthorized }
                if http.statusCode == 410 {
                    var raw = ""
                    for try await line in lines { raw += line }
                    throw GatewayError.resumeGap(minAfter: T6RelayLogic.minAfter(from: raw) ?? 0)
                }
                throw GatewayError.http(status: http.statusCode, message: nil)
            }
            for try await line in lines {
                if Task.isCancelled { break }
                guard line.hasPrefix("data:") else { continue }
                let raw = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                guard !raw.isEmpty,
                      let data = raw.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                else { continue }
                if let resume = T6RelayLogic.parseResume(obj) {
                    if resume.isGap {
                        throw GatewayError.resumeGap(minAfter: resume.minAfter)
                    }
                    continue
                }
                if obj["type"] as? String == "durability" {
                    continuation.yield(HarnessEvent(seq: 0, event: .unknown(name: "journal.status", payload: [:]),
                        journal: HarnessJournalStatus.parse(obj) ?? HarnessJournalStatus()))
                    continue
                }
                if obj["event"] as? String == "message.delta" { LeoPerf.macDelta(sessionId) }
                continuation.yield(HarnessEvent(
                    seq: obj["seq"] as? Int ?? 0,
                    event: GatewayEvent.parse(obj), durability: obj["durability"] as? String))
            }
            continuation.finish()
        } catch {
            // Only a dropped direct stream says anything about the direct route;
            // leaving the chat cancels the stream and is not a failure.
            if viaDirect, let urlError = error as? URLError, urlError.code != .cancelled, !Task.isCancelled {
                await directFailed()
            }
            continuation.finish(throwing: error)
        }
    }
}

// MARK: - Driver

/// Drives one harness session. Structurally close to `GatewayRunDriver`, with
/// one important difference: recovery resumes the stream at the last seq
/// instead of falling back to status polling, because this protocol can.
@MainActor
final class HarnessSessionDriver: ObservableObject {
    @Published private(set) var items: [GatewayTranscriptItem] = []
    // The Mac card on the Lock Screen follows both (it used to change only on
    // approvals, and kept saying "running" for a finished task).
    @Published private(set) var isRunning = false {
        didSet { if isRunning != oldValue { HarnessLiveActivityBridge.shared.refresh() } }
    }
    @Published private(set) var status = "idle" {
        didSet { if status != oldValue { HarnessLiveActivityBridge.shared.refresh() } }
    }
    /// A queue, not a slot: a CLI can raise a second approval before the
    /// first is answered, and a single slot silently dropped the first one —
    /// unanswerable from any surface, CLI blocked forever.
    @Published private(set) var pendingApprovals: [GatewayApprovalRequest] = []
    @Published private(set) var lastError: String?
    /// [T-link-problem] 连接类失败的结构化说明:谁的问题 + 一个主按钮。控制台优先显示它,
    /// 没有才退回 lastError 的文字。要用户处理的问题还会让自动重连停下(见 follow)。
    @Published private(set) var problem: LeoLinkProblem?
    /// A follow-up that never reached the Mac; the console puts it back in its input.
    @Published var unsentText: String?
    /// [fix-remote] 上一轮因为 Mac 上的 agent 没登录而失败：控制台给「去登录」。
    @Published private(set) var needsAgentLogin = false

    func clearAgentLoginSuggestion() { needsAgentLogin = false }
    /// How the last turn ended; "idle" alone can't tell a finished turn from a failed one.
    private(set) var lastTurnFailed = false

    /// The typing row's words; `status` is the wire value ("running", …).
    var statusLabel: String {
        switch status {
        case "starting": AppLocalized("正在连接 Mac…")
        case "waiting_for_approval": AppLocalized("等你审批")
        default: AppLocalized("Mac 正在处理…")
        }
    }
    @Published private(set) var resumeCount = 0
    @Published private(set) var journalStatus = HarnessJournalStatus()

    /// The one the UI shows; the rest wait their turn behind it.
    var pendingApproval: GatewayApprovalRequest? { pendingApprovals.first }

    let harness: HarnessKind
    let cwd: String
    /// var:重新配对 / 改地址后宿主会换新的 client,resumeAfterProblem 据此换上(旧的还带着旧密钥)。
    private var client: LeoAgentClient
    private(set) var sessionId: String?
    private var lastSeq = 0
    private var streamTask: Task<Void, Never>?
    /// Kept so a session abandoned before it existed can be re-created.
    private var firstPrompt: String?

    /// [E5] 从哪个手机对话派出来的(没有 = 不是从对话派的)。建任务和后续消息都带上,完成推送据此回到那个对话。
    let phoneSessionId: String?

    init(client: LeoAgentClient, harness: HarnessKind, cwd: String, phoneSessionId: String? = nil) {
        self.client = client
        self.harness = harness
        self.cwd = cwd
        self.phoneSessionId = phoneSessionId
        mode = HarnessMode.fallback(fullAutoOn: FullAutoGate.isOn)
        modeSupport = Self.cachedSupport(Self.modeSupportKey, hostId: client.hostId)
        changesSupport = Self.cachedSupport(Self.changesSupportKey, hostId: client.hostId)
    }

    /// [T-composer-send-dead] 会话建立期间(经中继 1~3 秒)用户就开始发送;SSH 兜底一轮在跑时也一样。
    /// 排队而不是拒绝:sessionId 一到就依序发出,兜底这一轮跑完再跑下一条。点击永远有响应,也不会并发两轮。
    private var turns = PendingTurns()

    /// 最近一条发给 Mac 的话(「重试上一条」用)。
    @Published private(set) var lastUserText: String?

    // MARK: 权限模式 / 改动面板(Leo Link 新路由)

    /// 当前权限模式。没选过时沿用全自动开关(开 → 全自动,关 → 自主)。
    @Published private(set) var mode: HarnessMode
    /// 这台 Mac 支不支持模式切换:nil = 还不知道(先显示胶囊,建好会话后问一次),false = 旧版 Mac(隐藏,退回全自动开关)。
    @Published private(set) var modeSupport: Bool?
    /// 工作区改动;nil = 还没拿到。
    @Published private(set) var changes: HarnessChanges?
    /// 这台 Mac 有没有改动面板的路由:false = 旧版 Mac(隐藏「改动」按钮)。
    @Published private(set) var changesSupport: Bool?

    var showsModePicker: Bool { modeSupport != false }
    var showsChanges: Bool { changesSupport == true && sessionId != nil }

    /// 先计划模式下这一轮交出了计划:给「按计划执行」。
    var offersExecutePlan: Bool {
        mode == .plan && modeSupport == true && sessionId != nil && status == "idle" && !lastTurnFailed
    }

    private static let modeSupportKey = "leo.harness.modeSupport"
    private static let changesSupportKey = "leo.harness.changesSupport"

    /// 按主机记住新路由支不支持(下次打开控制台不用先闪一下再藏起来)。
    private static func cachedSupport(_ key: String, hostId: String?) -> Bool? {
        guard let hostId else { return nil }
        return (UserDefaults.standard.dictionary(forKey: key) as? [String: Bool])?[hostId]
    }

    private func recordSupport(_ key: String, _ value: Bool) {
        if key == Self.modeSupportKey { modeSupport = value } else { changesSupport = value }
        guard let hostId = client.hostId else { return }
        var all = (UserDefaults.standard.dictionary(forKey: key) as? [String: Bool]) ?? [:]
        guard all[hostId] != value else { return }
        all[hostId] = value
        UserDefaults.standard.set(all, forKey: key)
    }

    /// 切换权限模式。还没建会话时只记下,建会话时带上。返回是否生效。
    @discardableResult
    func setMode(_ newMode: HarnessMode) async -> Bool {
        guard newMode != mode else { return true }
        guard let sessionId else { mode = newMode; return true }
        let previous = mode
        mode = newMode
        do {
            mode = try await client.setHarnessMode(sessionId: sessionId, mode: newMode)
            recordSupport(Self.modeSupportKey, true)
            return true
        } catch {
            mode = previous
            if LeoAgentClient.isNotFound(error) {
                recordSupport(Self.modeSupportKey, false)
                note(AppLocalized("这台 Mac 上的 LeoBot 还不支持切换权限模式，已回到全自动开关；更新 Mac 端后再试。"))
            } else if case GatewayError.http(403, let message) = error, newMode == .yolo {
                fullAutoRefused = true
                note(HarnessFullAuto.refusedNote(serverMessage: message))
            } else {
                note(AppLocalized("切换模式没成功：") + LeoAgentClient.describeHarnessFeatureError(error))
            }
            return false
        }
    }

    /// 先计划 → 按计划执行:切到自主(全自动开着就全自动),再发「执行」。
    func executePlan() {
        Task {
            let target = HarnessMode.afterPlan(fullAutoOn: FullAutoGate.isOn && !fullAutoRefused)
            if await setMode(target) { steer("执行") }
        }
    }

    /// 拉一次改动列表;404 = 旧版 Mac,藏起入口。其它失败保留上次的结果。
    func refreshChanges() async {
        guard let sessionId, changesSupport != false else { return }
        do {
            changes = try await client.harnessChanges(sessionId: sessionId)
            recordSupport(Self.changesSupportKey, true)
        } catch where LeoAgentClient.isNotFound(error) {
            recordSupport(Self.changesSupportKey, false)
            changes = nil
        } catch {}
    }

    func fileDiff(path: String, checkpoint: String? = nil) async throws -> HarnessFileDiff {
        guard let sessionId else { throw GatewayError.notConfigured }
        return try await client.harnessDiff(sessionId: sessionId, path: path, checkpoint: checkpoint)
    }

    /// 回滚(会删改文件,界面先确认一次)。成功后刷新改动并在时间线记一笔。
    func revert(checkpoint: HarnessCheckpoint?, paths: [String] = []) async throws {
        guard let sessionId else { throw GatewayError.notConfigured }
        let reverted = try await client.revertHarness(sessionId: sessionId, checkpoint: checkpoint?.id, paths: paths)
        if let checkpoint {
            note(AppLocalized("已回到第 \(checkpoint.turn) 轮之前（\(reverted.count) 个文件）。"))
        } else {
            note(AppLocalized("已撤销 \(paths.joined(separator: "、")) 的改动。"))
        }
        await refreshChanges()
    }

    /// 会话建好 / 接上之后问一次:模式支不支持(摘要里有没有 mode)、改动有多少。
    private func probeSessionFeatures(_ id: String) {
        Task { [weak self] in
            guard let self else { return }
            if let summary = try? await self.client.harnessSessions().first(where: { $0.id == id }) {
                self.recordSupport(Self.modeSupportKey, summary.mode != nil)
                if let mode = summary.mode { self.mode = mode }
            }
            await self.refreshChanges()
        }
    }

    // MARK: 正文增量合并

    private var deltaBuffer = TextDeltaBuffer()
    private var deltaFlushTask: Task<Void, Never>?

    /// 攒 ~33ms(两帧)再写进 items:每个 token 都发一次 objectWillChange 会让整页每秒重排几十次。
    private func bufferDelta(_ delta: String) {
        guard deltaBuffer.append(delta) else { return }
        deltaFlushTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(33))
            guard !Task.isCancelled else { return }
            self?.flushDeltas()
        }
    }

    private func flushDeltas() {
        deltaFlushTask?.cancel()
        deltaFlushTask = nil
        guard let text = deltaBuffer.take() else { return }
        if let index = items.indices.last, case .assistantText = items[index].kind {
            items[index].text += text
        } else {
            items.append(GatewayTranscriptItem(kind: .assistantText, text: text))
        }
    }

    /// 任何非正文的一行进来前,先把攒着的正文写进去,先后顺序不乱。
    private func append(_ item: GatewayTranscriptItem) {
        flushDeltas()
        items.append(item)
    }

    /// 工具结束:按 tool_use_id 配对(同名工具并行时按名字会配错),没有 id 再按名字找最近一条还在跑的。
    private func finishTool(id: String?, name: String?, isError: Bool, duration: Double?, output: String?) {
        flushDeltas()
        let byId = id.flatMap { id in items.lastIndex { $0.toolUseId == id } }
        let index = byId ?? items.lastIndex {
            if case .tool(let n, let running, _, _) = $0.kind { return running && (name == nil || n == name) }
            return false
        }
        guard let index, case .tool(let toolName, _, _, _) = items[index].kind else { return }
        items[index].kind = .tool(name: toolName, isRunning: false, isError: isError, duration: duration)
        if let output, !output.isEmpty { items[index].output = output }
    }

    /// 停下 / 断开时还在转圈的工具行收住,不再假装在跑。
    private func settleRunningTools() {
        for index in items.indices {
            if case .tool(let name, true, let isError, let duration) = items[index].kind {
                items[index].kind = .tool(name: name, isRunning: false, isError: isError, duration: duration)
            }
        }
    }

    // MARK: SSH 兜底

    /// 兜底这一轮跑在自己的任务里:离开页面只取消跟随事件流的 streamTask,不掐断它。
    private var sshTask: Task<Void, Never>?
    /// claude / codex 上一轮报的会话号:下一轮 `--resume` / `exec resume` 接着这个上下文。
    private var sshResumeId: String?
    private var sshNoticeShown = false
    /// 这个控制台跑过 SSH 兜底(首页据此在兜底跑完一轮后也清掉草稿)。
    @Published private(set) var viaSSH = false

    func start(prompt: String, thinking: String? = nil) {
        guard sessionId == nil, !isRunning else { return }
        problem = nil
        firstPrompt = prompt
        lastUserText = prompt
        turns.begin()
        isRunning = true
        status = "starting"
        let fullAuto = wantsFullAuto
        // 旧版 Mac 不认 mode,照 full_auto 走;新版 mode 优先。
        let createMode: HarnessMode? = modeSupport == false ? nil : mode
        streamTask = Task { [weak self] in
            guard let self else { return }
            do {
                let id: String
                do {
                    id = try await self.client.createHarnessSession(
                        harness: self.harness.key, cwd: self.cwd, prompt: prompt,
                        thinking: thinking, fullAuto: fullAuto, mode: createMode, phoneSessionId: self.phoneSessionId)
                } catch GatewayError.http(let status, let message)
                            where HarnessFullAuto.isRefusal(status: status, harnessKey: self.harness.key,
                                                            requestedFullAuto: fullAuto || createMode == .yolo) {
                    // Mac 还不接受这台手机开全自动(中继没认出 iPhone):照常开,逐项审批,并写明怎么修。
                    await MainActor.run {
                        self.fullAutoRefused = true
                        if self.mode == .yolo { self.mode = .guarded }
                        self.note(HarnessFullAuto.refusedNote(serverMessage: message, status: status))
                    }
                    id = try await self.client.createHarnessSession(
                        harness: self.harness.key, cwd: self.cwd, prompt: prompt, thinking: thinking,
                        mode: createMode == .yolo ? .guarded : createMode,
                        phoneSessionId: self.phoneSessionId)
                }
                // 建任务的路上你关掉了全自动:建好后立刻让 Mac 把它切回先问我。
                if fullAuto, !FullAutoGate.isOn {
                    try? await self.client.turnOffFullAuto()
                }
                await MainActor.run {
                    self.sessionId = id
                    self.restoreOutbox()
                    self.status = "running"
                    self.flushQueuedSteers(self.turns.drain())
                    HarnessLiveActivityBridge.shared.register(driver: self, hostName: self.client.hostName)
                    self.probeSessionFeatures(id)
                }
                await self.follow(sessionId: id)
            } catch {
                // 用户点了停止(stopLocalTurn 已收好状态)或离开页面(detach 已置 pending):不算失败。
                if Task.isCancelled { return }
                // [fix-remote] 直连与中继都连不上：能走 SSH 兜底就在 Mac 上直接跑这一轮。
                if MacSSHFallback.isRouteFailure(error), self.startSSHTurn(prompt: prompt) { return }
                await MainActor.run {
                    self.fail(error.localizedDescription)
                    self.status = "pending"   // recoverable: nothing was created
                    self.report(error)
                    // 建会话期间排队的几条没机会发了:退还给输入框,不静默丢掉。
                    let lost = self.turns.cancel()
                    if !lost.isEmpty { self.unsentText = lost.joined(separator: "\n\n") }
                }
            }
        }
    }

    private func appendSSHText(_ text: String) {
        flushDeltas()
        if let index = items.indices.last, case .assistantText = items[index].kind {
            items[index].text += (items[index].text.isEmpty ? "" : "\n") + text
        } else {
            items.append(GatewayTranscriptItem(kind: .assistantText, text: text))
        }
    }

    private func applySSH(_ event: SSHFallbackEvent) {
        switch event {
        case .text(let text):
            appendSSHText(text)
        case .toolStarted(let id, let name, let input):
            let preview = input.split(separator: "\n", maxSplits: 1).first.map { String($0.prefix(200)) } ?? ""
            append(GatewayTranscriptItem(kind: .tool(name: name, isRunning: true, isError: false, duration: nil),
                                         text: preview, toolUseId: id, detail: input.isEmpty ? nil : input))
        case .toolFinished(let id, let output, let isError):
            finishTool(id: id, name: nil, isError: isError, duration: nil, output: output)
        case .session(let id):
            sshResumeId = id
        }
    }

    /// [fix-remote] 开一轮 SSH 兜底。返回 false = 这台 Mac 走不了 SSH（原错误照常显示）。
    private func startSSHTurn(prompt: String) -> Bool {
        let (remote, reason) = MacSSHFallback.readiness(hostId: client.hostId, cliKey: harness.key)
        guard let remote, let hostId = client.hostId else {
            if let reason { note("SSH 兜底不可用：\(reason)") }
            return false
        }
        if !sshNoticeShown {
            sshNoticeShown = true
            note(MacSSHFallback.notice)
        }
        viaSSH = true
        isRunning = true
        status = "running"
        // 模式胶囊可用时按所选模式,否则按全自动开关。
        let fullAuto = modeSupport == true ? mode == .yolo : wantsFullAuto
        let resumeId = sshResumeId
        // 强引用 self:离开页面后这一轮照常跑完(驱动随它一起活到跑完)。
        sshTask = Task {
            await self.runSSHTurn(remote: remote, hostId: hostId, prompt: prompt, fullAuto: fullAuto, resumeId: resumeId)
        }
        return true
    }

    private func runSSHTurn(remote: RemoteHost, hostId: String, prompt: String, fullAuto: Bool, resumeId: String?) async {
        let failure = await MacSSHFallback.run(remote: remote, hostId: hostId, cliKey: harness.key, prompt: prompt, cwd: cwd,
                                               fullAuto: fullAuto, resumeId: resumeId) { [weak self] event in
            await self?.applySSH(event)
        }
        flushDeltas()
        sshTask = nil
        // 这一轮已经在 Mac 上跑过:清掉首条指令,状态回 idle。以前设回 pending,回到页面 resumeIfNeeded
        // 会把首条指令再跑一遍。下一条消息照常先试直连 / 中继，不通再走 SSH。
        firstPrompt = nil
        // 用户点了停止:stopLocalTurn 已收好状态。
        if Task.isCancelled { return }
        settleRunningTools()
        if let failure {
            append(GatewayTranscriptItem(kind: .failure, text: "SSH 兜底失败：\(failure)"))
            lastTurnFailed = true
        } else {
            lastTurnFailed = false
        }
        isRunning = false
        status = "idle"
        // 这一轮跑着时排队的消息:按顺序跑下一条。
        if let next = turns.turnEnded() { start(prompt: next) }
    }

    private func flushQueuedSteers(_ queued: [String]) {
        guard let sessionId, !queued.isEmpty else { return }
        Task {
            for text in queued {
                await self.sendSteer(sessionId: sessionId, text: text)
            }
        }
    }

    /// Mac 已经拒过这台手机的全自动(中继还认不出 iPhone):这个会话里不再请求,免得每条消息都提示一遍。
    /// [A3] 控制台据此显示「恢复全自动」按钮。
    @Published private(set) var fullAutoRefused = false

    /// [A2] 全自动对所有 Mac 任务生效(Claude Code / Codex / Grok / LeoPhoneAgent)。
    private var wantsFullAuto: Bool { HarnessFullAuto.wanted(gateOn: FullAutoGate.isOn, refused: fullAutoRefused) }

    /// [A3] 在 Mac 上处理完后一键恢复:下一条消息重新请 Mac 切到全自动(Mac 仍认不出会再次 403 并说明)。
    func retryFullAuto() {
        guard fullAutoRefused else { return }
        fullAutoRefused = false
        note(AppLocalized("已恢复全自动请求:下一条消息会请这台 Mac 切回全自动。"))
    }

    /// 发一条后续消息,顺带告诉 Mac 全自动开关的当前状态(所有 CLI 都带)。
    private func sendSteer(sessionId: String, text: String) async {
        // 支持模式切换的 Mac 由模式决定审批;再带 full_auto 会把用户选的模式顶掉。
        let fullAuto = modeSupport == true ? nil
            : HarnessFullAuto.steerValue(harnessKey: harness.key, gateOn: FullAutoGate.isOn, refused: fullAutoRefused)
        let entry: HarnessOutbox.Entry
        do {
            // 必须在网络调用前落盘；中继重启、手机杀进程或丢 ACK 都不丢原文。
            // 落盘带 fsync，放到后台线程，别让输入框卡一下。
            let scope = client.harnessOutboxScope
            let id = UUID().uuidString
            entry = try await Task.detached(priority: .userInitiated) {
                try HarnessOutbox.shared.record(id: id, scope: scope, sessionId: sessionId, text: text, fullAuto: fullAuto)
            }.value
        } catch {
            steerFailed(text, AppLocalized("无法保存待发送内容，本次没有发送；请检查本机存储空间。"))
            return
        }
        // On disk but still in flight: a concurrent restoreOutbox must not
        // announce it as uncertain or queue it twice.
        inFlightOutbox.insert(entry.id)
        defer { inFlightOutbox.remove(entry.id) }
        do {
            if try await client.steerHarness(sessionId: sessionId, text: entry.text,
                    fullAuto: entry.fullAuto, requestId: entry.id, phoneSessionId: phoneSessionId) {
                try await Task.detached { try HarnessOutbox.shared.markQueued(entry) }.value
                var queued = entry
                queued.state = .queued
                if !relayQueued.contains(where: { $0.id == entry.id }) { relayQueued.append(queued) }
                note(Self.queuedWhileOfflineNote)
                watchRelayQueue()
            } else {
                try finishOutbox(entry)
            }
        } catch let error where Self.neverLeftThisDevice(error) {
            // 请求根本没发出去(没网、地址不对、没授权):明确告知没送到，原文放回输入框。
            guard finishRejectedOutbox(entry) == true else { return }
            steerFailed(text, Self.describe(error), problem: LeoLinkProblem.from(error: error, context: linkContext))
        } catch GatewayError.http(let status, let message)
                    where HarnessFullAuto.isRefusal(status: status, harnessKey: harness.key, requestedFullAuto: fullAuto == true) {
            // 明确的拒绝才允许使用新编号降级重发，未知结果永不走此路径。
            guard finishRejectedOutbox(entry) == true else { return }
            fullAutoRefused = true
            note(HarnessFullAuto.refusedNote(serverMessage: message, status: status))
            await sendSteer(sessionId: sessionId, text: text)
        } catch GatewayError.http(let status, let message) where (400..<500).contains(status) && status != 409 && status != 408 {
            guard finishRejectedOutbox(entry) == true else { return }
            steerFailed(text, message ?? "HTTP \(status)",
                        problem: LeoLinkProblem.from(error: GatewayError.http(status: status, message: message),
                                                     context: linkContext))
        } catch {
            // timeout/5xx/409 都可能已经发生副作用；保留原编号，不放回可盲重发的输入框。
            if !relayQueued.contains(where: { $0.id == entry.id }) { relayQueued.append(entry) }
            showUncertain(entry)
            watchRelayQueue()
        }
    }

    /// Entries written to disk whose POST has not returned yet.
    private var inFlightOutbox = Set<String>()

    /// 这些错误发生在请求离开手机之前，Mac 不可能收到：按"没送到"处理，不是"结果未知"。
    private static func neverLeftThisDevice(_ error: Error) -> Bool {
        switch error {
        case GatewayError.unauthorized, GatewayError.harnessNotConfigured, GatewayError.notConfigured, GatewayError.badURL:
            return true
        case let urlError as URLError:
            return [.notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed,
                    .badURL, .unsupportedURL, .secureConnectionFailed, .serverCertificateUntrusted,
                    .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid,
                    .clientCertificateRejected, .internationalRoamingOff, .callIsActive, .dataNotAllowed,
                    .appTransportSecurityRequiresSecureConnection].contains(urlError.code)
        default:
            return false
        }
    }

    private static func describe(_ error: Error) -> String {
        if case GatewayError.unauthorized = error { return AppLocalized("这台 Mac 拒绝了本机的访问密钥，请在设备页面重新配对。") }
        if let urlError = error as? URLError, urlError.code == .notConnectedToInternet { return AppLocalized("手机当前没有网络。") }
        return error.localizedDescription
    }

    /// The Mac never got it: say so, stop claiming it's working, give the text back.
    private func steerFailed(_ text: String, _ reason: String, problem found: LeoLinkProblem? = nil) {
        lastError = reason
        if let found { adopt(found) }
        append(GatewayTranscriptItem(kind: .failure, text: AppLocalized("没送到 Mac：\(reason)")))
        if status == "running" { status = "idle" }
        unsentText = text
    }

    // MARK: [T-relay-outbox] follow-ups queued at the relay

    /// The relay answers "queued" at once and learns the Mac's answer only when
    /// it delivers, later. Without asking, a follow-up the Mac then refused
    /// (full auto from a sender it doesn't recognise, a finished session)
    /// vanished while the console said it would arrive.
    private var relayQueued: [HarnessOutbox.Entry] = []
    private var relayQueueWatch: Task<Void, Never>?
    private var announcedUncertain = Set<String>()

    private func restoreOutbox() {
        guard let sessionId else { return }
        let scope = client.harnessOutboxScope
        Task { @MainActor [weak self] in
            let stored: [HarnessOutbox.Entry]
            do {
                stored = try await Task.detached(priority: .utility) {
                    try HarnessOutbox.shared.entries(scope: scope, sessionId: sessionId)
                }.value
            } catch {
                self?.note(AppLocalized("未确认消息记录暂时无法读取；没有删除记录，也不会自动重新发送。"))
                return
            }
            guard let self, self.sessionId == sessionId else { return }
            let rejected = stored.filter { $0.state == .rejected }
            if !rejected.isEmpty {
                // 上次拒绝后清理失败留下的记录：后台再清一次；只在这个会话里报一次。
                Task.detached(priority: .utility) { for entry in rejected { _ = try? HarnessOutbox.shared.remove(entry) } }
                for entry in rejected where self.announcedUncertain.insert(entry.id).inserted {
                    self.steerFailed(entry.text, AppLocalized("Mac 已拒绝这条输入，原文已恢复，请核对任务后重试。"))
                }
            }
            let pending = stored.filter { $0.state != .rejected && !self.inFlightOutbox.contains($0.id) }
            for entry in pending where !self.relayQueued.contains(where: { $0.id == entry.id }) {
                self.relayQueued.append(entry)
                if entry.state == .queued {
                    // 中继已收下、Mac 还没醒：这是正常排队，不是错误。
                    if self.announcedUncertain.insert(entry.id).inserted { self.note(Self.queuedWhileOfflineNote) }
                } else {
                    self.showUncertain(entry)
                }
            }
            self.watchRelayQueue()
        }
    }

    @discardableResult
    private func finishOutbox(_ entry: HarnessOutbox.Entry, rejected: Bool = false) throws -> Bool {
        let claimed = try HarnessOutbox.shared.remove(entry, rejected: rejected)
        relayQueued.removeAll { $0.id == entry.id }
        announcedUncertain.remove(entry.id)
        return claimed
    }

    /// Refusal is authoritative even when local cleanup fails. Keep the
    /// refusal on disk before unlink, and recover the text without an automatic
    /// downgrade or a claim that the deleted file is still saved.
    private func finishRejectedOutbox(_ entry: HarnessOutbox.Entry) -> Bool? {
        do {
            return try finishOutbox(entry, rejected: true)
        } catch {
            relayQueued.removeAll { $0.id == entry.id }
            announcedUncertain.remove(entry.id)
            steerFailed(entry.text, AppLocalized("Mac 已拒绝这条输入；本机记录清理失败，原文已放回输入框，请核对任务后重试。"))
            return nil
        }
    }

    private func showUncertain(_ entry: HarnessOutbox.Entry) {
        guard announcedUncertain.insert(entry.id).inserted else { return }
        let message = AppLocalized("这条输入已保存在本机，但送达状态未确认；正在查询 Mac 回执。不要重复发送，请先核对任务。")
        lastError = message
        note(message + "\n" + entry.text)
    }

    private func watchRelayQueue() {
        guard relayQueueWatch == nil, !relayQueued.isEmpty else { return }
        relayQueueWatch = Task { [weak self] in
            // 仅控制台打开期间查询；离开会取消，重新打开从磁盘恢复。
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                guard let self, !Task.isCancelled else { return }
                // [T-link-problem] 这台主机已确认要用户处理(密钥被拒等):查回执也是白敲,等用户点主按钮后再继续。
                // 不消耗 receiptAttempts,恢复后接着查。
                if let hostId = self.client.hostId, GatewayHostStore.shared.isLinkPaused(hostId) { continue }
                _ = await self.checkRelayQueue()
                // 网络 await 期间可能又发送了一条，退出前重读当前队列，不能丢掉新监视。
                if self.relayQueued.isEmpty { break }
            }
            self?.relayQueueWatch = nil
        }
    }

    /// 每条未确认输入最多查这么多轮(15 秒一轮 ≈ 5 分钟)，之后把原文还给用户自己决定。
    private static let receiptAttemptLimit = 20
    private var receiptAttempts: [String: Int] = [:]

    /// Mac 1.3.4+ 会按请求编号留回执；这种 Mac 回答 404 就说明它从没收到过。
    private var hostKeepsReceipts: Bool {
        guard let hostId = client.hostId else { return false }
        return GatewayHostStore.shared.hosts.first { $0.id == hostId }?.device?.capabilities.contains("operation-receipts") == true
    }

    /// True once nothing is left waiting. Missing relay entries do not imply non-execution.
    private func checkRelayQueue() async -> Bool {
        for entry in relayQueued {
            receiptAttempts[entry.id, default: 0] += 1
            do {
                let result = try await client.relayQueueResult(requestId: entry.id)
                if result["status"] as? String == "expired" {
                    // 中继排队超时、从未交给 Mac：明确没送到，原文放回输入框。
                    guard finishRejectedOutbox(entry) == true else { continue }
                    steerFailed(entry.text, AppLocalized("Mac 一直不在线，中继排队已过期，这条没有送到。"))
                    continue
                }
                switch HarnessOutbox.relayResolution(result) {
                case .completed(let http):
                    guard let claimed = http >= 400 ? finishRejectedOutbox(entry) : try finishOutbox(entry), claimed else { continue }
                    if HarnessFullAuto.isRefusal(status: http, harnessKey: harness.key, requestedFullAuto: entry.fullAuto == true) {
                        fullAutoRefused = true
                        note(HarnessFullAuto.refusedNote(serverMessage: nil, status: http))
                        await sendSteer(sessionId: entry.sessionId, text: entry.text)
                    } else if !(200..<300).contains(http) {
                        steerFailed(entry.text, AppLocalized("Mac 拒绝了排队的这条（HTTP \(http)）"))
                    }
                    continue
                case .pending:
                    continue
                case .needsReceipt:
                    break // failed/expired/unknown can hide a lost reply, so reconcile below
                }
            } catch { /* 404、直连模式或中继失联：继续只读查询 Mac 回执。 */ }
            do {
                let receipt = try await client.harnessOperationResult(requestId: entry.id)
                guard case .completed(let http) = HarnessOutbox.receiptResolution(receipt, requestId: entry.id)
                else { giveUpIfExhausted(entry); continue }
                guard let claimed = http >= 400 ? finishRejectedOutbox(entry) : try finishOutbox(entry), claimed else { continue }
                if HarnessFullAuto.isRefusal(status: http, harnessKey: harness.key, requestedFullAuto: entry.fullAuto == true) {
                    fullAutoRefused = true
                    note(HarnessFullAuto.refusedNote(serverMessage: nil, status: http))
                    await sendSteer(sessionId: entry.sessionId, text: entry.text)
                } else if !(200..<300).contains(http) {
                    steerFailed(entry.text, "Mac HTTP \(http)")
                } else {
                    note(AppLocalized("Mac 回执已确认这条输入送达。"))
                }
            } catch GatewayError.http(let status, _) where status == 404 && hostKeepsReceipts && entry.state != .queued {
                // 会留回执的 Mac 说没见过这个编号，中继也没在排队：它没收到。
                guard finishRejectedOutbox(entry) == true else { continue }
                steerFailed(entry.text, AppLocalized("Mac 没有收到这条输入。"))
            } catch {
                giveUpIfExhausted(entry) // 旧 Mac 无回执接口，或已重新配对：保留本机记录供核对。
            }
        }
        return relayQueued.isEmpty
    }

    /// 查不出结果不能永远转圈：到上限后把原文还给用户，并说清"可能已执行"。
    private func giveUpIfExhausted(_ entry: HarnessOutbox.Entry) {
        guard receiptAttempts[entry.id, default: 0] >= Self.receiptAttemptLimit else { showUncertain(entry); return }
        receiptAttempts[entry.id] = nil
        guard finishRejectedOutbox(entry) == true else { return }
        steerFailed(entry.text, AppLocalized("5 分钟内没拿到 Mac 的回执。这条可能已执行，也可能没送到；原文已放回输入框，请先看任务状态再决定是否重发。"))
    }

    private static let queuedWhileOfflineNote = AppLocalized("Mac 暂时不在线，输入已保存在本机并交给中继排队；最终送达需要 Mac 回执确认。")

    /// Send a follow-up. Never a dead tap: with no session yet the text is
    /// queued (create in flight) or becomes the first prompt of a fresh
    /// create (previous create failed). Returns false only for empty text.
    @discardableResult
    func steer(_ text: String) -> Bool {
        guard !text.isEmpty else { return false }
        lastUserText = text
        guard let sessionId else {
            append(GatewayTranscriptItem(kind: .notice, text: "→ " + text))
            if turns.submit(text) {
                // pending/idle:上次创建失败、从未创建或上一轮走的 SSH 兜底——用这条文字当首条
                // 消息重建。isRunning 已置位时 start() 会拒,先复位。
                isRunning = false
                start(prompt: text)
            } else if sshTask != nil {
                note(AppLocalized("已排队：这一轮跑完就发。"))
            }
            return true
        }
        append(GatewayTranscriptItem(kind: .notice, text: "→ " + text))
        lastError = nil
        problem = nil
        if status == "idle" { status = "running" }
        if !isRunning {
            // Not following any more (reconnects gave up, the session read as over):
            // follow again, or the reply never shows.
            isRunning = true
            status = "running"
            streamTask?.cancel()
            streamTask = Task { [weak self] in await self?.follow(sessionId: sessionId) }
        }
        // 每条后续消息都带上全自动开关的当前状态(LeoPhoneAgent 任务):开关关着时 Mac 会把全自动任务切回先问我。
        Task { await self.sendSteer(sessionId: sessionId, text: text) }
        return true
    }

    func stop() {
        guard sessionId != nil else { stopLocalTurn(); return }
        Task { await self.stopAndWait() }
    }

    /// 还没有 Mac 会话(SSH 兜底在跑,或建会话还在路上):停止就是取消本机这一轮。
    /// 以前没有 sessionId 时停止按钮什么都不做,兜底只能等它自己跑完。
    private func stopLocalTurn() {
        guard isRunning || sshTask != nil else { return }
        sshTask?.cancel()
        sshTask = nil
        streamTask?.cancel()
        streamTask = nil
        flushDeltas()
        settleRunningTools()
        let lost = turns.cancel()
        if !lost.isEmpty { unsentText = lost.joined(separator: "\n\n") }
        firstPrompt = nil
        isRunning = false
        status = "idle"
        note(AppLocalized("已停止。"))
    }

    /// The same stop, awaited: for a caller whose process may be suspended as
    /// soon as it returns (the Live Activity's stop button).
    func stopAndWait() async {
        guard let sessionId else { stopLocalTurn(); return }
        do { try await client.stopHarness(sessionId: sessionId) }
        catch {
            lastError = error.localizedDescription
            report(error)
        }
    }

    func respond(to approval: GatewayApprovalRequest, choice: String) {
        guard let sessionId, approval.choices.contains(choice) else { return }
        WatchBridge.shared.clearApprovalRequest(approvalId: approval.approvalId)
        problem = nil
        pendingApprovals.removeAll { $0.approvalId == approval.approvalId }
        status = pendingApprovals.isEmpty ? "running" : "waiting_for_approval"
        if let next = pendingApprovals.first { armWatch(for: next) }
        Task { [weak self, client] in
            do {
                try await client.approveHarness(sessionId: sessionId, choice: choice,
                                                approvalId: approval.approvalId)
            } catch GatewayError.http(status: 409, _) {
                // Nothing is waiting for it any more (answered elsewhere, or the
                // run ended): the card is right to stay gone.
            } catch {
                await MainActor.run {
                    guard let self else { return }
                    // Server refused or never got it: the card comes back,
                    // honestly, at the front of the queue.
                    if !self.pendingApprovals.contains(where: { $0.approvalId == approval.approvalId }) {
                        self.pendingApprovals.insert(approval, at: 0)
                    }
                    self.status = "waiting_for_approval"
                    self.lastError = error.localizedDescription
                    self.report(error)
                    // Re-arm the wrist too: restoring only the phone card would
                    // leave the watch button silently dead on a retry.
                    self.armWatch(for: approval)
                }
            }
        }
    }

    func detach() {
        flushDeltas()
        streamTask?.cancel()
        streamTask = nil
        relayQueueWatch?.cancel()
        relayQueueWatch = nil
        HarnessLiveActivityBridge.shared.unregister(driver: self)
        // SSH 兜底这一轮不随离开页面掐断:它在 sshTask 里跑完,状态保持 running,回来接着看。
        guard isRunning, sshTask == nil else { return }
        isRunning = false
        // Leaving before the session id came back would otherwise strand this
        // driver at detached/nil forever, with no Start button on this screen
        // to recover from. "pending" lets resume re-issue the create instead.
        status = (sessionId == nil) ? "pending" : "detached"
    }

    func resumeIfNeeded() {
        restoreOutbox()   // back on screen: reload durable intents before asking again
        guard !isRunning else { return }
        problem = nil   // 回到页面本身就是一次用户操作:重新试一次,还不行会再次给出说明
        if let hostId = client.hostId { GatewayHostStore.shared.resumeLink(hostId) }
        if let sessionId, status == "detached" {
            isRunning = true
            status = "running"
            streamTask = Task { [weak self] in await self?.follow(sessionId: sessionId) }
        } else if sessionId == nil, status == "pending", let prompt = firstPrompt {
            status = "idle"
            start(prompt: prompt)
        }
    }

    /// 问题块的主按钮点下后:清掉说明、解除这台主机的暂停、换上最新的 client,然后接着跟 / 重新开始。
    /// 重新配对或改了地址后宿主会换新的 client;沿用旧的会带着旧密钥再失败一遍。
    func resumeAfterProblem() {
        problem = nil
        lastError = nil
        if let hostId = client.hostId {
            let store = GatewayHostStore.shared
            store.resumeLink(hostId)
            if let host = store.hosts.first(where: { $0.id == hostId }), let fresh = store.client(for: host) {
                client = fresh
            }
        }
        resumeIfNeeded()
    }

    /// 接管 Mac 上已存在的会话:从 seq 0 全量回放再实时跟随。
    /// 这正是可续传协议的意义——桌面上开的会话,手机随时拿起来继续。
    /// `knownStatus`:列表里看到的状态。空闲的(包括 Mac 桌面上"可接着做"的任务)接上时就显示空闲,
    /// 不再一直挂着"运行中"的打字动画,直到你发一条消息跑完一轮。
    func attach(existingSessionId: String, knownStatus: String? = nil) {
        guard sessionId == nil, !isRunning else { return }
        sessionId = existingSessionId
        restoreOutbox()
        isRunning = true
        status = ["idle", "available", "completed"].contains(knownStatus ?? "") ? "idle" : "running"
        HarnessLiveActivityBridge.shared.register(driver: self, hostName: client.hostName)
        probeSessionFeatures(existingSessionId)
        streamTask = Task { [weak self] in
            await self?.follow(sessionId: existingSessionId)
        }
    }

    // MARK: Stream

    private func follow(sessionId: String) async {
        var attempt = 0
        var seenAtAttemptStart = lastSeq
        var lastProblem: LeoLinkProblem?
        while !Task.isCancelled {
            var cleanClose = false
            var failure: Error?
            do {
                await MainActor.run { self.journalStatus = HarnessJournalStatus() }
                for try await item in client.harnessEvents(sessionId: sessionId, after: lastSeq) {
                    if Task.isCancelled { return }
                    await MainActor.run {
                        if let journal = item.journal {
                            self.journalStatus = journal
                            return
                        }
                        if item.durability == "pending" || item.durability == "unavailable" {
                            self.journalStatus.state = item.durability == "unavailable" || self.journalStatus.state == "degraded" ? "degraded" : "pending"
                            self.journalStatus.latestSeq = max(self.journalStatus.latestSeq, item.seq)
                        }
                        // Skip a replay of the last applied seq when `after` is inclusive.
                        // messageDelta concatenates; applying seq N twice doubles the last chunk.
                        // 说明:Android 那条 harness 路径(MinisHarnessRouter)对 `after`
                        // 是严格大于,这个分支在那边永远不会命中——保留它是为了 Mac /
                        // 未来实现真按 inclusive 处理时不至于把最后一段文字重复一遍,
                        // 属于纯防御,不改变已知实现的行为。
                        if item.seq > 0, item.seq <= self.lastSeq { return }
                        if item.seq > 0 { self.lastSeq = item.seq }
                        self.apply(item.event)
                    }
                    // run.* are all TURN boundaries: after a stop the Mac desktop
                    // app still takes follow-ups. A session that really ended
                    // closes the stream, and the reconcile below reads that.
                }
                cleanClose = true
            } catch {
                if case GatewayError.resumeGap(let minAfter) = error {
                    await MainActor.run {
                        self.lastSeq = T6RelayLogic.advance(current: self.lastSeq, minAfter: minAfter)
                    }
                } else {
                    failure = error
                    await MainActor.run { self.lastError = error.localizedDescription }
                }
            }
            if Task.isCancelled { return }

            // [T-link-problem] 先看这次失败是谁的问题。密钥被拒、Mac 撤销授权、地址不对这类要用户处理的,
            // 再退避六轮(约 90 秒)也不会好:立刻停下,把说明交给控制台,等用户点主按钮(resumeAfterProblem)。
            // 瞬时故障(Mac 睡着、没网、超时)照旧退避;退避用尽才把说明摆出来。
            if let failure, !LeoLinkProblem.isCancellation(failure) {
                let found = LeoLinkProblem.from(error: failure, context: linkContext)
                if found.pausesAutoReconnect {
                    pauseFollowing(because: found)
                    return
                }
                lastProblem = found
            }

            if cleanClose {
                // The server closes the stream deliberately when a session is
                // finished or orphaned. Ask it which, rather than reconnecting
                // into a replay loop or guessing.
                if await reconcile(sessionId: sessionId) { return }
            }

            // Reset once a reconnect actually delivered something: the budget
            // is for CONSECUTIVE failures, not for a long healthy session that
            // happened to blip seven times over an hour.
            if lastSeq > seenAtAttemptStart { attempt = 0; lastProblem = nil }
            seenAtAttemptStart = lastSeq
            attempt += 1
            if attempt > 6 {
                // Before claiming "still running", check: the session may have
                // finished, failed or died while we were unreachable.
                if await reconcile(sessionId: sessionId) { return }
                await MainActor.run {
                    self.status = "detached"
                    self.isRunning = false
                    self.note(AppLocalized("Still running on your Mac; reopen to follow along."))
                    if let lastProblem { self.problem = lastProblem }
                }
                return
            }
            // Resume, not restart: the server kept every event we missed, so
            // picking up at lastSeq loses nothing.
            await MainActor.run {
                self.resumeCount += 1
                self.note(AppLocalized("Reconnecting…"))
            }
            try? await Task.sleep(nanoseconds: UInt64(min(30, 1 << attempt)) * 1_000_000_000)
        }
    }

    /// Ask the server what actually became of the session. Returns true when
    /// the session is over (or gone) and following should stop.
    private func reconcile(sessionId: String) async -> Bool {
        guard let sessions = try? await client.harnessSessions() else { return false }
        guard let summary = sessions.first(where: { $0.id == sessionId }) else {
            await MainActor.run {
                self.status = "completed"
                self.isRunning = false
                self.clearApprovals()
                self.note(AppLocalized("Session is gone from the Mac."))
            }
            return true
        }
        if ["completed", "failed", "cancelled", "orphaned"].contains(summary.status) {
            await MainActor.run {
                self.status = summary.status
                self.isRunning = false
                self.clearApprovals()
                self.note(summary.status == "failed"
                    ? AppLocalized("The session failed on the Mac.")
                    : AppLocalized("Session ended."))
            }
            return true
        }
        return false
    }

    private func apply(_ event: GatewayEvent) {
        if case .messageDelta(let delta) = event {
            bufferDelta(delta)
            return
        }
        flushDeltas()
        switch event {
        case .messageDelta:
            break
        case .reasoning(let text):
            guard !text.isEmpty else { return }
            items.append(GatewayTranscriptItem(kind: .reasoning, text: text))
        case .toolStarted(let tool, let preview, let toolUseId, let input):
            items.append(GatewayTranscriptItem(
                kind: .tool(name: tool, isRunning: true, isError: false, duration: nil),
                text: preview ?? "", toolUseId: toolUseId, detail: input))
        case .toolCompleted(let tool, let duration, let isError, let toolUseId, let output):
            finishTool(id: toolUseId, name: tool, isError: isError, duration: duration, output: output)
        case .approvalRequest(let approval):
            guard !pendingApprovals.contains(where: { $0.approvalId == approval.approvalId }) else { return }
            pendingApprovals.append(approval)
            status = "waiting_for_approval"
            // The wrist shows one card at a time; arm it only for the front of
            // the queue, and the next one when this front resolves.
            if pendingApprovals.count == 1 { armWatch(for: approval) }
            // [T-siri-approval-notify] app 在后台时,审批必须走通知触达,
            // 否则任务静默挂住直到用户想起来打开 app。
            if let sid = sessionId {
                HarnessApprovalNotifier.post(hostId: client.hostId, hostName: client.hostName,
                                             sessionId: sid, approval: approval)
            }
            HarnessLiveActivityBridge.shared.refresh()
        case .approvalResponded(_, let approvalId, let auto):
            // [A1] 全自动:Mac 直接应答,手机上没有审批卡,只在时间线记一笔。
            if let auto { note(AppLocalized("已自动允许 · \(auto)")) }
            if let approvalId {
                if let resolved = pendingApprovals.first(where: { $0.approvalId == approvalId }) {
                    WatchBridge.shared.clearApprovalRequest(approvalId: resolved.approvalId)
                }
                pendingApprovals.removeAll { $0.approvalId == approvalId }
                if let sid = sessionId {
                    HarnessApprovalNotifier.clear(sessionId: sid, approvalId: approvalId)
                }
            } else if let first = pendingApprovals.first {
                WatchBridge.shared.clearApprovalRequest(approvalId: first.approvalId)
                if let sid = sessionId {
                    HarnessApprovalNotifier.clear(sessionId: sid, approvalId: first.approvalId)
                }
                pendingApprovals.removeFirst()
            }
            if let next = pendingApprovals.first {
                armWatch(for: next)
            } else {
                status = "running"
            }
            HarnessLiveActivityBridge.shared.refresh()
        case .runCompleted(let output, _):
            if let output, !output.isEmpty,
               !items.contains(where: { if case .assistantText = $0.kind { return $0.text == output }; return false }) {
                items.append(GatewayTranscriptItem(kind: .assistantText, text: output))
            }
            // Turn over, session alive: the CLI is waiting for the next
            // instruction, and marking it dead here froze the console after
            // the first exchange.
            status = "idle"
            lastTurnFailed = false
            clearApprovals()
            settleRunningTools()
            Task { await self.refreshChanges() }
        case .runFailed(let message):
            // A failed TURN, not a dead session — surface it and stay
            // steerable; a dead process ends via stream close + reconcile.
            lastError = message
            if AgentLoginFlow.failureNeedsLogin(message) { needsAgentLogin = true }
            items.append(GatewayTranscriptItem(
                kind: .failure,
                text: message ?? AppLocalized("The turn failed.")))
            status = "idle"
            lastTurnFailed = true
            clearApprovals()
            settleRunningTools()
            Task { await self.refreshChanges() }
        case .runCancelled:
            // The turn stopped; keep following — a follow-up may come next.
            status = "idle"
            clearApprovals()
            settleRunningTools()
            note(AppLocalized("Session stopped."))
            Task { await self.refreshChanges() }
        case .unknown(let name, let payload):
            if name == "user.message" {
                // The durable log now carries the user half of the
                // conversation; render it like the local echo, and skip the
                // duplicate when this device just typed it.
                let text = payload["text"] ?? ""
                let echo = "→ " + text
                if !text.isEmpty, items.last?.text != echo { note(echo) }
                if status == "idle" { status = "running" }
                return
            }
            if name == "session.created" { return }   // metadata, already shown by the launcher
            // 权限模式变了(手机、Mac 桌面或 agent 自己切的):胶囊跟着变。
            if name == "mode" {
                if let mode = HarnessMode(rawValue: payload["mode"] ?? "") {
                    self.mode = mode
                    recordSupport(Self.modeSupportKey, true)
                }
                return
            }
            // Mac 端给人看的说明(例如"手机暂时答不了的提问已跳过"):只显示文字,不带事件名。
            if name == "session.note" {
                let text = payload["text"] ?? ""
                // [takeover] 没接上终端里的那个会话(已新开对话):显示成醒目的一行说明,而不是灰色小字。
                if !text.isEmpty, MacExternalSessionsWire.isProminentNote(payload) {
                    append(GatewayTranscriptItem(kind: .notice, text: text, prominent: true))
                } else if !text.isEmpty { note(text) }
                return
            }
            // Engine chatter (retries, init banners) shows up here. Surfacing
            // it is what made a broken CLI on the Mac diagnosable instead of
            // looking like a silent hang.
            let detail = payload["raw"] ?? payload["text"] ?? ""
            note("\(name) \(String(describing: detail).prefix(160))")
        }
    }

    /// Mirror an approval to the wrist and accept an answer from there.
    /// A finished turn waits on nothing: drop its cards everywhere (the Mac
    /// clears its own without always saying so, and a replay would bring them back).
    private func clearApprovals() {
        for approval in pendingApprovals {
            WatchBridge.shared.clearApprovalRequest(approvalId: approval.approvalId)
            if let sessionId { HarnessApprovalNotifier.clear(sessionId: sessionId, approvalId: approval.approvalId) }
        }
        pendingApprovals = []
        HarnessLiveActivityBridge.shared.refresh()
    }

    private func armWatch(for approval: GatewayApprovalRequest) {
        WatchBridge.shared.registerApprovalHandler(approvalId: approval.approvalId) { [weak self] choice in
            guard let self, let pending = self.pendingApproval,
                  pending.approvalId == approval.approvalId else { return }
            self.respond(to: pending, choice: choice)
        }
        WatchBridge.shared.sendApprovalRequest(
            approvalId: approval.approvalId,
            command: approval.command, reason: approval.reason, choices: approval.choices)
    }

    private func note(_ text: String) {
        append(GatewayTranscriptItem(kind: .notice, text: text))
    }

    // MARK: [T-link-problem] 连接问题

    private var linkContext: LeoLinkProblem.Context {
        .init(.session, host: client.harnessBaseURL?.host, machineName: client.hostName)
    }

    /// 摆出这个问题。要用户处理的(pausesAutoReconnect)同时记进宿主:该主机的轮询在用户点主按钮前也停下。
    private func adopt(_ found: LeoLinkProblem) {
        problem = found
        if found.pausesAutoReconnect, let hostId = client.hostId {
            GatewayHostStore.shared.recordLinkProblem(found, for: hostId)
        }
    }

    /// 一次请求失败了:把错误翻译成「谁的问题 + 一个按钮」。取消(离开页面)不算失败。
    private func report(_ error: Error) {
        guard !LeoLinkProblem.isCancellation(error) else { return }
        adopt(LeoLinkProblem.from(error: error, context: linkContext))
    }

    /// 停下自动重连:不再退避,把控制台停在「已脱离」,说明交给界面。
    private func pauseFollowing(because found: LeoLinkProblem) {
        adopt(found)
        status = "detached"
        isRunning = false
    }

    private func fail(_ message: String) {
        lastError = message
        append(GatewayTranscriptItem(kind: .failure, text: message))
        status = "failed"
        isRunning = false
        pendingApprovals = []
    }
}

// MARK: - [WP-44] Share extension target

extension LeoAgentClient {
    /// The direct route the share extension may try first (endpoint, device id, short-lived
    /// grant). nil when there is no valid direct route right now.
    func shareDirectRoute() -> (base: String, deviceId: String, token: String, expiresAt: TimeInterval)? {
        guard let route = directRoute, let base = route.endpoint() else { return nil }
        return (base.absoluteString, route.device.deviceId, route.grant.token, route.grant.expiresAt)
    }
}

extension HarnessSessionDriver {
    /// [WP-50] The Mac this task runs on, for the task page's 「Mac 画面」 card.
    var macScreenClient: LeoAgentClient { client }

    /// [WP-44] Remember this Mac task as the share sheet's "发给 Mac 当前任务" target
    /// (App Group: where to send; App Group keychain: the keys). Called when its console
    /// is on screen, so the most recently opened Mac task wins.
    func publishShareTarget(hostName: String) {
        guard let sessionId, let relayBase = client.harnessBaseURLForRelay?.absoluteString else { return }
        let relayKey = client.apiKeyForRelay
        let title = "\(hostName) · \(harness.name)"
        let client = self.client
        Task {
            let direct = await client.shareDirectRoute()
            ShareMacTargetSecrets.save(.init(relayKey: relayKey, directToken: direct?.token))
            ShareMacTarget(sessionId: sessionId, title: title, hostName: hostName, relayBase: relayBase,
                           directBase: direct?.base, directDeviceId: direct?.deviceId,
                           directExpiresAt: direct?.expiresAt, updatedAt: Date(),
                           relayE2EKey: await client.relayE2EKeyForShare()).save()
        }
    }
}
