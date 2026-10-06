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

                    Text("LeoBot is Locked")
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
            let reason = String(localized: "Unlock LeoBot")
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
    private var cancellables: Set<AnyCancellable> = []
    private var covering = false

    func attach(to scene: UIWindowScene) {
        let key = ObjectIdentifier(scene)
        guard windows[key] == nil else { return }
        let window = UIWindow(windowScene: scene)
        window.windowLevel = .alert + 1
        window.backgroundColor = .clear
        window.overrideUserInterfaceStyle = Self.appearanceStyle
        let host = UIHostingController(rootView: AppLockOverlay())
        host.view.backgroundColor = .clear
        // VoiceOver stays on the lock screen (triple-click VoiceOver is a
        // classic way around app locks); the windows below are hidden from it
        // as well, see `syncUnderlyingAccessibility`.
        host.view.accessibilityViewIsModal = true
        window.rootViewController = host
        window.isHidden = !covering
        windows[key] = window
        observeIfNeeded()
    }

    func detach(from scene: UIWindowScene) {
        windows.removeValue(forKey: ObjectIdentifier(scene))?.isHidden = true
    }

    /// The in-app Appearance choice (0 system, 1 light, 2 dark). This window is
    /// outside SwiftUI's `.preferredColorScheme`, so it follows it by hand.
    private static var appearanceStyle: UIUserInterfaceStyle {
        switch UserDefaults.standard.integer(forKey: "appearanceMode") {
        case 1: return .light
        case 2: return .dark
        default: return .unspecified
        }
    }

    private func observeIfNeeded() {
        guard cancellables.isEmpty else { return }
        let store = SessionLockStore.shared
        Publishers.CombineLatest(store.$appIsLocked, store.$showPrivacyScreen)
            .map { $0 || $1 }
            .removeDuplicates()
            .sink { [weak self] cover in self?.apply(cover: cover) }
            .store(in: &cancellables)
        // A focused text field keeps the keyboard window above ours. Drop focus
        // when the app really locks or leaves, not for the .inactive privacy
        // cover (Control Center, Notification Center, Face ID prompts), which
        // used to throw the keyboard away mid-sentence.
        store.$appIsLocked
            .removeDuplicates()
            .sink { locked in
                if locked { Self.dropKeyboard() }
                // VoiceOver moves onto the lock screen, and back once it lifts.
                UIAccessibility.post(notification: .screenChanged, argument: nil)
            }
            .store(in: &cancellables)
        NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)
            .sink { [weak self] _ in
                guard self?.covering == true else { return }
                UIView.performWithoutAnimation { Self.dropKeyboard() }
            }
            .store(in: &cancellables)
        // A window that appears under an active cover (cold launch behind the
        // lock) starts out reachable by VoiceOver.
        NotificationCenter.default.publisher(for: UIWindow.didBecomeVisibleNotification)
            .sink { [weak self] _ in self?.syncUnderlyingAccessibility() }
            .store(in: &cancellables)
    }

    private static func dropKeyboard() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    private func apply(cover: Bool) {
        covering = cover
        for window in windows.values {
            if cover { window.overrideUserInterfaceStyle = Self.appearanceStyle }
            window.isHidden = !cover
        }
        syncUnderlyingAccessibility()
    }

    /// The app's own windows under a lock window are hidden from VoiceOver
    /// while it covers them.
    private func syncUnderlyingAccessibility() {
        for lockWindow in windows.values {
            guard let scene = lockWindow.windowScene else { continue }
            for window in scene.windows where window !== lockWindow && window.windowLevel == .normal
                && window.accessibilityElementsHidden != covering {
                window.accessibilityElementsHidden = covering
            }
        }
    }
}
