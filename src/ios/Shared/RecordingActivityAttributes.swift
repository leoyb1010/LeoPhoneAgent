import ActivityKit
import AppIntents
import Foundation

/// [V-rec] 录音的灵动岛 / 锁屏卡片。App、AgentWidget、MinisTests 共同编译这个文件。
///
/// 计时不靠频繁推送:运行时卡片用 `timerReferenceDate`(= 推送时刻 − 已录时长)自己走秒,
/// 只有暂停 / 继续 / 标记 / 电平变化时才推一次(电平每 5 秒最多一次)。
@available(iOS 16.2, *)
struct RecordingActivityAttributes: ActivityAttributes {
    var recordingId: String
    var title: String

    struct ContentState: Codable, Hashable {
        var isPaused: Bool
        /// 已录时长(秒,不含暂停),推送时刻的值。
        var elapsed: Double
        /// 运行中:`timerReferenceDate` 起正计时即为已录时长。
        var timerReferenceDate: Date
        /// 0…1,粗粒度(10 档),只为卡片上的电平条。
        var level: Double
        var highlightCount: Int
        /// 「录音中」「已暂停」「来电暂停」之类,≤24 字。
        var statusText: String
    }
}

/// [V-rec] 卡片负载的上限:ActivityKit 对超过 4 KB 的状态静默丢弃更新,标题来自你输入,必须封顶。
enum RecordingActivityPayload {
    static let maxTitle = 40
    static let maxStatus = 24
    static let maxId = 64

    @available(iOS 16.2, *)
    static func attributes(recordingId: String, title: String) -> RecordingActivityAttributes {
        RecordingActivityAttributes(recordingId: String(recordingId.prefix(maxId)),
                                    title: cap(title, maxTitle))
    }

    @available(iOS 16.2, *)
    static func state(isPaused: Bool, elapsed: Double, level: Double, highlightCount: Int,
                      statusText: String, now: Date = Date()) -> RecordingActivityAttributes.ContentState {
        let e = elapsed.isFinite ? max(0, elapsed) : 0
        let l = level.isFinite ? min(1, max(0, level)) : 0
        return .init(isPaused: isPaused,
                     elapsed: e,
                     timerReferenceDate: now.addingTimeInterval(-e),
                     level: (l * 10).rounded() / 10,
                     highlightCount: min(max(0, highlightCount), 999),
                     statusText: cap(statusText, maxStatus))
    }

    static func cap(_ text: String, _ limit: Int) -> String {
        let single = text.split(whereSeparator: \.isNewline).joined(separator: " ")
        guard single.count > limit else { return single }
        return String(single.prefix(max(0, limit - 1))) + "…"
    }
}

/// [V-rec] 卡片按钮 → App 的跨进程信号。LiveActivityIntent 在 App 进程里执行
/// (录音中 App 一直活着),但这个文件也编进小组件,不能直接引用 App 里的录音控制器,
/// 所以和朗读按钮一样发 Darwin 通知。
enum RecordingActivityBridge {
    static let togglePauseNotification = "com.leoyuan.leophoneagent.recording.togglePause"
    static let stopNotification = "com.leoyuan.leophoneagent.recording.stop"
    static let markNotification = "com.leoyuan.leophoneagent.recording.mark"

    static func post(_ name: String) {
        CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(),
                                             CFNotificationName(name as CFString), nil, nil, true)
    }
}

@available(iOS 17.0, *)
struct RecordingTogglePauseIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "暂停或继续录音"
    static let description = IntentDescription("在灵动岛或锁屏上暂停 / 继续 LeoBot 的录音。")
    static let openAppWhenRun = false

    func perform() async throws -> some IntentResult {
        RecordingActivityBridge.post(RecordingActivityBridge.togglePauseNotification)
        return .result()
    }
}

@available(iOS 17.0, *)
struct RecordingStopIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "停止录音"
    static let description = IntentDescription("在灵动岛或锁屏上停止 LeoBot 的录音并保存。")
    static let openAppWhenRun = false

    func perform() async throws -> some IntentResult {
        RecordingActivityBridge.post(RecordingActivityBridge.stopNotification)
        return .result()
    }
}

@available(iOS 17.0, *)
struct RecordingMarkIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "标记录音重点"
    static let description = IntentDescription("在当前时刻给 LeoBot 的录音加一个重点标记。")
    static let openAppWhenRun = false

    func perform() async throws -> some IntentResult {
        RecordingActivityBridge.post(RecordingActivityBridge.markNotification)
        return .result()
    }
}
