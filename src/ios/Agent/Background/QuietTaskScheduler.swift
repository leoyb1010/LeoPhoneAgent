//
//  QuietTaskScheduler.swift
//  MinisApp
//
//  [D4] 安静任务:系统在插电 + 联网 + 空闲时(通常是夜里充电)拉起 BGProcessingTask,
//  跑「夜间充电」自动化规则、过去 24 小时对话摘要、每周一次记忆整理。
//  每日 token 预算(默认 2 万,设置里可调),用完即停;结果是新会话(source = "quiet"),
//  不归任何文件夹,落在会话列表的「未分组」收件箱,标未读,不推送。
//  不拉起静音音频保活:系统给多少时间就用多少,到期取消当前回合。低电量模式不跑。
//
//  调试(Xcode 暂停后在 LLDB):
//  e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"com.leoyuan.leophoneagent.quiet"]
//

import BackgroundTasks
import Foundation

private let logger = AppLogger(category: "QuietTask")

@MainActor
final class QuietTaskScheduler {
    static let shared = QuietTaskScheduler()
    static let identifier = "com.leoyuan.leophoneagent.quiet"
    private static let lastMemoryTidyKey = "leo.quiet.lastMemoryTidyAt"

    private var registered = false

    var isEnabled: Bool {
        get { UserDefaults.standard.object(forKey: QuietTaskBudget.enabledKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: QuietTaskBudget.enabledKey); schedule() }
    }

    var tokenLimit: Int {
        get {
            let value = UserDefaults.standard.integer(forKey: QuietTaskBudget.limitKey)
            return value > 0 ? value : QuietTaskBudget.defaultLimit
        }
        set { UserDefaults.standard.set(max(1_000, newValue), forKey: QuietTaskBudget.limitKey) }
    }

    var budget: QuietTaskBudget {
        get {
            if let data = UserDefaults.standard.data(forKey: QuietTaskBudget.usageKey),
               let decoded = try? JSONDecoder().decode(QuietTaskBudget.self, from: data) {
                return decoded.normalized(for: Date())
            }
            return QuietTaskBudget(day: QuietTaskBudget.dayString(Date()), used: 0)
        }
        set {
            if let data = try? JSONEncoder().encode(newValue) {
                UserDefaults.standard.set(data, forKey: QuietTaskBudget.usageKey)
            }
        }
    }

    /// 必须在启动结束前注册(AppDelegate didFinishLaunching)。
    func register() {
        guard !registered else { return }
        registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.identifier, using: nil) { task in
            guard let processing = task as? BGProcessingTask else {
                task.setTaskCompleted(success: false)
                return
            }
            Task { @MainActor in QuietTaskScheduler.shared.handle(processing) }
        }
        if !registered { logger.warning("register rejected — identifier missing from Info.plist?") }
    }

    /// 有活可干才排:安静任务开着,或者存在启用的「夜间充电」规则。重复提交会替换旧请求。
    func schedule() {
        guard registered else { return }
        let hasNightRules = AutomationStore.shared.rules.contains { $0.isEnabled && $0.trigger == .nightCharging }
        guard isEnabled || hasNightRules else {
            BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.identifier)
            return
        }
        let request = BGProcessingTaskRequest(identifier: Self.identifier)
        request.requiresExternalPower = true
        request.requiresNetworkConnectivity = true
        request.earliestBeginDate = Self.nextWindowStart(after: Date())
        if #available(iOS 27, *) {
            Task { @MainActor in
                do { try await BGTaskScheduler.shared.submitTaskRequest(request) }
                catch { logger.info("submit failed: \(error.localizedDescription)") }
            }
        } else {
            do { try BGTaskScheduler.shared.submit(request) }
            catch { logger.info("submit failed: \(error.localizedDescription)") }
        }
    }

    /// 夜里 22:00 之后;已经在 22:00–06:00 之间就立刻可跑。
    static func nextWindowStart(after now: Date, calendar: Calendar = .current) -> Date {
        let hour = calendar.component(.hour, from: now)
        if hour >= 22 || hour < 6 { return now }
        return calendar.date(bySettingHour: 22, minute: 0, second: 0, of: now) ?? now
    }

    private func handle(_ task: BGProcessingTask) {
        let work = Task { @MainActor in
            await self.runQuietWork()
            task.setTaskCompleted(success: !Task.isCancelled)
            self.schedule()
        }
        task.expirationHandler = {
            logger.info("expired — cancelling the current quiet turn")
            work.cancel()
        }
    }

    func runQuietWork() async {
        guard !ProcessInfo.processInfo.isLowPowerModeEnabled else {
            DiagnosticRing.shared.record(.contextDecision, entryId: "quiet", message: "低电量模式,安静任务跳过")
            return
        }
        // 「夜间充电」规则改由这里触发(插电是请求条件),同样计入每日预算。
        let ruleTokens = await AutomationEngine.shared.fireNightChargingRules(
            tokenBudget: budget.remaining(limit: tokenLimit, now: Date()))
        if ruleTokens > 0 { budget = budget.adding(ruleTokens, now: Date()) }
        guard isEnabled, !Task.isCancelled else { return }
        for job in [Job.digest, Job.memoryTidy] {
            if Task.isCancelled { break }
            let limit = tokenLimit
            let remaining = budget.remaining(limit: limit, now: Date())
            guard remaining > 0 else {
                DiagnosticRing.shared.record(.contextDecision, entryId: "quiet", message: "今日预算 \(limit) 已用完,停止")
                break
            }
            guard let prompt = await job.prompt() else { continue }
            let outcome = await ContextTurnRunner.run(prompt: prompt, source: "quiet",
                                                      shouldStop: { $0 >= remaining })
            budget = budget.adding(outcome.tokens, now: Date())
            // 只有真跑完才算整理过;半路被系统收回或超预算,下次还要再整理。
            if job == .memoryTidy, outcome.finished {
                UserDefaults.standard.set(Date(), forKey: Self.lastMemoryTidyKey)
            }
            if let sid = outcome.sessionId {
                SessionBadgeStore.shared.pushFront(.unread, for: sid)
            }
            DiagnosticRing.shared.record(.contextDecision, sessionId: outcome.sessionId, entryId: "quiet.\(job.rawValue)",
                                         message: "tokens=\(outcome.tokens) used=\(budget.used)/\(limit) finished=\(outcome.finished)")
        }
    }

    enum Job: String {
        case digest, memoryTidy

        @MainActor
        func prompt() async -> String? {
            switch self {
            case .digest:
                let cutoff = Date().addingTimeInterval(-24 * 3600)
                let sessions = await ChatStore.shared.listSessions()
                let recent = sessions
                    .filter { $0.updatedAt >= cutoff && $0.source != "quiet" && $0.source != "context" }
                    .filter { !SessionLockStore.shared.isHiddenFromSystemSurfaces($0.id) }
                    .sorted { $0.updatedAt > $1.updatedAt }
                    .prefix(20)
                guard !recent.isEmpty else { return nil }
                let lines = recent.map { s in
                    "- \(s.title ?? "未命名") | \(String((s.lastMessage ?? "").prefix(200)))"
                }.joined(separator: "\n")
                return """
                [安静任务 · 对话摘要] 下面是过去 24 小时里动过的会话(标题 | 最后一条消息摘录)。\
                用中文写一份不超过 10 行的回顾:每个会话一行,说清做到哪一步、还差什么。\
                以后还用得上的事实或偏好用 memory_write 记一条(没有就不记)。

                \(lines)
                """
            case .memoryTidy:
                if let last = UserDefaults.standard.object(forKey: QuietTaskScheduler.lastMemoryTidyKey) as? Date,
                   Date().timeIntervalSince(last) < 7 * 24 * 3600 { return nil }
                return """
                [安静任务 · 记忆整理] 用 memory_get(scope 填 daily,keywords 留空)读最近的记忆日志,\
                找出重复、过时或互相矛盾的条目,整理成一份精炼的要点清单,用 memory_write 写回一条\
                「## 记忆整理」条目(不删旧条目)。最后用三五行说明整理了什么。
                """
            }
        }
    }
}

