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

// MARK: - [duo] iPhone Duo chrome adapters (iOS 27.1 APIs, no-ops on 27.0)

/// [duo-bars] P0-3 interim (approved plan): on a closed iPhone Duo the system
/// lays the navigation bar out vertically beside the side-mounted Dynamic
/// Island, while the chat page's own chrome (title + model pill stack in the
/// principal item, composer, activity strip) stays horizontal — half vertical,
/// half horizontal. Until the chat header is rebuilt on system toolbar items
/// (P1-1), the chat page keeps horizontal bars. The vertical bar's side inset
/// goes away with it; the island side's remaining safe area is honored by the
/// default SwiftUI layout, which the chat page never opts out of horizontally.
/// Resolved per container (top of the stack / trailing-most split column), so
/// it is applied once on the chat root and never toggled with view state.
struct LeoHorizontalSystemBars: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 27.1, *) {
            content.toolbarVerticalBehavior(.disabled)
        } else {
            content
        }
    }
}

/// [duo-fold] P1-2: keeps a bottom-anchored floating control (composer card,
/// activity strip, ↑↓ discs, new-message pill) off the fold of a half-open
/// iPhone Duo. Reads the active `.division` regions over the control and pads
/// it onto one side (FoldAvoidance). Fully open or closed there is no active
/// division and nothing changes. Scrolling content is never moved.
struct FoldAvoidingControl: ViewModifier {
    @State private var applied = FoldInsets.zero

    func body(content: Content) -> some View {
        if #available(iOS 27.1, *) {
            content
                .padding(EdgeInsets(top: applied.top, leading: applied.leading,
                                    bottom: applied.bottom, trailing: applied.trailing))
                .onGeometryChange(for: FoldProbe.self) { proxy in
                    FoldProbe(size: proxy.size,
                              divisions: proxy.reservedRegions(kind: .division)
                                .filter(\.isActive).map(\.frame))
                } action: { probe in
                    let next = probe.divisions.isEmpty ? FoldInsets.zero
                        : FoldAvoidance.nextInsets(measured: probe.size, divisions: probe.divisions, applied: applied)
                    if next != applied { applied = next }
                }
        } else {
            content
        }
    }

    private struct FoldProbe: Equatable {
        let size: CGSize
        let divisions: [CGRect]
    }
}

/// [duo-corners] P1-3: surface for chrome near a screen edge. On iOS 27.1+ the
/// corners follow the display (`ConcentricRectangle`; the Duo's outer display
/// is 8 pt on the hinge side and 59 pt outside, the inner one 55 pt) and never
/// drop below the design radius; earlier systems keep the fixed radius.
struct LeoEdgeSurface<Fill: ShapeStyle>: ViewModifier {
    let fill: Fill
    let radius: CGFloat
    var style: RoundedCornerStyle = .continuous
    var stroke: Color? = nil
    var strokeWidth: CGFloat = 0.5

    func body(content: Content) -> some View {
        if #available(iOS 27.1, *) {
            let shape = ConcentricRectangle(corners: .concentric(minimum: .fixed(radius)), isUniform: false)
            content
                .background(shape.fill(fill))
                .clipShape(shape)
                .overlay { if let stroke { shape.stroke(stroke, lineWidth: strokeWidth) } }
        } else {
            let shape = RoundedRectangle(cornerRadius: radius, style: style)
            content
                .background(shape.fill(fill))
                .clipShape(shape)
                .overlay { if let stroke { shape.stroke(stroke, lineWidth: strokeWidth) } }
        }
    }
}
