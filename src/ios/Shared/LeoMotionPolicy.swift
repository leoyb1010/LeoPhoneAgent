import Foundation

/// [WP-42] 动效体系里不依赖 SwiftUI 的那部分:节拍、状态条语义、Reduce Motion 的退化规则。
/// App 与逻辑测试共用;视图层(`LeoMotionEffects.swift`)只读这里的结论。
enum LeoMotionPolicy {
    /// 呼吸 / 思考扫光的周期(跨端 token `beat`,与 Mac `--leo-beat` 同值)。
    static let beat: Double = 1.6
    /// 「完成」那一下闪光的时长(token `dur.4`)。
    static let doneFlash: Double = 0.35

    /// 卡片左侧 2pt 状态条代表什么(颜色由视图层映射到 LeoTheme token)。
    enum StripStatus: Equatable {
        case running      // accent,呼吸
        case waiting      // attention(等你确认)
        case success      // success
        case failure      // destructive
        case cancelled    // 次要灰
        case hidden       // 不画

        var breathes: Bool { self == .running }
    }

    /// 工具卡状态 → 状态条。`status` 用字符串避免逻辑测试依赖聊天模型类型。
    static func strip(forToolStatus status: String?, waitingForApproval: Bool = false) -> StripStatus {
        if waitingForApproval { return .waiting }
        switch status {
        case "running", "streaming": return .running
        case "success": return .success
        case "failed": return .failure
        case "cancelled": return .cancelled
        default: return .hidden
        }
    }

    /// 一组已结束的工具步骤:有失败就红,有取消就灰,否则绿。
    static func strip(forGroupFailed failed: Int, cancelled: Int) -> StripStatus {
        if failed > 0 { return .failure }
        if cancelled > 0 { return .cancelled }
        return .success
    }

    /// 新增动效在 Reduce Motion 下一律退化成什么:位移/缩放/扫光都去掉,只保留淡入。
    enum Fallback: Equatable { case full, fadeOnly }
    static func fallback(reduceMotion: Bool) -> Fallback { reduceMotion ? .fadeOnly : .full }

    /// 「完成」只在 running → success 的那一次闪,翻历史记录时不闪。
    static func shouldFlashDone(wasFinished: Bool, isFinished: Bool, hasAppeared: Bool) -> Bool {
        hasAppeared && !wasFinished && isFinished
    }
}

/// 「发送飞入」的时序判定(UIKit 实现在 SendFlightAnimator)。
///
/// 发送时把输入框文字区域截一张快照，挂在窗口层;新用户气泡的 cell 布局好之后，用 spring
/// (response .30 / damping .82，和 LeoMotion.spring 一致)把快照飞到气泡位置，然后淡出、
/// 露出真实的 cell。消息是异步插入的：cell 可能还没建好、还没量好高度、还在屏幕外。
/// 等最多几帧;还不行就退化成淡入，不能让快照飞向错误的位置或者一直挂着。
enum SendFlightPolicy {
    static let springResponse: Double = 0.30
    static let springDamping: Double = 0.82
    /// 快照淡出 / 真实 cell 淡入的时长(token `dur.2`)。
    static let fadeDuration: Double = 0.18
    /// 发送之后这么久内插进来的那条用户消息才算「刚发的」(排队消息、同步来的消息不飞)。
    static let maxArmAge: TimeInterval = 1.2
    /// 等 cell 布局的最多帧数，超出就淡入。
    static let maxLayoutWaits = 3
    /// cell 出现后还在动(键盘收起、列表跟着滚)时最多再等这么多帧(约 0.5s，盖住键盘动画)，
    /// 位置连续两帧不变才起飞;等满了就按当前位置飞。以前一出现就飞，落点是键盘收起前的旧位置。
    static let maxSettleWaits = 30

    enum Decision: Equatable {
        case fly(to: CGRect)
        case fadeIn
        case wait
    }

    static func isFresh(armedAt: Date, now: Date) -> Bool {
        let age = now.timeIntervalSince(armedAt)
        return age >= 0 && age <= maxArmAge
    }

    /// - source: 快照在窗口里的位置(nil = 没截到)。
    /// - cellFrame: 新气泡 cell 在窗口里的位置(nil = 还没有 cell)。
    /// - waits: 已经等了几帧。
    /// - previousCellFrame: 上一帧看到的 cell 位置(nil = 第一次看到)。
    /// - bubbleText: 气泡里文字的排版尺寸(nil = 不知道，按整行落点)。
    static func decide(source: CGRect?, cellFrame: CGRect?, previousCellFrame: CGRect? = nil,
                       bubbleText: CGSize? = nil, window: CGRect,
                       reduceMotion: Bool, waits: Int) -> Decision {
        if reduceMotion { return .fadeIn }
        guard let source, source.width >= 1, source.height >= 1, window.intersects(source) else { return .fadeIn }
        guard let cell = cellFrame, cell.width >= 1, cell.height >= 1, window.intersects(cell) else {
            return waits < maxLayoutWaits ? .wait : .fadeIn
        }
        let settled = previousCellFrame.map { abs($0.minY - cell.minY) < 0.5 && abs($0.height - cell.height) < 0.5 } ?? false
        if !settled && waits < maxSettleWaits { return .wait }
        return .fly(to: landingRect(source: source, cell: cell, bubbleText: bubbleText))
    }

    /// 用户气泡的版式(与消息列表估算用户气泡高度的公式一致):cell 左右各留 16、左侧 Spacer 60，
    /// 气泡左右内边距合计 28、上下合计 20，贴 cell 右下(上方可能是附件块)。
    static func bubbleTextWidth(cellWidth: CGFloat) -> CGFloat { max(cellWidth - 32 - 60 - 28, 80) }

    static func bubbleFrame(cell: CGRect, text: CGSize) -> CGRect {
        let width = min(ceil(text.width) + 28, max(cell.width - 32 - 60, 1))
        let height = min(ceil(text.height) + 20, cell.height)
        return CGRect(x: cell.maxX - 16 - width, y: cell.maxY - height, width: width, height: height)
    }

    /// 知道气泡尺寸时:快照等比缩小到放得进气泡，左上对齐气泡(文字从那里开始)，不变形。
    static func landingRect(source: CGRect, cell: CGRect, bubbleText: CGSize?) -> CGRect {
        guard let bubbleText else { return landingRect(source: source, cell: cell) }
        let bubble = bubbleFrame(cell: cell, text: bubbleText)
        let scale = min(1, bubble.width / source.width, bubble.height / source.height)
        return CGRect(x: bubble.minX, y: bubble.minY, width: source.width * scale, height: source.height * scale)
    }

    /// 用户气泡贴在 cell 的右上角:快照落在 cell 的右上角，宽高不超过 cell 本身。
    static func landingRect(source: CGRect, cell: CGRect) -> CGRect {
        let width = min(source.width, cell.width)
        let height = min(source.height, cell.height)
        return CGRect(x: cell.maxX - width, y: cell.minY, width: width, height: height)
    }
}

extension SendFlightPolicy {
    /// SwiftUI `spring(response:dampingFraction:)` 换成 UIKit 质量-弹簧参数(质量 1):
    /// 刚度 = (2π / response)²,阻尼 = 4π · dampingFraction / response。
    static var springStiffness: Double { pow(2 * Double.pi / springResponse, 2) }
    static var springDampingCoefficient: Double { 4 * Double.pi * springDamping / springResponse }
}
