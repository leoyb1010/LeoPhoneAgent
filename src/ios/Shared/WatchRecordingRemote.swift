//
//  WatchRecordingRemote.swift
//  MinisApp
//
//  [V-watch] 手表遥控 iPhone 录音:开始 / 停止 / 标记重点 / 查询状态。只传指令,不传音频。
//  消息格式两端共用这一个文件(App、手表、MinisTests 都编译它)。
//
//  另外放了手表消息里 requestId 的校验:手机拿 requestId 拼临时文件名,
//  手表(或冒充手表的对端)发来 `../../x` 时不能把文件写到别处。
//

import Foundation

enum WatchRecordingRemote {
    static let kind = "recordingControl"
    static let actionKey = "action"

    enum Action: String, CaseIterable, Sendable {
        case start, stop, mark, status, pause, resume
    }

    /// 手机回给手表的状态。
    struct Status: Equatable, Sendable {
        var isRecording: Bool
        var isPaused: Bool
        var elapsed: Double
        var highlightCount: Int
        var message: String?

        static let idle = Status(isRecording: false, isPaused: false, elapsed: 0, highlightCount: 0, message: nil)
    }

    static func payload(_ action: Action) -> [String: Any] {
        ["kind": kind, actionKey: action.rawValue]
    }

    /// 手机侧解析;不是这类消息返回 nil。
    static func action(from message: [String: Any]) -> Action? {
        guard message["kind"] as? String == kind,
              let raw = message[actionKey] as? String else { return nil }
        return Action(rawValue: raw)
    }

    static func reply(_ status: Status, ok: Bool) -> [String: Any] {
        let elapsed: Double = status.elapsed.isFinite ? max(0, status.elapsed) : 0
        var out: [String: Any] = [
            "ok": ok,
            "isRecording": status.isRecording,
            "isPaused": status.isPaused,
            "elapsed": elapsed,
            "highlights": max(0, status.highlightCount),
        ]
        if let message = status.message { out["message"] = String(message.prefix(80)) }
        return out
    }

    /// 手表侧解析回复。
    static func status(fromReply reply: [String: Any]) -> (ok: Bool, status: Status) {
        let status = Status(isRecording: reply["isRecording"] as? Bool ?? false,
                            isPaused: reply["isPaused"] as? Bool ?? false,
                            elapsed: (reply["elapsed"] as? Double).flatMap { $0.isFinite ? $0 : nil } ?? 0,
                            highlightCount: reply["highlights"] as? Int ?? 0,
                            message: reply["message"] as? String)
        return (reply["ok"] as? Bool ?? false, status)
    }

    static func elapsedText(_ seconds: Double) -> String {
        let total = Int(max(0, seconds.isFinite ? seconds : 0))
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%02d:%02d", m, s)
    }
}

/// [V-watch] 手表消息里的 requestId:只接受 1…64 位的字母、数字、`-`、`_`。
enum WatchRequestIdPolicy {
    static func isSafe(_ raw: String?) -> Bool {
        guard let raw, !raw.isEmpty, raw.utf8.count <= 64 else { return false }
        return raw.unicodeScalars.allSatisfy { s in
            (s.value >= 48 && s.value <= 57) || (s.value >= 65 && s.value <= 90)
                || (s.value >= 97 && s.value <= 122) || s == "-" || s == "_"
        }
    }

    /// 安全的原值;缺失或不安全时换成新的 UUID(回复会对不上,但绝不会拿它拼路径)。
    static func sanitized(_ raw: String?) -> String {
        isSafe(raw) ? raw! : UUID().uuidString
    }
}
