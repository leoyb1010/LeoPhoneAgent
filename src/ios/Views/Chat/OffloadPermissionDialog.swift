import SwiftUI
import UIKit

struct OffloadPermissionDialogModifier: ViewModifier {
    @ObservedObject private var manager = OffloadPermissionManager.shared
    @Environment(\.scenePhase) private var scenePhase
    @State private var presenterID = UUID().uuidString
    var isEnabled = true

    func body(content: Content) -> some View {
        content
            .onAppear { updatePresenter() }
            .onDisappear { manager.setPresenter(presenterID, available: false) }
            .onChange(of: scenePhase) { _, _ in updatePresenter() }
            .onChange(of: isEnabled) { _, _ in updatePresenter() }
            .onChange(of: manager.pendingRequest?.id) { _, _ in
                OffloadPermissionSheetPresenter.update(manager.pendingRequest)
            }
            .onAppear { OffloadPermissionSheetPresenter.update(manager.pendingRequest) }
    }

    private func updatePresenter() {
        manager.setPresenter(presenterID, available: isEnabled && scenePhase == .active)
    }
}

/// [T-approval-over-sheets] Presented from the top-most UIKit controller. A
/// SwiftUI `.sheet` on the root can't appear while another sheet (a tool's
/// live output, Settings…) is up, so the request sat invisible until the
/// 30-second queue timeout denied it and the task failed.
@MainActor
private enum OffloadPermissionSheetPresenter {
    private static weak var shown: UIViewController?
    private static var shownId: String?

    /// [B7] On screen or on its way there. A sheet UIKit refused to present,
    /// or one torn down with the controller under it, is neither.
    private static func isOnScreen(_ controller: UIViewController?) -> Bool {
        guard let controller, !controller.isBeingDismissed else { return false }
        return controller.presentingViewController != nil || controller.isBeingPresented
    }

    static func update(_ pending: PermissionRequest?) {
        // Same request whose sheet is really up: nothing to do. [B7] Before,
        // a recorded id alone was enough, so a sheet that never made it on
        // screen left the request waiting for the 30-second auto-deny.
        if pending?.id == shownId, pending == nil || isOnScreen(shown) { return }
        if let shown, shown.presentingViewController != nil, !shown.isBeingDismissed {
            shown.dismiss(animated: true)
        }
        shown = nil
        shownId = nil
        guard let request = pending else { return }
        guard let top = topController() else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                update(OffloadPermissionManager.shared.pendingRequest)
            }
            return
        }
        let host = UIHostingController(rootView: OffloadPermissionDialogContent(request: request)
            .onDisappear {
                // Gone while still unanswered (dismissed together with the
                // controller under it): put it back instead of timing out.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                    update(OffloadPermissionManager.shared.pendingRequest)
                }
            })
        host.isModalInPresentation = true
        // Both detents — long arg lists were getting pushed below the medium
        // detent's bottom edge with the Allow / Deny buttons trailing them.
        // The content is scrollable in either height.
        host.sheetPresentationController?.detents = [.medium(), .large()]
        shown = host
        shownId = request.id
        top.present(host, animated: true)
        // present() can decline silently (the top controller started another
        // presentation meanwhile). Check once it had time to land.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            update(OffloadPermissionManager.shared.pendingRequest)
        }
    }

    private static func topController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        // [B7] The app's own window, never the app-lock window stacked above it.
        var top = scene?.chatPresentationWindow?.rootViewController
        while let next = top?.presentedViewController {
            // Mid-transition either way (e.g. a sensitive-tool alert still
            // animating in): presenting on it now would be refused.
            if next.isBeingDismissed || next.isBeingPresented { return nil }
            top = next
        }
        return top
    }
}

extension UIWindowScene {
    /// The scene's content window for presenting chat UI: the key window
    /// first, and only `.normal`-level ones — never the app-lock window
    /// (`AppLockWindowController`, `.alert + 1`) layered above the app.
    var chatPresentationWindow: UIWindow? {
        let normal = windows.filter { $0.windowLevel == .normal && !$0.isHidden }
        return normal.first(where: \.isKeyWindow) ?? normal.first
    }
}

private struct OffloadPermissionDialogContent: View {
    let request: PermissionRequest

