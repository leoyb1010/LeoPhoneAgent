//
//  WatchContinueOnPhone.swift
//  MinisApp
//
//  [E4] 手表上问过的会话,在 iPhone 上接着问。
//
//  手表经 WCSession 发 `continueOnPhone`(带会话 id),手机发一条本地通知,点开就是那个会话
//  (手机正在前台时直接打开)。消息格式两端共用这一个文件(App、手表、MinisTests 都编译它)。
//

import Foundation

enum WatchContinueOnPhone {
    static let kind = "continueOnPhone"
    static let sessionIdKey = "sessionId"

    /// 手表 → 手机的消息体。
    static func payload(sessionId: String) -> [String: Any] {
        ["kind": kind, sessionIdKey: sessionId]
    }

    /// 手机侧解析:不是这类消息或没有会话 id 返回 nil。
    static func sessionId(from message: [String: Any]) -> String? {
        guard message["kind"] as? String == kind,
              let id = (message[sessionIdKey] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !id.isEmpty else { return nil }
        return id
    }

    /// 通知文案。会话被锁定或开着任务隐私时不显示标题。
    static func notificationText(sessionTitle: String?, hideTitle: Bool) -> (title: String, body: String) {
        let name = sessionTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let body = hideTitle || name.isEmpty ? "点开接着问刚才手表上的会话" : "点开接着问:\(name.prefix(60))"
        return ("在 iPhone 上继续", body)
    }

    /// 同一会话的通知用同一个标识,连点几次只留一条。
    static func notificationIdentifier(sessionId: String) -> String { "watch-continue-\(sessionId)" }
}
