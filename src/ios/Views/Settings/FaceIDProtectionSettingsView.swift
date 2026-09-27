//
//  FaceIDProtectionSettingsView.swift
//  MinisApp
//
//  Settings entry for per-session biometric protection. Surfaces the
//  master toggle, an idle-timeout picker, and (when relevant) a count of
//  currently-locked sessions with a "clear all" affordance.
//
//  Hidden in the parent settings list when the device lacks biometric
//  capability — see `BiometricAuth.isAvailable`.
//
//  Every change that LOWERS protection (turning a lock off, a longer or
//  "never" re-lock window, Spotlight indexing back on) is written only after
//  Face ID / passcode succeeds. The controls therefore bind through
//  `Binding(get:set:)` instead of `@AppStorage`, which would persist the new
//  value before the prompt even appears.
//

import SwiftUI

struct FaceIDProtectionSettingsView: View {
    @ObservedObject private var store = SessionLockStore.shared
    @AppStorage(SessionLockDefaultsKey.enabled) private var enabled: Bool = false
    @AppStorage(SessionLockDefaultsKey.idleSeconds) private var idleSeconds: Int = 300
    @AppStorage(SessionLockDefaultsKey.appLockEnabled) private var appLockEnabled: Bool = false
    @AppStorage(SessionLockDefaultsKey.appLockIdleSeconds) private var appLockIdleSeconds: Int = 3600  // 与 SessionLockStore 的默认一致(1 小时)
    @AppStorage(SessionSpotlightIndexer.enabledDefaultsKey) private var spotlightEnabled: Bool = true
    @State private var isAuthorizing = false

    var body: some View {
        Form {
            // MARK: - App Lock
            Section {
                Toggle(isOn: appLockBinding) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Lock App")
                        Text("Require \(BiometricAuth.biometryDisplayName) to open LeoPhoneAgent.")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                    }
                }
                .disabled(isAuthorizing)
            } footer: {
                Text("When enabled, \(BiometricAuth.biometryDisplayName) (or device passcode) is required every time you open the app.")
            }

            if appLockEnabled {
                Section {
                    Picker(String(localized: "Require unlock"), selection: appLockIdleBinding) {
                        ForEach(SessionLockIdleOption.allOptions) { opt in
                            Text(opt.labelKey).tag(opt.seconds)
                        }
                    }
                    .disabled(isAuthorizing)
                } header: {
                    Text("App Lock Timeout")
                } footer: {
                    Text("How long after leaving the app before the lock re-engages.")
                }
            }

