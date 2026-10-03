import SwiftUI

@main struct NativeModelAuditApp: App {
    init() { _ = ProviderConfigStore.shared }
    var body: some Scene {
        WindowGroup {
            AuditRoot()
                .environment(\.locale, Locale(identifier: "en_US"))
                .dynamicTypeSize(ProcessInfo.processInfo.environment["AUDIT_LARGE_TEXT"] == "1" ? .accessibility3 : .large)
        }
    }
}

private enum AuditRoute: String, Identifiable {
    case quick, full, groups, catalog, onboarding
    var id: String { rawValue }
}

private struct AuditRoot: View {
    @ObservedObject private var store = ProviderConfigStore.shared
    @ObservedObject private var pins = ModelPinStore.shared
    @State private var route: AuditRoute?
    @State private var launched = false
    private var selection: String { ModelSwitcher.currentChoiceId(sessionId: "audit-session") ?? "none" }
    var body: some View {
        NavigationStack {
            List {
                Section("Production view journeys") {
                    Button("Quick picker") { route = .quick }.accessibilityIdentifier("audit.open.quick")
                    Button("Full picker") { route = .full }.accessibilityIdentifier("audit.open.full")
                    Button("Model groups") { route = .groups }.accessibilityIdentifier("audit.open.groups")
                    Button("Provider catalog") { route = .catalog }.accessibilityIdentifier("audit.open.catalog")
                    Button("Imported catalog selection") { route = .onboarding }.accessibilityIdentifier("audit.open.onboarding")
                }
                Section("Fixture state") {
                    Text(selection).accessibilityIdentifier("audit.selection")
                    Text(store.defaultPrimaryGroupId ?? "none").accessibilityIdentifier("audit.default")
                    Text(pins.keys.joined(separator: "|")).accessibilityIdentifier("audit.pins")
                    Text("\(store.modelEntries.count) models").accessibilityIdentifier("audit.count")
                }
                Text("Native production views · synthetic local data · no network")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .navigationTitle("Model audit")
            .onAppear {
                guard !launched else { return }
                launched = true
                route = AuditRoute(rawValue: ProcessInfo.processInfo.environment["AUDIT_ROUTE"] ?? "")
            }
            .sheet(item: $route) { destination in
                switch destination {
                case .quick:
                    QuickModelSwitchSheet(sessionId: "audit-session", ensureSessionId: nil)
                case .full:
                    NavigationStack { SessionModelPicker(sessionId: "audit-session") }
                case .groups:
                    NavigationStack {
                        ModelGroupsView()
                            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close audit") { route = nil } } }
                    }
                case .catalog:
                    NavigationStack {
                        AuditProviderCatalog(instanceId: "relay-proxy")
                            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close audit") { route = nil } } }
                    }
                case .onboarding:
                    NavigationStack { OnboardingModelSelectionView() }
                }
            }
        }
    }
}
