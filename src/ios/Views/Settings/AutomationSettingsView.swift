//
//  AutomationSettingsView.swift
//  MinisApp
//
//  [T-automation-engine] Rules list + editor. Honest about latency: region
//  wakes are minutes-not-seconds; calendar/charging fire when the app gets
//  a chance to reconcile.
//

import CoreLocation
import EventKit
import SwiftUI

struct AutomationSettingsView: View {
    @ObservedObject private var store = AutomationStore.shared
    @State private var showEditor = false
    @State private var editingRule: AutomationRule?
    @State private var pendingDeleteIds: [String]?

    var body: some View {
        List {
            Section {
                ForEach(store.rules) { rule in
                    ruleRow(rule)
                }
                .onDelete { offsets in
                    pendingDeleteIds = offsets.map { store.rules[$0].id }
                }
                Button { showEditor = true } label: {
                    Label("Add automation", systemImage: "plus.circle.fill")
                }
            } footer: {
                Text("Location rules wake the agent when you arrive or leave (may take a few minutes — iOS decides). Event and charging rules fire when the app reconciles. A rule auto-pauses once its 👎 outnumber its 👍 by three. Time-of-day rules live in Scheduled Tasks.")
            }
        }
        .navigationTitle(Text("Automations"))
        .sheet(isPresented: $showEditor) { AutomationEditSheet(existing: nil) }
        .sheet(item: $editingRule) { rule in AutomationEditSheet(existing: rule) }
        .alert(String(localized: "Delete this automation?"),
               isPresented: Binding(get: { pendingDeleteIds != nil },
                                    set: { if !$0 { pendingDeleteIds = nil } })) {
            Button(String(localized: "Delete"), role: .destructive) {
                for id in pendingDeleteIds ?? [] { store.delete(id: id) }
                pendingDeleteIds = nil
            }
            Button(String(localized: "Cancel"), role: .cancel) { pendingDeleteIds = nil }
        }
        .onAppear { AutomationEngine.shared.reloadMonitoring() }
    }

    private func ruleRow(_ rule: AutomationRule) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            // Only the title block opens the editor; the vote buttons below
            // must stay independently tappable.
            Button { editingRule = rule } label: {
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(rule.name).font(.body.weight(.medium))
                        Spacer()
                        if !rule.isEnabled {
                            Text("Paused").font(.caption2).foregroundStyle(.orange)
                        }
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.tertiary)
                            .accessibilityHidden(true)
                    }
                    Text(rule.trigger.title)
                        .font(.caption).foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .tint(.primary)
            HStack(spacing: 14) {
                Button { store.vote(id: rule.id, up: true) } label: {
                    Label("\(rule.score)", systemImage: "hand.thumbsup")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
                Button { store.vote(id: rule.id, up: false) } label: {
                    Image(systemName: "hand.thumbsdown").font(.caption)
                }
                .buttonStyle(.borderless)
                if let last = rule.lastFiredAt {
                    Text(last, style: .relative)
                        .font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
        // 以前被 3 个 👎 暂停后就再也开不回来了:右滑暂停 / 恢复。
        .swipeActions(edge: .leading) {
            if rule.isEnabled {
                Button("暂停") { store.setEnabled(id: rule.id, false) }.tint(.orange)
            } else {
                Button("恢复") { store.setEnabled(id: rule.id, true) }.tint(.green)
            }
        }
    }
}

private struct AutomationEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model: AutomationEditModel

    init(existing: AutomationRule?) {
        _model = StateObject(wrappedValue: AutomationEditModel(existing: existing))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(String(localized: "Name")) {
                    TextField(String(localized: "e.g. Office arrival briefing"), text: $model.name)
                }
                Section(String(localized: "Trigger")) {
                    Picker(String(localized: "Type"), selection: $model.triggerKind) {
                        Text("Arriving at current location").tag(TriggerKind.arriveHere)
                        Text("Leaving current location").tag(TriggerKind.leaveHere)
                        Text("Before calendar events").tag(TriggerKind.beforeEvent)
                        Text("Charging at night").tag(TriggerKind.nightCharging)
                    }
                    if model.triggerKind == .arriveHere || model.triggerKind == .leaveHere {
                        LabeledContent(String(localized: "Place name")) {
                            TextField(String(localized: "Office / Home…"), text: $model.placeName)
                                .multilineTextAlignment(.trailing)
                        }
                        if model.capturedLocation == nil {
                            if model.locationDenied {
                                Text("没有定位权限:在系统设置里给 LeoPhoneAgent 打开定位,才能按地点触发。")
                                    .font(.caption).foregroundStyle(.orange)
                            } else if model.locationFailed {
                                Button("没拿到当前位置,点这里再试一次") { model.retryLocation() }
                                    .font(.caption)
                            } else {
                                Text("正在获取当前位置…拿到后才能保存。")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        } else if model.isEditing {
                            Text("沿用这条规则原来记下的位置(半径 200 米)。")
                                .font(.caption).foregroundStyle(.secondary)
                        } else {
                            Text("已记下当前位置(半径 200 米)。")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if model.triggerKind == .beforeEvent {
                        Stepper(String(localized: "\(model.minutesBefore) minutes before"),
                                value: $model.minutesBefore, in: 5...120, step: 5)
                        if !model.calendarAuthorized {
                            Text("没有完整的日历权限,这条规则不会触发。")
                                .font(.caption).foregroundStyle(.orange)
                            Button("允许访问日历") { model.requestCalendarAccess() }
                                .font(.caption)
                        }
                    }
                }
                Section(String(localized: "Action")) {
                    Picker(String(localized: "Run"), selection: $model.useQuickTask) {
                        Text("Quick task").tag(true)
                        Text("Custom prompt").tag(false)
                    }
                    if model.useQuickTask {
                        Picker(String(localized: "Task"), selection: $model.quickTaskId) {
                            ForEach(QuickTaskStore.shared.tasks) { task in
                                Text(task.displayName).tag(task.id)
                            }
                        }
                    } else {
                        TextField(String(localized: "What should Leo do?"), text: $model.prompt, axis: .vertical)
                            .lineLimit(3...6)
                    }
                }
            }
            .navigationTitle(Text(model.isEditing ? "Edit Automation" : "New Automation"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Cancel")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Save")) {
                        model.save()
                        dismiss()
                    }
                    .disabled(!model.canSave)
                }
            }
            .onAppear { model.prepare() }
        }
    }
}