/// [D2][D4] 情境信号 / 安静任务发起一个回合:新会话(不归文件夹,落进收件箱),
/// 去掉发信、删除、远程执行类工具,等回合结束后返回。不碰手表,不拉保活。
@MainActor
enum ContextTurnRunner {
    struct Outcome {
        var sessionId: String?
        var started = false
        var finished = false
        var tokens = 0
    }

    /// `shouldStop(已用 token)` 返回 true 时取消回合(预算用完即停)。
    static func run(prompt: String, source: String, maxWait: TimeInterval = 600,
                    blocksSideEffectTools: Bool = true,
                    shouldStop: ((Int) -> Bool)? = nil) async -> Outcome {
        let previousActive = AIChatViewModel.activeSessionId
        let vm = ViewModelCache.shared.createDraft(pool: .background)
        vm.sessionSource = source
        vm.blocksSideEffectTools = blocksSideEffectTools
        _ = await vm.ensureSessionReturningId()
        AIChatViewModel.activeSessionId = previousActive
        guard let sid = vm.sessionId else {
            vm.blocksSideEffectTools = false
            return Outcome()
        }
        var outcome = Outcome(sessionId: sid)
        let tokens = { vm.sessionInputTokens + vm.sessionOutputTokens }
        let baseline = tokens()
        outcome.started = vm.withComposerSetAside {
            vm.inputText = prompt
            vm.send()
            return vm.isProcessing || vm.isCompacting || vm.compactAndSendRequestId != nil
        }
        guard outcome.started else {
            vm.blocksSideEffectTools = false
            return outcome
        }
        let started = Date()
        var sawActive = false
        var stillRunning = true
        while Date().timeIntervalSince(started) < maxWait {
            try? await Task.sleep(nanoseconds: 500_000_000)
            if Task.isCancelled || shouldStop?(tokens() - baseline) == true {
                vm.cancel()
                break
            }
            // 先压缩再发的回合:压缩期间 isProcessing 为 false,不能当成已结束(否则工具限制提前解除)。
            let active = ContextToolPolicy.isTurnActive(
                processing: vm.isProcessing, compacting: vm.isCompacting,
                pendingCompactSend: vm.compactAndSendRequestId != nil,
                tracked: SessionActivityTracker.shared.activeSessions.contains(sid)
                    || SessionActivityTracker.shared.isActive(sid))
            if active { sawActive = true; continue }
            if sawActive || Date().timeIntervalSince(started) >= 15 {
                stillRunning = false
                outcome.finished = true
                break
            }
        }
        outcome.tokens = max(0, tokens() - baseline)
        let busy = { vm.isProcessing || vm.isCompacting || vm.compactAndSendRequestId != nil }
        if stillRunning && busy() {
            // 还在跑:跑完再放开工具,不在半路改这个回合的工具表。
            Task { @MainActor in
                while busy() { try? await Task.sleep(nanoseconds: 2_000_000_000) }
                vm.blocksSideEffectTools = false
            }
        } else {
            vm.blocksSideEffectTools = false
        }
        return outcome
    }
}
