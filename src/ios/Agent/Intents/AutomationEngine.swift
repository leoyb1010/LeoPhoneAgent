//
//  AutomationEngine.swift
//  MinisApp
//
//  [T-automation-engine] 2.0 pillar 1: the proactive layer. Rules bind a
//  TRIGGER (location arrive/leave, minutes-before-event, night charging) to
//  an ACTION (a quick task, or a free-form agent prompt). Time-based rules
//  stay in the existing ScheduledTask system — this engine only adds the
//  signals iOS can genuinely deliver, and the UI is honest about latency
//  (region wakes can take minutes; calendar/charging fire on reconcile).
//
//  Confidence feedback: every fire sends a notification; 👎 in the rules
//  list decrements the score — at −3 the rule auto-disables instead of
//  nagging forever. (The corrections-memory philosophy applied to
//  automations.)
//
//  Additive guarantee: no rules → nothing monitors, nothing fires, zero
//  behaviour change.
//

import CoreLocation
import EventKit
import Foundation
import UIKit

private let logger = AppLogger(category: "Automation")

// AutomationRule lives in AutomationRule.swift (pure, compiled into MinisLogicTests).

@MainActor
final class AutomationStore: ObservableObject {
    static let shared = AutomationStore()
    static let storageKey = "leo.automations.v1"

    @Published private(set) var rules: [AutomationRule]

    init() {
        if let data = UserDefaults.standard.data(forKey: Self.storageKey),
           let decoded = try? JSONDecoder().decode([AutomationRule].self, from: data) {
            rules = decoded
        } else {
            rules = []
        }
    }

    func upsert(_ rule: AutomationRule) {
        if let index = rules.firstIndex(where: { $0.id == rule.id }) { rules[index] = rule }
        else { rules.append(rule) }
        persist()
        AutomationEngine.shared.reloadMonitoring()
    }

    func delete(id: String) {
        rules.removeAll { $0.id == id }
        persist()
        AutomationEngine.shared.reloadMonitoring()
    }

    /// 手动暂停 / 恢复。恢复时把评分清零,免得再点一次 👎 又被自动暂停。
    func setEnabled(id: String, _ enabled: Bool) {
        guard let index = rules.firstIndex(where: { $0.id == id }), rules[index].isEnabled != enabled else { return }
        rules[index].isEnabled = enabled
        if enabled { rules[index].score = max(rules[index].score, 0) }
        persist()
        AutomationEngine.shared.reloadMonitoring()
    }

    func vote(id: String, up: Bool) {
        guard let index = rules.firstIndex(where: { $0.id == id }) else { return }
        rules[index].score += up ? 1 : -1
        if rules[index].score <= -3 {
            rules[index].isEnabled = false
            AutomationEngine.shared.reloadMonitoring()
            ScheduledTaskRunner.notify(
                title: String(localized: "Automation paused"),
                body: rules[index].name, sessionId: nil, gated: false)
        }
        persist()
    }

    func markFired(id: String) {
        guard let index = rules.firstIndex(where: { $0.id == id }) else { return }
        rules[index].lastFiredAt = Date()
        persist()
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(rules) else { return }
        UserDefaults.standard.set(data, forKey: Self.storageKey)
    }
}

@MainActor
final class AutomationEngine: NSObject, CLLocationManagerDelegate {
    static let shared = AutomationEngine()

    private lazy var locationManager: CLLocationManager = {
        let manager = CLLocationManager()
        manager.delegate = self
        return manager
    }()
    private let eventStore = EKEventStore()

    override init() {
        super.init()
        // Enabled up front: reading batteryState in the same tick it's
        // enabled returns .unknown.
        UIDevice.current.isBatteryMonitoringEnabled = true
    }
    /// beforeEvent dedupe, persisted so a relaunch inside the window doesn't
    /// re-fire the same event. [id: firedAt], pruned at 24h.
    private var firedEventIds: [String: Date] {
        get {
            (UserDefaults.standard.dictionary(forKey: "leo.automations.firedEvents") as? [String: Date]) ?? [:]
        }
        set {
            let pruned = newValue.filter { Date().timeIntervalSince($0.value) < 24 * 3600 }
            UserDefaults.standard.set(pruned, forKey: "leo.automations.firedEvents")
        }
    }

