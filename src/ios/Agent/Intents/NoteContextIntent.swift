//
//  NoteContextIntent.swift
//  MinisApp
//
//  [D2]「记下此刻」:快捷指令自动化(到家、出门、连上车载蓝牙……)把一个情境信号交给 App。
//  锁屏可跑、在 App 进程内后台执行;只把信号写进本机情境队列,交给 D1 规则匹配和 D3 决策,
//  3 秒内返回。由它触发的回合不带发信、删除、远程执行类工具(ContextToolPolicy),
//  锁屏时最高第 1 档(准备好,不说话,等你解锁后在收件箱里看)。不占 Siri 短语名额。
//
//  ContextSignalCenter 是情境层的调度:队列 → 决策日志 → 到家接手 / 主动出声闸门 /
//  规则 / 专注收尾卡片。专注过滤器(C9)也走这里。
//

import AppIntents
import Foundation
import UIKit

enum ContextSignalOption: String, AppEnum {
    case home, leave, car, focusStart, focusEnd, custom

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "情境"
    static var caseDisplayRepresentations: [ContextSignalOption: DisplayRepresentation] = [
        .home: "到家", .leave: "出门", .car: "上车",
        .focusStart: "开始专注", .focusEnd: "结束专注", .custom: "自定义",
    ]

    var signalName: String? {
        switch self {
        case .home: return ContextSignalName.home
        case .leave: return ContextSignalName.leave
        case .car: return ContextSignalName.car
        case .focusStart: return ContextSignalName.focusStart
        case .focusEnd: return ContextSignalName.focusEnd
        case .custom: return nil
        }
    }
}

struct NoteContextIntent: AppIntent {
    static var title: LocalizedStringResource = "记下此刻"
    static var description = IntentDescription("告诉 LeoPhoneAgent 你现在的情境(到家、出门、上车……),交给自动化规则处理。锁屏也能跑。")
    static var openAppWhenRun: Bool = false
    /// 和「记一条笔记」一样在 App 进程内后台执行:只写本机情境队列,不读、不念任何已有内容。
    static var supportedModes: IntentModes = .background
    static var authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

    @Parameter(title: "情境", default: .home)
    var signal: ContextSignalOption

    @Parameter(title: "自定义名称", description: "情境选「自定义」时用这个名字匹配规则。")
    var customName: String?

    static var parameterSummary: some ParameterSummary {
        Summary("记下此刻:\(\.$signal)") {
            \.$customName
        }
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        let name = (signal.signalName ?? customName ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return .result() }
        ContextSignalCenter.shared.enqueue(name, source: "intent")
        // 决策和规则匹配通常不到 1 秒;最多等 2.5 秒就返回,剩下的留在队列里,下次进前台接着处理。
        let work = Task { await ContextSignalCenter.shared.processPending() }
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await work.value }
            group.addTask { try? await Task.sleep(nanoseconds: 2_500_000_000) }
            await group.next()
            group.cancelAll()
        }
        return .result()
    }
}

@MainActor
final class ContextSignalCenter {
    static let shared = ContextSignalCenter()
    private static let queueKey = "leo.context.pendingSignals"
    /// 超过这么久才处理的信号只记日志,不再触发规则和接手(情境已经过去了)。
    private static let staleAfter: TimeInterval = 30 * 60

    struct Pending: Codable, Equatable {
        var name: String
        var source: String
        var at: Date
    }

    private var processing = false

    /// 写进情境队列。`logged`:调用方已经写过 context.signal(专注过滤器)。
    func enqueue(_ name: String, source: String, at: Date = Date(), logged: Bool = false) {
        var queue = load()
        queue.append(Pending(name: name, source: source, at: at))
        save(Array(queue.suffix(20)))
        if !logged {
            DiagnosticRing.shared.record(.contextSignal, entryId: name, message: "source=\(source)")
        }
    }

    func processPending() async {
        guard !processing else { return }
        processing = true
        defer { processing = false }
        while let item = load().first {
            await handle(item)
            var queue = load()
            if let index = queue.firstIndex(of: item) { queue.remove(at: index) }
            save(queue)
        }
    }

