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
