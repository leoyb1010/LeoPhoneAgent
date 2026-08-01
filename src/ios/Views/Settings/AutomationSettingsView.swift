//
//  AutomationSettingsView.swift
//  MinisApp
//
//  [T-automation-engine] Rules list + editor. Honest about latency: region
//  wakes are minutes-not-seconds; calendar/charging fire when the app gets
//  a chance to reconcile.
//

import CoreLocation
import SwiftUI

struct AutomationSettingsView: View {
    @ObservedObject private var store = AutomationStore.shared
    @State private var showEditor = false

    var body: some View {
        List {
            Section {
                ForEach(store.rules) { rule in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(rule.name).font(.body.weight(.medium))
                            Spacer()
                            if !rule.isEnabled {
                                Text("Paused").font(.caption2).foregroundStyle(.orange)
                            }
                        }
                        Text(rule.trigger.title)
                            .font(.caption).foregroundStyle(.secondary)
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
                }
                .onDelete { offsets in
                    let ids = offsets.map { store.rules[$0].id }
                    for id in ids { store.delete(id: id) }
                }
                Button { showEditor = true } label: {
                    Label("Add automation", systemImage: "plus.circle.fill")
                }
            } footer: {
                Text("Location rules wake the agent when you arrive or leave (may take a few minutes — iOS decides). Event and charging rules fire when the app reconciles. Three thumbs-down auto-pauses a rule. Time-of-day rules live in Scheduled Tasks.")
            }
        }
        .navigationTitle(Text("Automations"))
        .sheet(isPresented: $showEditor) { AutomationEditSheet() }
        .onAppear { AutomationEngine.shared.reloadMonitoring() }
    }
}

private struct AutomationEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = AutomationEditModel()

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
                            Text("Current location is captured when you save.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if model.triggerKind == .beforeEvent {
                        Stepper(String(localized: "\(model.minutesBefore) minutes before"),
                                value: $model.minutesBefore, in: 5...120, step: 5)
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
            .navigationTitle(Text("New Automation"))
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

    private let locationManager = CLLocationManager()

    func prepare() {
        locationManager.delegate = self
        if locationManager.authorizationStatus == .notDetermined {
            locationManager.requestWhenInUseAuthorization()
        }
        locationManager.requestLocation()
    }

    var canSave: Bool {
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        if triggerKind == .arriveHere || triggerKind == .leaveHere {
            guard capturedLocation != nil, !placeName.isEmpty else { return false }
        }
        return useQuickTask ? !quickTaskId.isEmpty : !prompt.isEmpty
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
        AutomationStore.shared.upsert(AutomationRule(
            name: name.trimmingCharacters(in: .whitespaces),
            trigger: trigger,
            quickTaskId: useQuickTask ? quickTaskId : nil,
            prompt: useQuickTask ? nil : prompt))
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let latest = locations.last
        Task { @MainActor in self.capturedLocation = latest }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}
}
