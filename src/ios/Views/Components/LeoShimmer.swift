import SwiftUI

/// [F3] The app's one loading shimmer (promoted from PaperclipShimmer): a
/// diagonal sheen over a running card or a placeholder row. Same technique as
/// the chat's ShimmerOverlay — one stable gradient moved by an offset
/// animation, never rebuilt per frame. Reduce Motion hides it entirely.
struct LeoShimmer: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var offsetX: CGFloat = -1

    var body: some View {
        GeometryReader { geo in
            let peak = colorScheme == .light ? 0.55 : 0.12
            Rectangle()
                .fill(LinearGradient(stops: [
                    .init(color: .white.opacity(0), location: 0.25),
                    .init(color: .white.opacity(peak), location: 0.5),
                    .init(color: .white.opacity(0), location: 0.75)
                ], startPoint: UnitPoint(x: 0, y: 1), endPoint: UnitPoint(x: 1, y: 0)))
                .frame(width: geo.size.width + geo.size.height, height: geo.size.height)
                .offset(x: offsetX * geo.size.width)
                .onAppear {
                    guard !reduceMotion else { offsetX = 0; return }
                    withAnimation(.linear(duration: 2.8).repeatForever(autoreverses: false)) { offsetX = 1 }
                }
        }
        .clipped()
        .allowsHitTesting(false)
        .opacity(reduceMotion ? 0 : 1)
    }
}
