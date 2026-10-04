import SwiftUI

/// Isolated host for the unchanged production HomeComposerHost/Bar. The canvas,
/// execution menu and submit/voice callbacks are explicit fixture boundaries.
struct AuditHomeComposer: View {
    @ObservedObject private var store = ProviderConfigStore.shared
    @StateObject private var draft = HomeDraft()
    @FocusState private var focused: Bool
    @State private var pickedKey: String?
    @State private var remote = false
    @State private var showModelPicker = false
    @State private var notice = ""

    private var modelName: String {
        if let pickedKey {
            if pickedKey.hasPrefix("group:") {
                return store.group(for: String(pickedKey.dropFirst(6)))?.name ?? pickedKey
            }
            return store.entry(for: pickedKey)?.model.displayName ?? pickedKey
        }
        return ModelSwitcher.defaultLabel(store: store) ?? "Choose Model"
    }

    private var stateJSON: String {
        let values = ["text": draft.text, "model": pickedKey ?? "default", "place": remote ? "mac" : "iphone",
                      "binding-count": String(store.sessionBindings.count), "default": store.defaultPrimaryGroupId ?? "none"]
        return String(data: try! JSONEncoder().encode(values), encoding: .utf8)!
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Text("Production Home composer")
                    .font(.title2).padding(.top, 24)
                Text("Isolated native component · synthetic choices · no execution or permissions")
                    .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                if !notice.isEmpty { Text(notice).font(.footnote) }
                Spacer(minLength: 8)
                Text("Composer fixture state")
                    .font(.caption2)
                    .accessibilityIdentifier("audit.home.state")
                    .accessibilityValue(Text(stateJSON))
            }
            .padding(.horizontal, 20)
            .safeAreaInset(edge: .bottom) {
                HomeComposerHost(
                    draft: draft, isFocused: $focused,
                    capsule: HomeCapsuleLabel(icon: remote ? "desktopcomputer" : "iphone",
                                              place: remote ? "Fixture Mac Studio — remote workstation" : "iPhone",
                                              model: remote ? nil : modelName),
                    capsuleMenu: AnyView(Group {
                        Button("Fixture iPhone") { remote = false }
                        Button("Fixture Mac") { remote = true }
                    }),
                    onChooseModel: remote ? nil : { focused = false; showModelPicker = true },
                    plusMenu: AnyView(Button("Fixture attachment action") { notice = "No files accessed" }),
                    isBusy: false,
                    onSubmit: { notice = "Submit adapter: no task started" },
                    onSlash: { notice = "Action adapter: no tool executed" },
                    onMic: { notice = "Voice adapter: no microphone requested" },
                    onCancelBusy: { notice = "Cancel adapter" }
                )
            }
            .navigationTitle("Home composer audit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Hide keyboard") { focused = false }
                        .accessibilityIdentifier("audit.home.hide-keyboard")
                }
            }
            .onAppear {
                if ProcessInfo.processInfo.environment["AUDIT_HOME_LONG_NAME"] == "1" {
                    pickedKey = "relay-proxy/long-context-model"
                }
            }
            .sheet(isPresented: $showModelPicker) {
                QuickModelSwitchSheet(sessionId: nil, ensureSessionId: nil, pickedKey: pickedKey,
                    onPick: { pickedKey = $0; showModelPicker = false },
                    onResetToDefault: { pickedKey = nil; showModelPicker = false })
            }
        }
    }
}
