import SwiftUI
import UIKit

@main struct NativeModelAuditApp: App {
    init() { _ = ProviderConfigStore.shared }
    var body: some Scene {
        WindowGroup {
            AuditRoot()
                .environment(\.locale, Locale(identifier: ProcessInfo.processInfo.environment["AUDIT_LANGUAGE"] ?? "en_US"))
                .dynamicTypeSize(ProcessInfo.processInfo.environment["AUDIT_LARGE_TEXT"] == "1" ? .accessibility3 : .large)
                .preferredColorScheme(ProcessInfo.processInfo.environment["AUDIT_DARK"] == "1" ? .dark : .light)
        }
    }
}

private enum AuditRoute: String, Identifiable {
    case quick, full, groups, catalog, onboarding, draft, voiceInput, voiceOutput, contrastReference
    var id: String { rawValue }
}

private struct AuditRoot: View {
    @ObservedObject private var store = ProviderConfigStore.shared
    @ObservedObject private var pins = ModelPinStore.shared
    @State private var route: AuditRoute?
    @State private var launched = false
    @State private var draftKey: String?
    private var selection: String { ModelSwitcher.currentChoiceId(sessionId: "audit-session") ?? "none" }
    private var stateJSON: String {
        var values: [String: String] = [:]
        values["audit.selection"] = selection
        values["audit.reference"] = store.binding(for: "audit-session")?.primarySource.preferredReference ?? "none"
        values["audit.draft"] = draftKey ?? "none"
        values["audit.binding-count"] = String(store.sessionBindings.count)
        values["audit.hidden"] = store.modelEntries.filter(\.isHidden).map(\.id).joined(separator: "|")
        values["audit.research-members"] = store.group(for: "research")?.memberEntryIds.joined(separator: "|") ?? "none"
        values["audit.default"] = store.defaultPrimaryGroupId ?? "none"
        values["audit.pins"] = pins.keys.joined(separator: "|")
        values["audit.move"] = ModelPinStore.auditLastMove
        values["audit.count"] = String(store.modelEntries.count)
        values["audit.edited-name"] = store.entry(for: "relay-proxy/deepseek-reasoner")?.model.displayName ?? "none"
        values["audit.edited-thinking"] = store.entry(for: "relay-proxy/deepseek-reasoner")?.overrides.maxThinkingLevel?.rawValue ?? "none"
        values["audit.edited-id"] = store.entry(for: "relay-proxy/deepseek-reasoner")?.id ?? "none"
        return String(data: try! JSONEncoder().encode(values), encoding: .utf8)!
    }
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
                    Text(store.binding(for: "audit-session")?.primarySource.preferredReference ?? "none").accessibilityIdentifier("audit.reference")
                    Text(draftKey ?? "none").accessibilityIdentifier("audit.draft")
                    Text(String(store.sessionBindings.count)).accessibilityIdentifier("audit.binding-count")
                    Text(store.modelEntries.filter(\.isHidden).map(\.id).joined(separator: "|")).accessibilityIdentifier("audit.hidden")
                    Text(store.group(for: "research")?.memberEntryIds.joined(separator: "|") ?? "none").accessibilityIdentifier("audit.research-members")
                    Text(store.defaultPrimaryGroupId ?? "none").accessibilityIdentifier("audit.default")
                    Text(pins.keys.joined(separator: "|")).accessibilityIdentifier("audit.pins")
                    Text("\(store.modelEntries.count) models").accessibilityIdentifier("audit.count")
                }
                Text("Native production views · synthetic local data · no network")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .safeAreaInset(edge: .bottom) {
                Text("Synthetic audit state")
                    .font(.caption)
                    .accessibilityIdentifier("audit.state")
                    .accessibilityValue(Text(stateJSON))
            }
            .navigationTitle("Model audit")
            .onAppear {
                guard !launched else { return }
                launched = true
                route = AuditRoute(rawValue: ProcessInfo.processInfo.environment["AUDIT_ROUTE"] ?? "")
            }
            .sheet(item: $route) { destination in
                Group {
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
                case .draft:
                    QuickModelSwitchSheet(sessionId: nil, ensureSessionId: nil, pickedKey: draftKey, onPick: { key in draftKey = key; route = nil })
                case .voiceInput:
                    NavigationStack { UnifiedModelPicker(config: .voiceInput()) }
                case .voiceOutput:
                    NavigationStack { UnifiedModelPicker(config: .voiceOutput()) }
                case .contrastReference:
                    ContrastReferenceView()
                }
                }
                .environment(\.locale, Locale(identifier: ProcessInfo.processInfo.environment["AUDIT_LANGUAGE"] ?? "en_US"))
                .environment(\.dynamicTypeSize, ProcessInfo.processInfo.environment["AUDIT_LARGE_TEXT"] == "1" ? .accessibility3 : .large)
            }
        }
    }
}

/// Diagnostic system controls only, never a substitute for a production audit.
/// Same text, size class and sheet/search context; only foreground/background
/// ownership differs so a failing analyzer result can be compared explicitly.
private enum ContrastReferenceStyle {
    // Keep the dynamic UIColor factory outside the View's actor context, exactly
    // as the production ModelPickerText palette; AsyncRenderer may resolve it.
    static let secondary = Color(uiColor: UIColor { traits in
        UIColor(white: traits.userInterfaceStyle == .dark ? 0.74 : 0.28, alpha: 1)
    })
}

private struct ContrastReferenceView: View {
    @State private var search = ""
    private let secondary = ContrastReferenceStyle.secondary
    var body: some View {
        NavigationStack {
            List {
                Section { Text("System primary reference") } header: {
                    Text("Current selection").foregroundStyle(Color.primary)
                        .accessibilityIdentifier("audit.contrast.primary")
                }
                Section { Text("Opaque secondary reference") } header: {
                    Text("Current selection").foregroundStyle(secondary)
                        .accessibilityIdentifier("audit.contrast.secondary")
                }
                Section { Text("Same text with explicit system background") } header: {
                    Text("Current selection").foregroundStyle(secondary)
                        .background(Color(UIColor.systemGroupedBackground))
                        .accessibilityIdentifier("audit.contrast.background")
                }
            }
            .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search model, ID or provider")
            .navigationTitle("System contrast references")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