    var body: some View {
        VStack(spacing: 0) {
            // Scrollable content. Long argument lists previously stretched the
            // outer VStack past the sheet height and pushed the Allow / Deny
            // buttons below the bottom edge with no way to scroll to them.
            // Pinning the buttons in a separate sibling and wrapping the rest
            // in a ScrollView guarantees the action row is always visible.
            ScrollView {
                VStack(spacing: 0) {
                    // Header
                    VStack(spacing: LeoTheme.Spacing.xs) {
                        Image(systemName: "shield.lefthalf.filled")
                            .font(.system(size: 28, weight: .semibold))
                            .foregroundStyle(LeoTheme.ColorToken.warning)

                        Text("Allow \(request.displayLabel)?")
                            .font(.title3.bold())

                        Text("LOBE needs this device capability for the current task.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.top, 24)
                    .padding(.bottom, 16)

                    // Description
                    if !request.description.isEmpty {
                        VStack(alignment: .leading, spacing: LeoTheme.Spacing.xs) {
                            Label("What it can access", systemImage: "lock.open")
                                .font(.footnote.weight(.semibold))
                            Text(request.description)
                                .font(.footnote)
                                .foregroundStyle(.secondary)

                            Label("Where data goes", systemImage: "arrow.up.forward.app")
                                .font(.footnote.weight(.semibold))
                                .padding(.top, LeoTheme.Spacing.xxs)
                            Text("The device tool runs locally. Information needed to answer this task may be included in the request to your selected model provider.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(LeoTheme.Spacing.sm)
                        .background(LeoTheme.ColorToken.surface, in: RoundedRectangle(cornerRadius: LeoTheme.Radius.field, style: .continuous))
                        .padding(.horizontal, 20)
                        .padding(.bottom, 12)
                    }

                    // Arguments
                    let args = request.parsedArguments
                    if !args.isEmpty {
                        VStack(spacing: 0) {
                            ForEach(Array(args.enumerated()), id: \.offset) { idx, arg in
                                HStack {
                                    Text(arg.key)
                                        .font(.footnote.bold())
                                        .foregroundStyle(.secondary)
                                        .frame(minWidth: 80, alignment: .trailing)
                                        .fixedSize()
                                    Text(arg.value)
                                        .font(.footnote.monospaced())
                                        .lineLimit(6)
                                        .truncationMode(.middle)
                                    Spacer()
                                }
                                .padding(.horizontal, 20)
                                .padding(.vertical, 8)
                                if idx < args.count - 1 {
                                    Divider().padding(.leading, 108)
                                }
                            }
                        }
                        .background(Color(.secondarySystemGroupedBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .padding(.horizontal, 20)
                        .padding(.bottom, 12)
                    }
                }
            }

            // Buttons — pinned to the bottom of the sheet, outside the
            // ScrollView, so they stay tappable even with very long arg lists.
            VStack(spacing: 10) {
                Button {
                    LeoHaptics.notification(.success)
                    OffloadPermissionManager.shared.respond(to: request.id, allowed: true)
                } label: {
                    // [#24] Same wording as every other approval: 允许一次 /
                    // 本次会话允许 / 拒绝. This button grants the session.
                    Text("本次会话允许")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
                .buttonStyle(.glassProminent)
                .tint(LeoTheme.ColorToken.accent)

                // [T-approval-vocab] 不再为同一件事反复点头:放行并记住。
                if !request.command.isEmpty {
                    Button {
                        LeoHaptics.notification(.success)
                        OffloadPermissionManager.shared.respondAlwaysAllow(request)
                    } label: {
                        Text("始终允许")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                    }
                    .buttonStyle(.glass)
                }

                Button {
                    LeoHaptics.notification(.warning)
                    OffloadPermissionManager.shared.respond(to: request.id, allowed: false)
                } label: {
                    // Denies this request only; the next one asks again.
                    Text("拒绝")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
                .buttonStyle(.glassProminent)
                .tint(LeoTheme.ColorToken.destructive)
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 30)
            .background(Color(.systemGroupedBackground))
        }
        .background(Color(.systemGroupedBackground))
        .onAppear {
            LeoHaptics.notification(.warning)
        }
        .accessibilityElement(children: .contain)
    }
}

extension View {
    func offloadPermissionDialog(isEnabled: Bool = true) -> some View {
        modifier(OffloadPermissionDialogModifier(isEnabled: isEnabled))
    }
}