    /// Whether region monitors registered by an earlier run may still exist.
    /// Missing (first run after upgrading) counts as yes, so stale monitors
    /// get cleaned once.
    private static let mayOwnRegionsKey = "leo.automations.mayOwnRegions"

    /// Call at launch + whenever rules change: (re)register region monitors.
    func reloadMonitoring() {
        // [D4] 「夜间充电」规则由安静任务触发;规则变了就重排后台请求。
        QuietTaskScheduler.shared.schedule()
        let rules = AutomationStore.shared.rules
        let wanted = rules.compactMap(Self.region(for:))
        // `monitoredRegions` is a synchronous round trip to locationd, and the
        // launch call runs on the main thread: a slow or wedged locationd held
        // the app on its launch screen. No location rules and nothing left
        // registered means there is nothing to ask about.
        let defaults = UserDefaults.standard
        guard !wanted.isEmpty || (defaults.object(forKey: Self.mayOwnRegionsKey) as? Bool ?? true) else { return }
        let monitored = locationManager.monitoredRegions
        // Drop monitors we no longer need.
        for region in monitored where !wanted.contains(where: { $0.identifier == region.identifier }) {
            locationManager.stopMonitoring(for: region)
        }
        // Register new ones; re-register when the place or direction changed
        // (starting a region with an existing identifier replaces it).
        for region in wanted {
            if let current = monitored.first(where: { $0.identifier == region.identifier }) as? CLCircularRegion,
               current.center.latitude == region.center.latitude,
               current.center.longitude == region.center.longitude,
               current.radius == region.radius,
               current.notifyOnEntry == region.notifyOnEntry { continue }
            locationManager.startMonitoring(for: region)
        }
        defaults.set(!wanted.isEmpty, forKey: Self.mayOwnRegionsKey)
        if !wanted.isEmpty {
            switch locationManager.authorizationStatus {
            case .notDetermined, .authorizedWhenInUse:
                // Region wakes in background require Always; ask honestly.
                locationManager.requestAlwaysAuthorization()
            default: break
            }
        }
        logger.info("monitoring \(wanted.count) regions, \(rules.count) rules total")
    }

    private static func region(for rule: AutomationRule) -> CLCircularRegion? {
        guard rule.isEnabled else { return nil }
        switch rule.trigger {
        case .arriveLocation(let lat, let lon, let radius, _),
             .leaveLocation(let lat, let lon, let radius, _):
            let region = CLCircularRegion(
                center: CLLocationCoordinate2D(latitude: lat, longitude: lon),
                radius: max(100, radius), identifier: rule.id)
            let arriving: Bool
            if case .arriveLocation = rule.trigger { arriving = true } else { arriving = false }
            region.notifyOnEntry = arriving
            region.notifyOnExit = !arriving
            return region
        default:
            return nil
        }
    }

    /// Reconcile tick — call on foreground (same cadence the scheduled-task
    /// reconciler uses). Handles calendar triggers; [D4] night charging moved to
    /// QuietTaskScheduler's BGProcessingTask. [D2] Also drains context signals
    /// a lock-screen intent queued but could not finish.
    func reconcile() async {
        defer { Task { await ContextSignalCenter.shared.processPending() } }
        let now = Date()
        for rule in AutomationStore.shared.rules where rule.canFire(now: now) {
            switch rule.trigger {
            case .beforeEvent(let minutes):
                guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else { continue }
                let window = eventStore.predicateForEvents(
                    withStart: now, end: now.addingTimeInterval(TimeInterval(minutes * 60)), calendars: nil)
                for event in eventStore.events(matching: window)
                where !event.isAllDay && firedEventIds[(event.eventIdentifier ?? "") + event.startDate.description] == nil {
                    firedEventIds[(event.eventIdentifier ?? "") + event.startDate.description] = Date()
                    await fire(rule, context: String(localized: "Upcoming event: \(event.title ?? "")"))
                    break
                }
            default: break
            }
        }
    }

    /// [D4] 安静任务(插电 + 联网的 BGProcessingTask)里调用。不拉保活。
    func fireNightChargingRules() async {
        let now = Date()
        let hour = Calendar.current.component(.hour, from: now)
        guard hour >= 22 || hour < 6 else { return }
        for rule in AutomationStore.shared.rules where rule.trigger == .nightCharging && rule.canFire(now: now) {
            await fire(rule, context: nil, keepAlive: false)
        }
    }

