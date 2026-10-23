//
//  DeviceCapabilityLayout.swift
//  MinisApp
//
//  [duo-cap] iPhone Duo: decisions that used to ask "is this an iPad?" now ask
//  "what can this window / device do?" (pointer, hardware keyboard, regular
//  width), and safe-area math treats the left and right insets separately (the
//  Duo's Dynamic Island and status bar stand on one SIDE of the screen).
//  Pure values only, so the logic tests can pin them.
//

import CoreGraphics
import Foundation

// MARK: - Mac screen viewer input (P0-5)

/// How the Mac screen viewer takes input once control is ready.
enum MacScreenInputPolicy {
    enum Pointer: Equatable {
        /// Absolute coordinates: hover moves, a click / tap clicks where it lands.
        case pointer
        /// The whole video is a trackpad: relative moves, tap = click.
        case trackpad
    }

    enum Keys: Equatable {
        /// Raw hardware-keyboard keys go straight to the Mac (GCKeyboard); a short
        /// row of buttons covers the combos the system keeps for itself.
        case hardware
        /// On-screen key row plus a text field (no hardware keyboard).
        case controlBar
    }

    struct Decision: Equatable {
        let pointer: Pointer
        let keys: Keys
        /// Forward GCKeyboard key events to the Mac.
        var attachesHardwareKeyboard: Bool { keys == .hardware }
    }

    /// iPad keeps exactly its old behaviour (pointer + hardware keys, keyboard or
    /// not). Anything else — iPhone Duo's inner display, an iPhone with a Magic
    /// Keyboard — gets the pointer mode when a pointing device is connected in a
    /// regular-width window, and hardware keys whenever a keyboard is connected
    /// (the text field would otherwise receive the same keys a second time).
    static func decide(isPadIdiom: Bool, hasPointer: Bool,
                       hasHardwareKeyboard: Bool, isRegularWidth: Bool) -> Decision {
        if isPadIdiom { return Decision(pointer: .pointer, keys: .hardware) }
        return Decision(pointer: hasPointer && isRegularWidth ? .pointer : .trackpad,
                        keys: hasHardwareKeyboard ? .hardware : .controlBar)
    }
}

// MARK: - Mac screen viewer overlays (P0-6)

/// Paddings for controls drawn over the Mac screen video. The full-screen viewer's
/// video ignores the safe area, so its overlays must add the real insets back —
/// each edge on its own (the Duo's island side is much wider than the other).
struct MacScreenOverlayInsets: Equatable {
    /// Top of the badges (failure notice, retry, video menu).
    var badgeTop: CGFloat
    /// Trailing edge of the top-trailing badges.
    var badgeTrailing: CGFloat
    /// Leading / trailing room for the bottom control row and centred notices.
    var controlsLeading: CGFloat
    var controlsTrailing: CGFloat
    /// Gap under the bottom control row.
    var controlsBottom: CGFloat

    /// Height of the full-screen caption pill (36 pt button + 2 × 6 pt) plus a gap:
    /// the badges sit just under it.
    static let captionClearance: CGFloat = 52
    static let edgeGap: CGFloat = 12
    static let bottomGap: CGFloat = 8

    /// Inside a card that keeps the safe area (the inline viewer): unchanged.
    static let inline = MacScreenOverlayInsets(badgeTop: captionClearance, badgeTrailing: edgeGap,
                                               controlsLeading: 0, controlsTrailing: 0,
                                               controlsBottom: bottomGap)

    /// Full screen: the caption pill sits at the top safe edge, so the badges go
    /// under it; everything else clears its own edge's inset.
    static func fullscreen(top: CGFloat, leading: CGFloat, bottom: CGFloat, trailing: CGFloat) -> MacScreenOverlayInsets {
        MacScreenOverlayInsets(badgeTop: max(top, 0) + captionClearance,
                               badgeTrailing: max(trailing, 0) + edgeGap,
                               controlsLeading: max(leading, 0),
                               controlsTrailing: max(trailing, 0),
                               controlsBottom: max(bottom, 0) + bottomGap)
    }
}

