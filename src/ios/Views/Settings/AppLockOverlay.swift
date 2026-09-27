import Combine
import SwiftUI
import UIKit

struct AppLockOverlay: View {
    @ObservedObject private var store = SessionLockStore.shared
    @State private var isAuthenticating = false
    /// Shared across windows so an iPad with several scenes shows a single
    /// system prompt instead of one per lock window.
    @MainActor private static var promptInFlight = false

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
        guard !isAuthenticating, !Self.promptInFlight else { return }
        isAuthenticating = true
        Self.promptInFlight = true
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
            Self.promptInFlight = false
        }
    }
}

/// Hosts `AppLockOverlay` in its own window above every sheet, full-screen
/// cover and alert of the scene. Modal presentations always sit above the
/// root SwiftUI view, so an overlay inside the root ZStack could never cover
/// an open Settings / Treasury / terminal page.
@MainActor
final class AppLockWindowController {
    static let shared = AppLockWindowController()

    private var windows: [ObjectIdentifier: UIWindow] = [:]
    private var cancellable: AnyCancellable?
    private var covering = false

    func attach(to scene: UIWindowScene) {
        let key = ObjectIdentifier(scene)
        guard windows[key] == nil else { return }
        let window = UIWindow(windowScene: scene)
        window.windowLevel = .alert + 1
        window.backgroundColor = .clear
        let host = UIHostingController(rootView: AppLockOverlay())
        host.view.backgroundColor = .clear
        window.rootViewController = host
        window.isHidden = !covering
        windows[key] = window
        observeIfNeeded()
    }

    func detach(from scene: UIWindowScene) {
        windows.removeValue(forKey: ObjectIdentifier(scene))?.isHidden = true
    }

    private func observeIfNeeded() {
        guard cancellable == nil else { return }
        let store = SessionLockStore.shared
        cancellable = Publishers.CombineLatest(store.$appIsLocked, store.$showPrivacyScreen)
            .map { $0 || $1 }
            .removeDuplicates()
            .sink { [weak self] cover in self?.apply(cover: cover) }
    }

    private func apply(cover: Bool) {
        covering = cover
        if cover {
            // A focused text field would keep the keyboard window above us.
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        }
        for window in windows.values { window.isHidden = !cover }
    }
}
