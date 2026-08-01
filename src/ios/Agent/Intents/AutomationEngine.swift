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

struct AutomationRule: Codable, Identifiable, Hashable {
    enum Trigger: Codable, Hashable {
        case arriveLocation(lat: Double, lon: Double, radius: Double, name: String)
        case leaveLocation(lat: Double, lon: Double, radius: Double, name: String)
        case beforeEvent(minutes: Int)
        case nightCharging

        var title: String {
            switch self {
            case .arriveLocation(_, _, _, let name): return String(localized: "Arriving at \(name)")
            case .leaveLocation(_, _, _, let name): return String(localized: "Leaving \(name)")
            case .beforeEvent(let minutes): return String(localized: "\(minutes) min before events")
            case .nightCharging: return String(localized: "Charging at night")
            }
        }
    }

    var id: String = UUID().uuidString.lowercased()
    var name: String
    var trigger: Trigger
    /// Quick task to run; mutually exclusive with `prompt`.
    var quickTaskId: String?
    /// Free-form agent prompt (used when quickTaskId is nil).
    var prompt: String?
    var isEnabled: Bool = true
    /// 👍/👎 confidence; at −3 the rule auto-disables.
    var score: Int = 0
    var lastFiredAt: Date?

    /// Debounce: one fire per rule per 30 minutes.
    func canFire(now: Date) -> Bool {
        guard isEnabled else { return false }
        if let last = lastFiredAt, now.timeIntervalSince(last) < 30 * 60 { return false }
        return true
    }
}

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

    func vote(id: String, up: Bool) {
        guard let index = rules.firstIndex(where: { $0.id == id }) else { return }
        rules[index].score += up ? 1 : -1
        if rules[index].score <= -3 {
            rules[index].isEnabled = false
            AutomationEngine.shared.reloadMonitoring()
            ScheduledTaskRunner.notify(
                title: String(localized: "Automation paused"),
                body: rules[index].name, sessionId: nil)
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

    /// Call at launch + whenever rules change: (re)register region monitors.
    func reloadMonitoring() {
        let rules = AutomationStore.shared.rules
        // Drop monitors we no longer need.
        for region in locationManager.monitoredRegions {
            if !rules.contains(where: { $0.id == region.identifier && $0.isEnabled }) {
                locationManager.stopMonitoring(for: region)
            }
        }
        var needsAuth = false
        for rule in rules where rule.isEnabled {
            switch rule.trigger {
            case .arriveLocation(let lat, let lon, let radius, _),
                 .leaveLocation(let lat, let lon, let radius, _):
                needsAuth = true
                guard !locationManager.monitoredRegions.contains(where: { $0.identifier == rule.id }) else { continue }
                let region = CLCircularRegion(
                    center: CLLocationCoordinate2D(latitude: lat, longitude: lon),
                    radius: max(100, radius), identifier: rule.id)
                if case .arriveLocation = rule.trigger {
                    region.notifyOnEntry = true; region.notifyOnExit = false
                } else {
                    region.notifyOnEntry = false; region.notifyOnExit = true
                }
                locationManager.startMonitoring(for: region)
            default: break
            }
        }
        if needsAuth {
            switch locationManager.authorizationStatus {
            case .notDetermined, .authorizedWhenInUse:
                // Region wakes in background require Always; ask honestly.
                locationManager.requestAlwaysAuthorization()
            default: break
            }
        }
        logger.info("monitoring \(self.locationManager.monitoredRegions.count) regions, \(rules.count) rules total")
    }

    /// Reconcile tick — call on foreground (same cadence the scheduled-task
    /// reconciler uses). Handles calendar + charging triggers.
    func reconcile() async {
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
            case .nightCharging:
                let charging = UIDevice.current.batteryState == .charging || UIDevice.current.batteryState == .full
                let hour = Calendar.current.component(.hour, from: now)
                if charging, hour >= 22 || hour < 6 {
                    await fire(rule, context: nil)
                }
            default: break
            }
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

    private func fire(_ rule: AutomationRule, context: String?) async {
        AutomationStore.shared.markFired(id: rule.id)
        // [T-automation-keepalive] A region wake grants seconds; every other
        // background entry point arms the keep-alive first — so do we.
        _ = BackgroundKeepAliveManager.shared.armEagerlyForShortcut(
            sessionId: "intent-eager:automation-\(rule.id)", caller: "automation")
        logger.info("firing rule \(rule.name)")
        if let quickTaskId = rule.quickTaskId {
            _ = await QuickTaskWidgetRunner.run(taskId: quickTaskId)
            ScheduledTaskRunner.notify(
                title: String(localized: "Automation started"),
                body: rule.name, sessionId: nil)
        } else if let prompt = rule.prompt, !prompt.isEmpty {
            let fullPrompt = context.map { "\($0)\n\n\(prompt)" } ?? prompt
            await WatchAskRunner.run(
                requestId: "automation-\(rule.id)",
                prompt: fullPrompt, sessionId: nil)
            ScheduledTaskRunner.notify(
                title: String(localized: "Automation finished"),
                body: rule.name, sessionId: nil)
        }
    }
}