private enum TriggerKind: Hashable { case arriveHere, leaveHere, beforeEvent, nightCharging }

@MainActor
private final class AutomationEditModel: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published var name = ""
    @Published var triggerKind: TriggerKind = .arriveHere
    @Published var placeName = ""
    @Published var minutesBefore = 30
    @Published var useQuickTask = true
    @Published var quickTaskId: String = QuickTaskStore.shared.tasks.first?.id ?? ""
    @Published var prompt = ""
    @Published var capturedLocation: CLLocation?
    @Published var calendarAuthorized = EKEventStore.authorizationStatus(for: .event) == .fullAccess
    @Published var locationFailed = false

    private let existing: AutomationRule?
    var isEditing: Bool { existing != nil }
    private let locationManager = CLLocationManager()

    init(existing: AutomationRule?) {
        self.existing = existing
        super.init()
        guard let existing else { return }
        name = existing.name
        switch existing.trigger {
        case .arriveLocation(let lat, let lon, _, let place):
            triggerKind = .arriveHere
            placeName = place
            capturedLocation = CLLocation(latitude: lat, longitude: lon)
        case .leaveLocation(let lat, let lon, _, let place):
            triggerKind = .leaveHere
            placeName = place
            capturedLocation = CLLocation(latitude: lat, longitude: lon)
        case .beforeEvent(let minutes):
            triggerKind = .beforeEvent
            minutesBefore = minutes
        case .nightCharging:
            triggerKind = .nightCharging
        }
        if let quickTaskId = existing.quickTaskId {
            useQuickTask = true
            self.quickTaskId = quickTaskId
        } else {
            useQuickTask = false
            prompt = existing.prompt ?? ""
        }
    }

    /// 没有定位权限:地点规则存不了,界面要说明原因,不能只把「保存」置灰。
    @Published var locationDenied = false
    private var locationRetries = 0

    func prepare() {
        locationManager.delegate = self
        guard capturedLocation == nil else { return }
        switch locationManager.authorizationStatus {
        case .notDetermined: locationManager.requestWhenInUseAuthorization()
        case .denied, .restricted: locationDenied = true
        default: locationManager.requestLocation()
        }
    }

    var canSave: Bool {
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        if triggerKind == .arriveHere || triggerKind == .leaveHere {
            guard capturedLocation != nil, !placeName.isEmpty else { return false }
        }
        return useQuickTask ? !quickTaskId.isEmpty : !prompt.isEmpty
    }

    func retryLocation() {
        locationFailed = false
        locationRetries = 0
        locationManager.requestLocation()
    }

    func requestCalendarAccess() {
        Task { @MainActor in
            let granted = (try? await EKEventStore().requestFullAccessToEvents()) ?? false
            calendarAuthorized = granted
        }
    }

    func save() {
        let trigger: AutomationRule.Trigger
        switch triggerKind {
        case .arriveHere, .leaveHere:
            guard let loc = capturedLocation else { return }
            if triggerKind == .arriveHere {
                trigger = .arriveLocation(lat: loc.coordinate.latitude, lon: loc.coordinate.longitude,
                                          radius: 200, name: placeName)
            } else {
                trigger = .leaveLocation(lat: loc.coordinate.latitude, lon: loc.coordinate.longitude,
                                         radius: 200, name: placeName)
            }
        case .beforeEvent:
            trigger = .beforeEvent(minutes: minutesBefore)
        case .nightCharging:
            trigger = .nightCharging
        }
        var rule = existing ?? AutomationRule(name: "", trigger: trigger)
        rule.name = name.trimmingCharacters(in: .whitespaces)
        rule.trigger = trigger
        rule.quickTaskId = useQuickTask ? quickTaskId : nil
        rule.prompt = useQuickTask ? nil : prompt
        AutomationStore.shared.upsert(rule)
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let latest = locations.last
        Task { @MainActor in
            self.capturedLocation = latest
            self.locationFailed = false
        }
    }

    // 以前授权弹窗点了「允许」也不会再去定位,定位失败也不重试,「保存」一直是灰的。
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            self.locationDenied = status == .denied || status == .restricted
            if status == .authorizedWhenInUse || status == .authorizedAlways, self.capturedLocation == nil {
                self.locationManager.requestLocation()
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            guard !self.locationDenied, self.capturedLocation == nil else { return }
            guard self.locationRetries < 3 else {
                self.locationFailed = true
                return
            }
            self.locationRetries += 1
            try? await Task.sleep(for: .seconds(2))
            self.locationManager.requestLocation()
        }
    }
}
