import SwiftUI

// [chat-chrome] The capsule control used across the conversation chrome:
// header model pill, composer model / execution-target chips, rewrite.
//
// Rules (values in `LeoChromeMetrics`):
//  · footnote semibold label, 12pt icon, 9pt chevron, 5pt gaps, 10pt side padding
//  · 32pt visible capsule inside a 44pt hit area
//  · width capped by `LeoWidthCap`; the label degrades full name → short name →
//    short name truncated in the middle, so the distinguishing end of a model id
//    stays visible and neighbours (approval badge, rewrite) are never pushed out.

/// Proposes at most `cap` points of width to its single child.
struct LeoWidthCap: Layout {
    let cap: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        if let w = proposal.width {
            return child.sizeThatFits(ProposedViewSize(width: min(w, cap), height: proposal.height))
        }
        let ideal = child.sizeThatFits(ProposedViewSize(width: nil, height: proposal.height))
        guard ideal.width > cap else { return ideal }
        return child.sizeThatFits(ProposedViewSize(width: cap, height: proposal.height))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }
}

/// A single-line label that picks the widest spelling that fits, then
/// truncates the shortest one in the middle.
struct LeoAdaptiveText: View {
    let candidates: [String]

    init(_ name: String) {
        candidates = ModelNameCompaction.candidates(name)
    }

    init(candidates: [String]) {
        self.candidates = candidates.isEmpty ? [""] : candidates
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            Text(verbatim: candidates[0]).lineLimit(1).fixedSize()
            if candidates.count > 1 {
                Text(verbatim: candidates[1]).lineLimit(1).fixedSize()
            }
            Text(verbatim: candidates[candidates.count - 1])
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }
}

/// Label for a chrome capsule control. Wrap in `Button` / `Menu` with `.buttonStyle(.plain)`.
struct LeoChromePillLabel<Leading: View>: View {
    enum Surface { case fill, glass }

    let candidates: [String]
    var systemImage: String?
    var showsChevron = true
    var maxWidth: CGFloat = LeoChromeMetrics.modelPillMaxWidth
    var minWidth: CGFloat = LeoChromeMetrics.hitTarget
    var surface: Surface = .fill
    var tint: Color = .primary
    @ViewBuilder var leading: () -> Leading

    var body: some View {
        LeoWidthCap(cap: maxWidth) {
            HStack(spacing: LeoChromeMetrics.pillIconSpacing) {
                leading()
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: LeoChromeMetrics.pillIconSize, weight: .semibold))
                        .accessibilityHidden(true)
                }
                LeoAdaptiveText(candidates: candidates)
                    .layoutPriority(1)
                if showsChevron {
                    Image(systemName: "chevron.down")
                        .font(.system(size: LeoChromeMetrics.chevronSize, weight: .bold))
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                }
            }
            .font(.footnote.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, LeoChromeMetrics.pillHorizontalPadding)
            .frame(minWidth: minWidth, minHeight: LeoChromeMetrics.pillHeight)
            .background { capsule }
            .frame(minHeight: LeoChromeMetrics.hitTarget)
            .contentShape(Rectangle())
        }
    }

    @ViewBuilder
    private var capsule: some View {
        switch surface {
        case .fill:
            Capsule().fill(Color.primary.opacity(0.06))
        case .glass:
            Capsule().fill(.clear).glassEffect(.regular.interactive(), in: .capsule)
        }
    }
}

extension LeoChromePillLabel where Leading == EmptyView {
    init(_ title: String, systemImage: String? = nil, showsChevron: Bool = true,
         maxWidth: CGFloat = LeoChromeMetrics.modelPillMaxWidth,
         minWidth: CGFloat = LeoChromeMetrics.hitTarget,
         surface: Surface = .fill, tint: Color = .primary) {
        self.init(candidates: ModelNameCompaction.candidates(title), systemImage: systemImage,
                  showsChevron: showsChevron, maxWidth: maxWidth, minWidth: minWidth,
                  surface: surface, tint: tint, leading: { EmptyView() })
    }
}
