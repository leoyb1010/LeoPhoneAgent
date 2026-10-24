import CoreGraphics
import Foundation

// [chat-chrome] One set of sizing rules for the conversation chrome: the
// header model pill, the composer's chip row, the activity strip above the
// composer and the floating scroll buttons. Pure values and string logic only
// (no SwiftUI), so the logic tests compile it directly.

enum LeoChromeMetrics {
    /// Every tappable chrome control gets at least this hit area.
    static let hitTarget: CGFloat = 44
    /// Visible height of a capsule control in a composer row (model, execution target, rewrite).
    static let pillHeight: CGFloat = 32
    static let pillHorizontalPadding: CGFloat = 10
    static let pillIconSpacing: CGFloat = 5
    static let pillIconSize: CGFloat = 12
    static let chevronSize: CGFloat = 9
    /// A model pill never shrinks below this (it then truncates in the middle).
    static let modelPillMinWidth: CGFloat = 88
    /// …and never grows past this, so the chips beside it keep their room.
    static let modelPillMaxWidth: CGFloat = 280
    /// Regular width (iPad, wide windows) has room for the full name.
    static let modelPillMaxWidthRegular: CGFloat = 420

    /// Header (nav bar) model pill: smaller type, sits under the title.
    static let headerPillHeight: CGFloat = 20
    static let headerPillHorizontalPadding: CGFloat = 8

    /// The collapsed activity strip above the composer is one line this tall.
    static let activityRowHeight: CGFloat = 36
    /// Gap between the activity strip and the composer, and between its chips.
    static let activitySpacing: CGFloat = 6
    /// Visible diameter of the floating ↑ / ↓ discs (hit area is `hitTarget`).
    static let floatingButton: CGFloat = 36
    /// Breathing room between the last message and whatever floats over the list bottom.
    static let listBottomGap: CGFloat = 8
}

