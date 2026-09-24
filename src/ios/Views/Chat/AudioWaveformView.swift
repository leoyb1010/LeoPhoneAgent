import SwiftUI
import QuartzCore

/// 麦克风电平单独放在一个小对象里,只有波形视图订阅它。以前电平挂在聊天页订阅的对象上,
/// 每个音频缓冲(10–20 ms 一次)都让整个聊天页重算一遍;这里合并成最多每秒 30 次。
@MainActor
final class AudioLevelMeter: ObservableObject {
    @Published private(set) var levels: [Float]
    private var pending: [Float]?
    private var lastPublish: CFTimeInterval = 0
    private var flushScheduled = false
    private static let minInterval: CFTimeInterval = 1.0 / 30

    init(levels: [Float]) { self.levels = levels }

    func set(_ new: [Float]) {
        pending = new
        let elapsed = CACurrentMediaTime() - lastPublish
        if elapsed >= Self.minInterval {
            flush()
        } else if !flushScheduled {
            flushScheduled = true
            DispatchQueue.main.asyncAfter(deadline: .now() + (Self.minInterval - elapsed)) { [weak self] in
                self?.flushScheduled = false
                self?.flush()
            }
        }
    }

    private func flush() {
        guard let next = pending else { return }
        pending = nil
        lastPublish = CACurrentMediaTime()
        levels = next
    }
}

/// 订阅电平的波形:电平变化只重画这一小块。
struct LiveAudioWaveformView: View {
    @ObservedObject var meter: AudioLevelMeter
    var body: some View { AudioWaveformView(levels: meter.levels) }
}

struct AudioWaveformView: View {
    let levels: [Float]

    private let barWidth: CGFloat = 3
    private let barSpacing: CGFloat = 3
    private let minHeight: CGFloat = 4
    private let maxHeight: CGFloat = 32

    var body: some View {
        GeometryReader { geo in
            let availableWidth = geo.size.width * 0.8
            let barCount = max(1, Int(availableWidth / (barWidth + barSpacing)))
            let waveWidth = CGFloat(barCount) * barWidth + CGFloat(barCount - 1) * barSpacing
            HStack(spacing: barSpacing) {
                ForEach(0..<barCount, id: \.self) { i in
                    let level = sampleLevel(at: i, barCount: barCount)
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color.accentColor)
                        .frame(width: barWidth, height: minHeight + CGFloat(level) * (maxHeight - minHeight))
                        .animation(.easeOut(duration: 0.1), value: level)
                }
            }
            .frame(width: waveWidth, height: maxHeight)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(height: maxHeight)
    }

    private func sampleLevel(at index: Int, barCount: Int) -> Float {
        guard !levels.isEmpty else { return 0 }
        let mapped = Int(Float(index) / Float(barCount) * Float(levels.count))
        let clamped = min(mapped, levels.count - 1)
        return levels[clamped]
    }
}