    private func handle(_ item: Pending) async {
        let defaults = UserDefaults.standard
        // [D5] 专注收尾卡片不怕晚:按信号时间算专注时段。
        if item.name == ContextSignalName.focusEnd {
            await writeFocusSummary(end: item.at)
        }
        let now = Date()
        guard now.timeIntervalSince(item.at) < Self.staleAfter else {
            DiagnosticRing.shared.record(.contextDecision, entryId: item.name, message: "tier=0 信号已过期,只记录")
            return
        }
        let locked = !UIApplication.shared.isProtectedDataAvailable
        // [D3] 决策
        let candidates = await sessionCandidates(interruptedOnly: true)
        let decision = ContextDecision.decide(
            signal: item.name,
            snapshot: .init(interrupted: candidates.list, now: now, isLocked: locked))
        DiagnosticRing.shared.record(.contextDecision, sessionId: decision.sessionId, entryId: item.name,
                                     message: "tier=\(decision.tier) \(decision.reason)\(locked ? " locked" : "")")
        if decision.tier >= AutomationRule.Tier.prepare, let sid = decision.sessionId {
            defaults.set(sid, forKey: ContextKeys.pinnedSessionId)
            defaults.set(now.timeIntervalSince1970, forKey: ContextKeys.pinnedAt)
            // [D6] 第 2 档:默认关;开了也要本机模型可用、值得、当天不满 3 次。
            let spoken = spokenToday(now: now)
            if ContextDecision.allowsSpeaking(decision, enabled: defaults.bool(forKey: ContextKeys.proactiveSpeechEnabled),
                                              onDeviceModelReady: LocalBrain.shared.isReady, spokenToday: spoken),
               let title = candidates.list.first(where: { $0.sessionId == sid })?.title {
                ScheduledTaskRunner.notify(title: "继续上次", body: title.isEmpty ? "有一个中断的任务等你接着做" : title,
                                           sessionId: sid, gated: false)
                setSpokenToday(spoken + 1, now: now)
                DiagnosticRing.shared.record(.contextDecision, sessionId: sid, entryId: item.name,
                                             message: "tier=2 主动出声 \(spoken + 1)/\(ContextDecision.dailySpeechCap)")
            }
        }
        // [D1] 规则
        AutomationEngine.shared.handleSignal(item.name, locked: locked)
    }

    /// 会话候选:排除 Face ID 锁定的会话和正在跑的会话。
    private func sessionCandidates(interruptedOnly: Bool) async -> (list: [ContextDecision.Candidate], interrupted: Set<String>) {
        let interrupted = await ChatStore.shared.interruptedSessionIds()
        if interruptedOnly && interrupted.isEmpty { return ([], interrupted) }
        let tracker = SessionActivityTracker.shared
        let list = await ChatStore.shared.listSessions()
            .filter { !interruptedOnly || interrupted.contains($0.id) }
            .filter { !SessionLockStore.shared.isHiddenFromSystemSurfaces($0.id) }
            .filter { !(interruptedOnly && (tracker.activeSessions.contains($0.id) || tracker.isActive($0.id))) }
            .map { ContextDecision.Candidate(sessionId: $0.id, title: $0.title ?? "", updatedAt: $0.updatedAt) }
        return (list, interrupted)
    }

    /// [D5] 专注结束:这段时间动过的会话,完成 / 未完成,写给首页情境条(不推送)。
    private func writeFocusSummary(end: Date) async {
        let defaults = UserDefaults.standard
        guard let start = defaults.object(forKey: LeoFocusState.startedKey) as? Date, start < end else { return }
        let all = await sessionCandidates(interruptedOnly: false)
        guard let summary = FocusSummary.make(
            modeName: defaults.string(forKey: LeoFocusState.modeKey) ?? "专注",
            start: start, end: end, sessions: all.list, interrupted: all.interrupted),
              let data = try? JSONEncoder().encode(summary) else { return }
        defaults.set(data, forKey: ContextKeys.focusSummary)
        DiagnosticRing.shared.record(.contextDecision, entryId: ContextSignalName.focusEnd,
                                     message: "focus summary done=\(summary.done.count) pending=\(summary.pending.count)")
    }

    private func spokenToday(now: Date) -> Int {
        guard let dict = UserDefaults.standard.dictionary(forKey: ContextKeys.proactiveSpeechCount),
              dict["day"] as? String == QuietTaskBudget.dayString(now) else { return 0 }
        return dict["count"] as? Int ?? 0
    }

    private func setSpokenToday(_ count: Int, now: Date) {
        UserDefaults.standard.set(["day": QuietTaskBudget.dayString(now), "count": count],
                                  forKey: ContextKeys.proactiveSpeechCount)
    }

    private func load() -> [Pending] {
        guard let data = UserDefaults.standard.data(forKey: Self.queueKey) else { return [] }
        return (try? JSONDecoder().decode([Pending].self, from: data)) ?? []
    }

    private func save(_ queue: [Pending]) {
        if let data = try? JSONEncoder().encode(queue) {
            UserDefaults.standard.set(data, forKey: Self.queueKey)
        }
    }
}