    /// [D1][D2] 外部情境信号命中的规则。不等回合跑完(调用方要 3 秒内返回)。
    /// 情境触发的回合一律不带发信、删除、远程执行类工具;锁屏时最高第 1 档。
    func handleSignal(_ name: String, locked: Bool) {
        let now = Date()
        for rule in AutomationStore.shared.rules where rule.trigger.matchesSignal(name) && rule.canFire(now: now) {
            AutomationStore.shared.markFired(id: rule.id)
            Task { await self.fire(rule, context: "情境信号:\(name)", restricted: true, locked: locked) }
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        // First grant arrives asynchronously — re-register the monitors that
        // silently failed before authorization existed.
        Task { @MainActor in self.reloadMonitoring() }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        Task { @MainActor in await self.fireRegion(id: region.identifier, entering: true) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        Task { @MainActor in await self.fireRegion(id: region.identifier, entering: false) }
    }

    private func fireRegion(id: String, entering: Bool) async {
        guard let rule = AutomationStore.shared.rules.first(where: { $0.id == id }),
              rule.canFire(now: Date()) else { return }
        switch (rule.trigger, entering) {
        case (.arriveLocation, true), (.leaveLocation, false):
            await fire(rule, context: nil)
        default: break
        }
    }

    private func fire(_ rule: AutomationRule, context: String?, restricted: Bool = false,
                      locked: Bool = false, keepAlive: Bool = true) async {
        // Claim the attempt before awaiting dispatch. Failed starts keep the
        // existing 30-minute cooldown so reconciliation cannot retry endlessly.
        AutomationStore.shared.markFired(id: rule.id)
        // [D1] 档位:0 只记录、1 跑但不通知、2 跑完通知。[D2] 锁屏最高第 1 档,结果等解锁后看。
        let tier = locked ? min(rule.tier, AutomationRule.Tier.prepare) : rule.tier
        DiagnosticRing.shared.record(.contextDecision, entryId: "rule",
                                     message: "rule=\(rule.name) trigger=\(rule.trigger.title) tier=\(tier)"
                                        + (tier < rule.tier ? " 锁屏降档" : ""))
        guard tier > AutomationRule.Tier.logOnly else { return }
        if keepAlive {
            // [T-automation-keepalive] A region wake grants seconds; every other
            // background entry point arms the keep-alive first — so do we.
            _ = BackgroundKeepAliveManager.shared.armEagerlyForShortcut(
                sessionId: "intent-eager:automation-\(rule.id)", caller: "automation")
        }
        logger.info("firing rule \(rule.name) tier=\(tier)")
        let speak = tier >= AutomationRule.Tier.speak
        if restricted {
            let body = rule.quickTaskId.flatMap { QuickTaskStore.shared.definition(for: $0)?.renderedPrompt() }
                ?? rule.prompt ?? ""
            guard !body.isEmpty else { return }
            let outcome = await ContextTurnRunner.run(
                prompt: context.map { "\($0)\n\n\(body)" } ?? body, source: "context")
            if speak {
                ScheduledTaskRunner.notify(
                    title: outcome.started ? String(localized: "Automation finished") : String(localized: "Automation failed to start"),
                    body: rule.name, sessionId: outcome.sessionId, gated: false)
            } else if let sid = outcome.sessionId {
                SessionBadgeStore.shared.pushFront(.unread, for: sid)
            }
            return
        }
        if let quickTaskId = rule.quickTaskId {
            let started = await QuickTaskWidgetRunner.run(taskId: quickTaskId)
            guard speak || !started else { return }
            ScheduledTaskRunner.notify(
                title: started ? String(localized: "Automation started") : String(localized: "Automation failed to start"),
                body: started ? rule.name : String(localized: "\(rule.name) did not start. Open Automations and check its Quick Task and provider settings."),
                sessionId: nil, gated: false)
        } else if let prompt = rule.prompt, !prompt.isEmpty {
            let fullPrompt = context.map { "\($0)\n\n\(prompt)" } ?? prompt
            await WatchAskRunner.run(
                requestId: "automation-\(rule.id)",
                prompt: fullPrompt, sessionId: nil)
            guard speak else { return }
            ScheduledTaskRunner.notify(
                title: String(localized: "Automation finished"),
                body: rule.name, sessionId: nil, gated: false)
        }
    }
}