            // MARK: - Per-Session Lock
            Section {
                Toggle(isOn: sessionLockBinding) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Lock Sessions")
                        Text("Long-press a session in the list to lock it.")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                    }
                }
                .disabled(isAuthorizing)
            } footer: {
                Text("When enabled, locked sessions require \(BiometricAuth.biometryDisplayName) (or device passcode) before their contents are revealed.")
            }

            if enabled {
                Section {
                    Picker(String(localized: "Re-lock after idle"), selection: sessionIdleBinding) {
                        ForEach(SessionLockIdleOption.allOptions) { opt in
                            Text(opt.labelKey).tag(opt.seconds)
                        }
                    }
                    .disabled(isAuthorizing)
                } header: {
                    // Session-only timeout (bound to `idleSeconds`). The app-level
                    // lock has its own separate "App Lock Timeout" above bound to
                    // `appLockIdleSeconds` — so this stays session-scoped.
                    Text("Session Lock Timeout")
                } footer: {
                    Text("After leaving an unlocked session, the lock re-engages once the idle window elapses.")
                }

                Section {
                    HStack {
                        Text("Locked sessions")
                        Spacer()
                        Text("\(store.lockedSessionIds.count)")
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                    if !store.lockedSessionIds.isEmpty {
                        Button(role: .destructive) {
                            Task { @MainActor in
                                let reason = String(localized: "Remove all session locks")
                                let ok = await BiometricAuth.authenticate(reason: reason)
                                if ok {
                                    for sid in store.lockedSessionIds {
                                        store.unlockPermanently(sid)
                                    }
                                }
                            }
                        } label: {
                            Label("Remove All Locks", systemImage: "lock.open")
                        }
                    }
                }
            }

            // MARK: - System surfaces
            Section {
                Toggle(isOn: spotlightBinding) {
                    Text("Show Conversations in Spotlight")
                }
                .disabled(isAuthorizing)
            } footer: {
                Text("Locked sessions are always kept out of Spotlight, widgets, Shortcuts and notification previews. Approving a command from a notification or Siri requires unlocking iPhone first; Deny works without unlocking.")
            }
        }
        .navigationTitle("\(BiometricAuth.biometryDisplayName) Protection")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Bindings

    private var appLockBinding: Binding<Bool> {
        Binding(get: { appLockEnabled }, set: { newValue in
            guard newValue != appLockEnabled else { return }
            if newValue {
                authorize(String(localized: "Enable \(BiometricAuth.biometryDisplayName) app lock"), always: true) {
                    store.appLockEnabled = true
                    store.noteAppUnlock()
                }
            } else {
                authorize(String(localized: "Turn off app lock")) {
                    store.appLockEnabled = false
                }
            }
        })
    }

    private var sessionLockBinding: Binding<Bool> {
        Binding(get: { enabled }, set: { newValue in
            guard newValue != enabled else { return }
            if newValue {
                authorize(String(localized: "Enable \(BiometricAuth.biometryDisplayName) protection for chat sessions"), always: true) {
                    enabled = true
                    // Locked sessions drop out of Spotlight and widgets immediately.
                    Task { await SessionSpotlightIndexer.reindexAll(force: true) }
                    WidgetDataMirror.applyPrivacyToMirroredContent()
                }
            } else {
                authorize(String(localized: "Turn off session locks")) {
                    enabled = false
                    Task { await SessionSpotlightIndexer.reindexAll(force: true) }
                }
            }
        })
    }

    private var appLockIdleBinding: Binding<Int> {
        Binding(get: { appLockIdleSeconds }, set: { newValue in
            guard newValue != appLockIdleSeconds else { return }
            let apply = {
                appLockIdleSeconds = newValue
                store.appLockIdleSeconds = newValue
            }
            if Self.isWeaker(newValue, than: appLockIdleSeconds) {
                authorize(String(localized: "Change app lock timeout"), perform: apply)
            } else {
                apply()
            }
        })
    }

    private var sessionIdleBinding: Binding<Int> {
        Binding(get: { idleSeconds }, set: { newValue in
            guard newValue != idleSeconds else { return }
            if Self.isWeaker(newValue, than: idleSeconds) {
                authorize(String(localized: "Change session lock timeout")) { idleSeconds = newValue }
            } else {
                idleSeconds = newValue
            }
        })
    }

    private var spotlightBinding: Binding<Bool> {
        Binding(get: { spotlightEnabled }, set: { newValue in
            guard newValue != spotlightEnabled else { return }
            if newValue {
                authorize(String(localized: "Show conversations in Spotlight")) {
                    SessionSpotlightIndexer.setEnabled(true)
                }
            } else {
                SessionSpotlightIndexer.setEnabled(false)
            }
        })
    }

    /// "Lock on exit" (-1) is the strictest, then shorter windows, and
    /// "never" (0) is the weakest.
    private static func strictnessRank(_ seconds: Int) -> Int {
        if seconds < 0 { return -1 }
        if seconds == 0 { return .max }
        return seconds
    }

    private static func isWeaker(_ new: Int, than old: Int) -> Bool {
        strictnessRank(new) > strictnessRank(old)
    }

    /// `always`: enabling a lock must prove the user can pass it even on a
    /// device where `authorizeLoweringProtection` would wave a change through.
    private func authorize(_ reason: String, always: Bool = false, perform: @escaping () -> Void) {
        guard !isAuthorizing else { return }
        isAuthorizing = true
        Task { @MainActor in
            let ok = always
                ? await BiometricAuth.authenticate(reason: reason)
                : await BiometricAuth.authorizeLoweringProtection(reason: reason)
            if ok { perform() }
            isAuthorizing = false
        }
    }
}