// MARK: - Floating control clamp (P0-6, speech capsule)

enum FloatingControlBounds {
    /// Allowed horizontal OFFSET range for a control whose un-offset left edge is
    /// `restLeft` (window coordinates): the control's frame must stay between
    /// `left + margin` and `windowWidth − right − margin`, with the left and right
    /// safe-area insets applied independently.
    static func horizontalOffsetRange(windowWidth: CGFloat, safeLeft: CGFloat, safeRight: CGFloat,
                                      margin: CGFloat, restLeft: CGFloat, width: CGFloat) -> ClosedRange<CGFloat> {
        let minX = max(safeLeft, 0) + margin - restLeft
        let maxX = windowWidth - max(safeRight, 0) - margin - width - restLeft
        return min(minX, maxX)...max(minX, maxX)
    }

    /// Right edge of a control resting at the bottom-trailing corner of a
    /// safe-area-respecting container with `trailingPadding`.
    static func restingMaxX(windowMaxX: CGFloat, safeRight: CGFloat, trailingPadding: CGFloat) -> CGFloat {
        windowMaxX - max(safeRight, 0) - trailingPadding
    }

    /// Topmost y a floating control may reach: under the app's own top bar
    /// (drawn horizontally even when the system bar stands on the side), which
    /// starts at the real top safe inset.
    static func topLimit(safeTop: CGFloat, barHeight: CGFloat = 44, gap: CGFloat = 8) -> CGFloat {
        max(safeTop, 0) + barHeight + gap
    }
}

// MARK: - Share sheet presentation (P0-5)

enum LeoSharePresentation {
    /// A popover pointing at the share button in a regular-width window (iPad,
    /// iPhone Duo inner display); the usual sheet in compact width.
    static func usesPopover(isRegularWidth: Bool) -> Bool { isRegularWidth }
}

// MARK: - Markdown image cap (P1-7)

enum LayoutHeightPolicy {
    /// The layout height image caps derive from: the tallest foreground window
    /// scene. The tallest (not the key) window keeps the value stable while focus
    /// moves between windows, yet it follows a resize — an iPhone Duo unfolding
    /// from the outer to the inner display, Stage Manager.
    static func height(sceneHeights: [CGFloat], fallback: CGFloat) -> CGFloat {
        sceneHeights.filter { $0 > 0 }.max() ?? fallback
    }

    /// Whether a new height should re-measure laid-out images (sub-point noise doesn't).
    static func shouldRecap(old: CGFloat?, new: CGFloat) -> Bool {
        guard let old else { return false }
        return abs(old - new) >= 1
    }
}

// MARK: - Biometry wording (P0-10)

enum BiometryLockText {
    /// `name` is the device's sensor ("Face ID" / "Touch ID" / "Optic ID"), see
    /// `BiometricAuth.biometryDisplayName`.
    static func lockedOpenToReply(_ name: String) -> String {
        AppLocalized("这个会话已用 \(name) 锁定，请在 App 里打开后回复。")
    }

    static func lockedOpenToView(_ name: String) -> String {
        AppLocalized("这个会话已用 \(name) 锁定，请在 App 里打开查看。")
    }
}

// MARK: - Camera choice (P1-6)

/// `apple-camera photo --camera …`.
enum CameraFacingRequest: Equatable {
    case back
    /// The front camera facing the user on the display in use (the system camera
    /// UI picks it: on iPhone Duo the outer one when closed, the under-display one
    /// when open).
    case userFacing
    /// iPhone Duo only: the outer display's front camera / the inner display's
    /// under-display camera, explicitly.
    case outer
    case inner

    static let accepted = "back, front, user_facing, outer, inner"

    init?(argument: String) {
        switch argument.trimmingCharacters(in: .whitespaces).lowercased() {
        case "back", "rear": self = .back
        case "front", "user_facing", "user-facing": self = .userFacing
        case "outer": self = .outer
        case "inner": self = .inner
        default: return nil
        }
    }

    /// Needs an explicit pick between the two front cameras.
    var needsSpecificFrontCamera: Bool { self == .outer || self == .inner }
}
