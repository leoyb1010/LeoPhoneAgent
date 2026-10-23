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
/// `visibleHeight` must not depend on the composer (it is the chat container's
/// height minus its top and bottom safe-area insets), or compacting would grow
/// the measurement and undo itself. The gap between the two thresholds absorbs
/// the nav bar minimizing on scroll.
enum ChatShortHeightRule {
    /// Below this a full composer leaves the list about two lines.
    static let enterBelow: CGFloat = 360
    /// Clears `enterBelow` by more than the nav bar's minimize step.
    static let exitAbove: CGFloat = 400

    /// Height half of the rule. `visibleHeight <= 0` = not measured yet: keep the answer.
    static func heightIsShort(visibleHeight: CGFloat, wasShort: Bool) -> Bool {
        guard visibleHeight > 0 else { return wasShort }
        return wasShort ? visibleHeight < exitAbove : visibleHeight < enterBelow
    }

    static func isShort(verticalSizeClassCompact: Bool, heightIsShort: Bool) -> Bool {
        verticalSizeClassCompact || heightIsShort
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