/// Shorter spellings of a model name for narrow widths.
///
/// "Claude Opus 4.5 Thinking (2026-10-01, Extended Context)" → "Claude Opus 4.5 Thinking";
/// "anthropic/claude-sonnet-4-5-20250929" → "claude-sonnet-4-5".
enum ModelNameCompaction {
    static func compact(_ name: String) -> String {
        var s = name.trimmingCharacters(in: .whitespacesAndNewlines)
        // Vendor / router prefix: keep the last path component.
        if let slash = s.lastIndex(of: "/"), slash != s.index(before: s.endIndex) {
            s = String(s[s.index(after: slash)...])
        }
        // Parenthetical and bracketed qualifiers.
        s = s.replacingOccurrences(of: #"\s*[\(\[][^\)\]]*[\)\]]"#, with: "", options: .regularExpression)
        // Snapshot dates: -2026-10-01, -20250929, @20250929.
        s = s.replacingOccurrences(of: #"[-_@ ]\d{4}-?\d{2}-?\d{2}\b"#, with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\s{2,}"#, with: " ", options: .regularExpression)
        s = s.trimmingCharacters(in: CharacterSet(charactersIn: " -_·"))
        return s.isEmpty ? name : s
    }

    /// Spellings to try from widest to narrowest, without duplicates.
    static func candidates(_ name: String) -> [String] {
        let short = compact(name)
        return short == name ? [name] : [name, short]
    }

    /// The chat header pill: when the session is bound to a group, say which
    /// model the group resolves to ("Group · model"), dropping the group first
    /// when space runs out — the model is what the send actually uses.
    static func headerCandidates(displayName: String, isGroupBound: Bool, resolvedModel: String?) -> [String] {
        guard isGroupBound, let resolvedModel, !resolvedModel.isEmpty, resolvedModel != displayName else {
            return candidates(displayName)
        }
        var out = ["\(displayName) · \(resolvedModel)"]
        for c in candidates(resolvedModel) where !out.contains(c) { out.append(c) }
        return out
    }
}

enum ChatHeaderLayout {
    static let barItemWidth: CGFloat = 44
    /// [ipad-chat] iOS 26 draws neighbouring bar items as ONE glass capsule;
    /// measured on iPad: "…" + inspector toggle = 113 pt wide (2 × 44 + 25).
    /// The old 8 pt let a long title run under the right-hand group, so UIKit
    /// shoved the principal against the leading edge instead of centering it.
    static let barItemSpacing: CGFloat = 24
    /// Breathing room between the principal and the nearest bar item.
    static let titleGap: CGFloat = 8
    static let edgeMargin: CGFloat = 16
    static let minimumCap: CGFloat = 96
    /// A title wider than this reads as a sentence, not a label (iPad full width).
    static let maximumCap: CGFloat = 520

    /// Width of one side's bar items, from the bar edge to where the title may start.
    static func reservedSide(items n: Int) -> CGFloat {
        guard n > 0 else { return edgeMargin }
        return edgeMargin + CGFloat(n) * barItemWidth + CGFloat(n - 1) * barItemSpacing + titleGap
    }

    /// Width the centered principal item (title + model pill) may use without
    /// running into the leading or trailing bar items. The principal stays
    /// centered, so the wider side is reserved on both sides.
    ///
    /// `coveredTrailing`: points of the bar's trailing end hidden behind a
    /// column floating over the chat (the iPad portrait inspector). The bar
    /// still spans the whole detail, so a title centered in it must stop
    /// short of that column on both sides.
    static func principalCap(columnWidth: CGFloat, leadingItems: Int, trailingItems: Int,
                             coveredTrailing: CGFloat = 0) -> CGFloat {
        guard columnWidth > 0 else { return minimumCap }
        let reserved = 2 * max(reservedSide(items: leadingItems), reservedSide(items: trailingItems))
        var cap = columnWidth - reserved
        if coveredTrailing > 0 {
            cap = min(cap, columnWidth - 2 * (coveredTrailing + titleGap + edgeMargin))
        }
        return min(maximumCap, max(minimumCap, cap))
    }
}

/// [ipad-chat] The message column on iPad. Assistant rows cap their CONTENT at
/// the readable width and add the row gutter outside the cap; whole-message
/// rows (user bubble, dividers) carry the gutter inside their own padding, so
/// their cap has to include it or the bubble's trailing edge sits one gutter
/// inside the column the answers line up on.
enum ChatColumnLayout {
    /// Horizontal padding every list row puts outside its content.
    static let rowGutter: CGFloat = 16

    /// `.frame(maxWidth:)` for a row that pads itself by `rowGutter`.
    static func selfPaddedRowCap(contentCap: CGFloat) -> CGFloat? {
        contentCap > 0 ? contentCap + 2 * rowGutter : nil
    }

    /// Width a self-padded row actually lays out at (height estimates must
    /// wrap at this width, not the list width).
    static func selfPaddedRowWidth(listWidth: CGFloat, contentCap: CGFloat) -> CGFloat {
        guard let cap = selfPaddedRowCap(contentCap: contentCap) else { return listWidth }
        return min(listWidth, cap)
    }
}

enum ChatListInsets {
    /// Bottom inset of the message list: everything that floats over the list
    /// bottom (composer + activity strip) plus a small gap, so the last line of
    /// the last message always clears it.
    static func bottom(inputBarHeight: CGFloat, activityStripHeight: CGFloat) -> CGFloat {
        max(0, inputBarHeight) + max(0, activityStripHeight) + LeoChromeMetrics.listBottomGap
    }

    /// Bottom padding for controls floating just above the composer stack.
    static func floatingControlBottom(inputBarHeight: CGFloat, activityStripHeight: CGFloat) -> CGFloat {
        max(0, inputBarHeight) + max(0, activityStripHeight) + 12
    }
}

// MARK: - [duo] iPhone Duo (foldable) rules — pure values, logic-tested

/// [duo-keyboard] When the composer drops its extras (follow-up / quick-task
/// strips, run-status card, tool strip). It used to key on vertical size class
/// alone, which only a landscape phone reports: the Duo's inner display is
/// regular height, so with the keyboard up it kept the full composer over a
/// couple of lines of messages. The rule now also looks at the height actually
/// left for the chat between the top bars and the keyboard (or home indicator).
///
/// `visibleHeight` (ChatComposerLayout.visibleHeight: the chat container's
/// height minus the status and nav bars) must not depend on the composer, or
/// compacting would grow the measurement and undo itself. [duo-composer] It
/// used to subtract the keyboard inset from a height that already excluded it,
/// so every keyboard read as "short" (Pro Max: 260 instead of ~490), which on
/// ≥ 600 pt windows (Duo inner portrait, iPads) compacted the composer. The gap between the two thresholds absorbs
/// the nav bar minimizing on scroll.
///
/// The height half only applies to inner-display-like windows (regular height,
/// window ≥ 600 pt wide): an ordinary iPhone in portrait with a tall
/// third-party keyboard is left alone, and enters only below 320 pt.
enum ChatShortHeightRule {
    /// Below this a full composer leaves the list about two lines. Duo inner
    /// landscape with the keyboard up is ~295.
    static let enterBelow: CGFloat = 320
    /// Clears `enterBelow` by more than the nav bar's minimize step.
    static let exitAbove: CGFloat = 400
    /// Narrowest window the height half applies to (Duo inner display: 669 / 951;
    /// every iPhone portrait window and the Duo outer display are narrower).
    static let minWindowWidth: CGFloat = 600

    /// Height half of the rule. `visibleHeight <= 0` = not measured yet: keep the answer.
    static func heightIsShort(visibleHeight: CGFloat, wasShort: Bool) -> Bool {
        guard visibleHeight > 0 else { return wasShort }
        return wasShort ? visibleHeight < exitAbove : visibleHeight < enterBelow
    }

    /// The height half, gated to inner-display-like windows. `windowWidth <= 0`
    /// = window not known yet: not short.
    static func heightIsShort(visibleHeight: CGFloat, wasShort: Bool,
                              verticalSizeClassRegular: Bool, windowWidth: CGFloat) -> Bool {
        guard verticalSizeClassRegular, windowWidth.isFinite, windowWidth >= minWindowWidth else { return false }
        return heightIsShort(visibleHeight: visibleHeight, wasShort: wasShort)
    }

    static func isShort(verticalSizeClassCompact: Bool, heightIsShort: Bool) -> Bool {
        verticalSizeClassCompact || heightIsShort
    }
}

/// [duo-composer] Sizing of the chat composer from the chat container's geometry.
///
/// The container (AIChatView's root) ignores the top safe area, so its height
/// runs from the window top down to the keyboard or home indicator, and its
/// bottom safe-area inset is the keyboard (or home indicator) itself — already
/// outside the height. Measured: 18 Pro Max 922 / inset 34 without the
/// keyboard, 608 / inset 348 with it.
enum ChatComposerLayout {
    /// Nav bar allowance under the status bar (the bar can minimize; a fixed
    /// allowance keeps the measurement from moving while scrolling).
    static let navigationBarAllowance: CGFloat = 50

    /// Height left for the conversation between the top bars and the keyboard /
    /// home indicator. `windowTopInset == nil` (window not known yet) → 0, which
    /// every consumer treats as "not measured".
    static func visibleHeight(containerHeight: CGFloat, windowTopInset: CGFloat?) -> CGFloat {
        guard let top = windowTopInset, containerHeight.isFinite, containerHeight > 0 else { return 0 }
        return max(1, containerHeight - top - navigationBarAllowance)
    }

    /// Full window height, stable while the keyboard comes and goes.
    static func windowHeight(containerHeight: CGFloat, bottomInset: CGFloat) -> CGFloat {
        max(0, containerHeight) + max(0, bottomInset)
    }

    // MARK: Text growth

    /// Landscape phone (compact height): three lines, as before.
    static let compactHeightMaxText: CGFloat = 60
    /// Before the first measurement: the old fixed six lines.
    static let unmeasuredMaxText: CGFloat = 120
    /// Never fewer than three lines (≈ 20 pt each at the default size)…
    static let minText: CGFloat = 60
    /// …and never more than eight.
    static let maxText: CGFloat = 160
    /// Share of the visible height the text may take before it scrolls.
    static let visibleFraction: CGFloat = 0.25
    /// Whole-line steps, so small geometry changes don't resize a full composer.
    static let textStep: CGFloat = 20

    /// How tall the composer's text grows before it scrolls. Pro Max: 8 lines
    /// without the keyboard, 6 with it; Duo outer / inner landscape with the
    /// keyboard: 3.
    static func maxTextHeight(visibleHeight: CGFloat, verticalSizeClassCompact: Bool) -> CGFloat {
        if verticalSizeClassCompact { return compactHeightMaxText }
        guard visibleHeight > 0, visibleHeight.isFinite else { return unmeasuredMaxText }
        let stepped = (visibleHeight * visibleFraction / textStep).rounded(.down) * textStep
        return min(maxText, max(minText, stepped))
    }

    // MARK: Bottom edge

    /// Gap between the composer and the keyboard (or a window edge with no inset).
    static let keyboardGap: CGFloat = 8
    /// Insets up to this are a home indicator (iPhone 34, iPad 20); above it,
    /// the keyboard or its accessory bar.
    static let homeIndicatorMaxInset: CGFloat = 44

    /// Bottom padding under the composer card, relative to the safe-area bottom.
    /// Without the keyboard the card used to float `8 + 34` pt above the screen
    /// edge — a dead band. Now it sits just above the home indicator (20 pt
    /// from the edge on iPhone, 12 on iPad), so the value is negative there.
    static func bottomPadding(bottomInset: CGFloat) -> CGFloat {
        guard bottomInset.isFinite, bottomInset > 0, bottomInset <= homeIndicatorMaxInset else { return keyboardGap }
        let gapFromEdge = max(bottomInset - 14, (bottomInset * 0.6).rounded())
        return gapFromEdge - bottomInset
    }

    // MARK: Dense chrome (short windows)

    /// Windows this short get the dense composer: iPhone Duo outer (678) and
    /// inner landscape (669), SE (667), landscape phones. 18 Pro (874), Pro Max
    /// (956), Duo inner portrait (951) and iPads keep the roomy one.
    static let denseMaxWindowHeight: CGFloat = 700

    static func isDense(windowHeight: CGFloat) -> Bool {
        windowHeight.isFinite && windowHeight > 0 && windowHeight <= denseMaxWindowHeight
    }

    struct Spacing: Equatable {
        /// Above the text (no attachments / with attachment chips).
        var textTop: CGFloat
        var textTopWithAttachments: CGFloat
        /// Under the + / send row, inside the card.
        var rowBottom: CGFloat
        /// Above the card.
        var outerTop: CGFloat
    }

    static func spacing(dense: Bool) -> Spacing {
        dense ? Spacing(textTop: 8, textTopWithAttachments: 6, rowBottom: 6, outerTop: 4)
              : Spacing(textTop: 16, textTopWithAttachments: 11, rowBottom: 10, outerTop: 8)
    }
}

/// [duo-fold] Padding that keeps a manually placed control off the fold of a
/// half-open iPhone Duo (`ReservedRegion.Kind.division`). Scrolling content is
/// never moved — only floating chrome (composer card, activity strip, ↑↓
/// discs, new-message pill).
///
/// Local space of the control, x from its leading edge. The control is
/// bottom-anchored (all of the chat's floating chrome is) and horizontally
/// flexible (leading / trailing padding narrows it onto one side of the fold).
struct FoldInsets: Equatable {
    var top: CGFloat = 0
    var leading: CGFloat = 0
    var bottom: CGFloat = 0
    var trailing: CGFloat = 0

    static let zero = FoldInsets()
}

enum FoldAvoidance {
    /// Narrowest side a control may be squeezed onto; below this it stays put.
    static let minimumSide: CGFloat = 160

    /// - Parameters:
    ///   - size: the control's natural size (no fold padding applied).
    ///   - divisions: active division frames, relative to the control's natural origin.
    static func insets(size: CGSize, divisions: [CGRect]) -> FoldInsets {
        var out = FoldInsets.zero
        let bounds = CGRect(origin: .zero, size: size)
        for division in divisions where division.intersects(bounds) {
            if division.height >= division.width {
                // Vertical fold (book posture): move onto the roomier side.
                let leadingRoom = max(0, division.minX - bounds.minX)
                let trailingRoom = max(0, bounds.maxX - division.maxX)
                if trailingRoom >= leadingRoom {
                    guard trailingRoom >= minimumSide else { continue }
                    out.leading = max(out.leading, division.maxX - bounds.minX)
                } else {
                    guard leadingRoom >= minimumSide else { continue }
                    out.trailing = max(out.trailing, bounds.maxX - division.minX)
                }
            } else {
                // Horizontal fold (laptop posture): rise until the bottom edge clears it.
                out.bottom = max(out.bottom, bounds.maxY - division.minY)
            }
        }
        return out
    }

    /// The control's natural frame inside its padded, bottom-anchored wrapper of
    /// size `measured`, given the padding currently `applied`. Computing the next
    /// padding from this (not from the padded frame) avoids a feedback loop.
    static func naturalFrame(measured: CGSize, applied: FoldInsets) -> CGRect {
        // Padding grows the wrapper upward from the anchored bottom edge, so the
        // unpadded control would sit at the wrapper's bottom; a flexible control
        // spans the wrapper's full width whatever the side padding.
        let h = max(0, measured.height - applied.top - applied.bottom)
        return CGRect(x: 0, y: max(0, measured.height - h), width: max(0, measured.width), height: h)
    }

    /// One step: measured wrapper + divisions in wrapper space + applied padding → next padding.
    static func nextInsets(measured: CGSize, divisions: [CGRect], applied: FoldInsets) -> FoldInsets {
        let natural = naturalFrame(measured: measured, applied: applied)
        let local = divisions.map { $0.offsetBy(dx: -natural.minX, dy: -natural.minY) }
        return insets(size: natural.size, divisions: local)
    }
}

/// [duo-windows] Which of several live chat views (oldest first) handles an
/// app-wide event that must be handled once: the newest one in the key window
/// (during a fold both the outgoing and incoming view share it), else the newest.
enum GlobalEventRouting {
    static func winner(isKey: [Bool]) -> Int? {
        guard !isKey.isEmpty else { return nil }
        return isKey.lastIndex(of: true) ?? isKey.count - 1
    }
}

/// [duo-fold] Restores a reading position after the chat view is re-created
/// (fold / unfold swaps the split shell and the stack).
enum ChatScrollAnchorMath {
    /// `offsetFromTop` = item.minY − (contentOffset.y + adjustedTop) when parked.
    /// Returns the content offset that puts the item back, clamped to the
    /// scrollable range `[-adjustedTop, maxOffset]`.
    static func restoredOffset(itemMinY: CGFloat, offsetFromTop: CGFloat,
                               adjustedTop: CGFloat, maxOffset: CGFloat) -> CGFloat {
        let lower = -adjustedTop
        return min(max(itemMinY - offsetFromTop - adjustedTop, lower), max(lower, maxOffset))
    }
}

/// [duo-fold] Folding or unfolding re-creates the chat view. Objects that must
/// outlive that (a draft chat's view model, the voice-input state machine with a
/// segment still transcribing) live here while a view claims them and for
/// `window` seconds after the last claim is released: long enough for the
/// replacement view to adopt them, short enough that really leaving lets go.
final class FoldContinuityStore<Value: AnyObject> {
    private struct Entry {
        var value: Value
        var claims: Int
        var releasedAt: Date?
    }

    let window: TimeInterval
    private let now: () -> Date
    private var entries: [String: Entry] = [:]

    init(window: TimeInterval = 3, now: @escaping () -> Date = Date.init) {
        self.window = window
        self.now = now
    }

    /// The live or recently released value for `key`, or a new one (which
    /// counts as released until a view claims it).
    func value(for key: String, create: () -> Value) -> (value: Value, reused: Bool) {
        prune()
        if let entry = entries[key] { return (entry.value, true) }
        let value = create()
        entries[key] = Entry(value: value, claims: 0, releasedAt: now())
        return (value, false)
    }

    func existing(_ key: String) -> Value? {
        prune()
        return entries[key]?.value
    }

    func claim(_ key: String) {
        prune()
        guard var entry = entries[key] else { return }
        entry.claims += 1
        entry.releasedAt = nil
        entries[key] = entry
    }

    func release(_ key: String) {
        guard var entry = entries[key] else { return }
        entry.claims = max(0, entry.claims - 1)
        if entry.claims == 0 { entry.releasedAt = now() }
        entries[key] = entry
        prune()
    }

    var count: Int { prune(); return entries.count }

    private func prune() {
        let t = now()
        entries = entries.filter { _, e in
            guard let released = e.releasedAt else { return true }
            return t.timeIntervalSince(released) < window
        }
    }
}

/// [duo-fold] Fold continuity (parking a reading position or open panel for the
/// replacement view) only applies to a teardown a fold / display change caused:
/// the hinge moved within `hingeWindow`, or a window scene's geometry changed
/// within `geometryWindow`. Any other teardown (pop to home, deep-link jump)
/// behaves as before the Duo work: nothing is parked.
enum FoldSignalPolicy {
    static let hingeWindow: TimeInterval = 1.5
    static let geometryWindow: TimeInterval = 1.0

    static func isRecentFold(lastHingeMovement: Date?, lastGeometryChange: Date?, now: Date) -> Bool {
        func within(_ date: Date?, _ window: TimeInterval) -> Bool {
            guard let date else { return false }
            let age = now.timeIntervalSince(date)
            return age >= 0 && age <= window
        }
        return within(lastHingeMovement, hingeWindow) || within(lastGeometryChange, geometryWindow)
    }
}

/// [duo-fold] Timestamps fed by the hinge observer (AgentLiveActivityManager)
/// and the scene geometry observer (SceneDisplayLogger).
@MainActor
enum FoldSignal {
    static var lastHingeMovement: Date?
    static var lastGeometryChange: Date?

    static func noteHingeMovement(at date: Date = Date()) { lastHingeMovement = date }
    static func noteGeometryChange(at date: Date = Date()) { lastGeometryChange = date }

    static var isRecent: Bool {
        FoldSignalPolicy.isRecentFold(lastHingeMovement: lastHingeMovement,
                                      lastGeometryChange: lastGeometryChange, now: Date())
    }
}

/// [duo-fold] Restoring a parked reading position waits for the list to be laid
/// out; after `maxAttempts` run-loop turns with zero height it gives up and the
/// list goes back to following the bottom.
enum FoldAnchorRestore {
    enum Step: Equatable { case restore, retry, giveUp }
    static let maxAttempts = 5

    /// `failedAttempts`: zero-height measurements so far, including this one.
    static func step(boundsHeight: CGFloat, failedAttempts: Int) -> Step {
        if boundsHeight > 0 { return .restore }
        return failedAttempts <= maxAttempts ? .retry : .giveUp
    }
}

/// [duo-fold] Value snapshots (scroll anchor, open panels) parked by a view that
/// is going away and taken by its replacement within `window` seconds. `take`
/// leaves a marker so the replacement can still tell it is a fold re-creation
/// after the value was consumed (`wasRecentlyParked`).
final class FoldSnapshotStore<Value> {
    private var values: [String: (value: Value, at: Date)] = [:]
    private var consumed: [String: Date] = [:]
    let window: TimeInterval
    private let now: () -> Date

    init(window: TimeInterval = 3, now: @escaping () -> Date = Date.init) {
        self.window = window
        self.now = now
    }

    func park(_ value: Value, for key: String) {
        prune()
        values[key] = (value, now())
        consumed[key] = nil
    }

    func peek(_ key: String) -> Value? {
        prune()
        return values[key]?.value
    }

    func take(_ key: String) -> Value? {
        prune()
        guard let entry = values.removeValue(forKey: key) else { return nil }
        consumed[key] = entry.at
        return entry.value
    }

    func discard(_ key: String) {
        values[key] = nil
        consumed[key] = nil
    }

    /// A value parked for `key` is pending, or was taken, within the window.
    func wasRecentlyParked(_ key: String) -> Bool {
        prune()
        return values[key] != nil || consumed[key] != nil
    }

    private func prune() {
        let t = now()
        values = values.filter { t.timeIntervalSince($0.value.at) < window }
        consumed = consumed.filter { t.timeIntervalSince($0.value) < window }
    }
}
