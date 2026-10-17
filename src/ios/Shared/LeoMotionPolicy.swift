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
