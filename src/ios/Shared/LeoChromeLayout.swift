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
    static let barItemSpacing: CGFloat = 8
    static let edgeMargin: CGFloat = 16
    static let minimumCap: CGFloat = 96
    /// A title wider than this reads as a sentence, not a label (iPad full width).
    static let maximumCap: CGFloat = 520

    /// Width the centered principal item (title + model pill) may use without
    /// running into the leading or trailing bar items. The principal stays
    /// centered, so the wider side is reserved on both sides.
    static func principalCap(columnWidth: CGFloat, leadingItems: Int, trailingItems: Int) -> CGFloat {
        guard columnWidth > 0 else { return minimumCap }
        func side(_ n: Int) -> CGFloat {
            guard n > 0 else { return edgeMargin }
            return edgeMargin + CGFloat(n) * barItemWidth + CGFloat(n - 1) * barItemSpacing + barItemSpacing
        }
        let reserved = 2 * max(side(leadingItems), side(trailingItems))
        return min(maximumCap, max(minimumCap, columnWidth - reserved))
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
