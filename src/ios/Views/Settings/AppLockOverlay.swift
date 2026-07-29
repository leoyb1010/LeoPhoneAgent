import SwiftUI

struct AppLockOverlay: View {
    @ObservedObject private var store = SessionLockStore.shared
    @State private var isAuthenticating = false

    var body: some View {
        if store.appIsLocked {
            ZStack {
                Color(.systemBackground)
                    .ignoresSafeArea()

                VStack(spacing: 24) {
                    Image(systemName: BiometricAuth.biometryIconName)
                        .font(.system(size: 48))
                        .foregroundStyle(.secondary)

                    Text("LeoPhoneAgent is Locked")
                        .font(.title2.bold())

                    Text("Tap to unlock with \(BiometricAuth.biometryDisplayName)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    Button {
                        authenticate()
                    } label: {
                        Label("Unlock", systemImage: BiometricAuth.biometryIconName)
                            .font(.headline)
                            .padding(.horizontal, 28)
                            .padding(.vertical, 12)
                            .background(.blue, in: RoundedRectangle(cornerRadius: 12))
                            .foregroundStyle(.white)
                    }
                    .disabled(isAuthenticating)
                }
            }
            .transition(.opacity)
            .onAppear {
                authenticate()
            }
        } else if store.showPrivacyScreen {
            Color(.systemBackground)
                .ignoresSafeArea()
        }
    }

    private func authenticate() {
        guard !isAuthenticating else { return }
        isAuthenticating = true
        Task { @MainActor in
            let reason = String(localized: "Unlock LeoPhoneAgent")
            let ok = await BiometricAuth.authenticate(reason: reason)
            if ok {
                withAnimation(.easeOut(duration: 0.25)) {
                    store.noteAppUnlock()
                    // [T-unlock-blank-flash] The privacy screen belongs to the
                    // app switcher, not to the moment after a successful
                    // unlock — leaving it up rendered a bare background page
                    // for the beat until the scene re-activated.
                    store.showPrivacyScreen = false
                }
            }
            isAuthenticating = false
        }
    }
}
