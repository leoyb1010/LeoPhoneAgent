//
//  SessionHandoff.swift
//  MinisApp
//
//  [E7] 接力(Handoff):iPhone 上开着某个会话,iPad / 另一台设备的程序坞出现接力图标,点开进入同一会话。
//
//  与「在新窗口打开会话」用同一个活动类型(Info.plist 的 NSUserActivityTypes 已登记),所以接收端
//  走同一条路:SceneDelegate → SessionWindow.accept → 这个窗口打开该会话;会话还没经 iCloud 同步
//  过来时等它出现(期间显示「正在同步」)。userInfo 只放会话 id,不带标题和内容。
//

import Foundation

enum SessionHandoff {
    static let activityType = "com.leoyuan.leophoneagent.session"
    static let sessionIdKey = "sessionId"

    static func makeActivity(sessionId: String) -> NSUserActivity {
        let activity = NSUserActivity(activityType: activityType)
        activity.userInfo = [sessionIdKey: sessionId]
        activity.requiredUserInfoKeys = [sessionIdKey]
        activity.isEligibleForHandoff = true
        activity.isEligibleForSearch = false
        activity.isEligibleForPublicIndexing = false
        activity.targetContentIdentifier = sessionId
        return activity
    }

    /// 正在广播的那一个;同一时刻只有一个会话可接力。
    @MainActor private static var current: NSUserActivity?

    /// 进入会话时调用;离开或会话被锁定时传 nil 停止广播。
    @MainActor
    static func advertise(sessionId: String?) {
        guard let sessionId, !sessionId.isEmpty else {
            current?.invalidate()
            current = nil
            return
        }
        if current?.userInfo?[sessionIdKey] as? String == sessionId { return }
        current?.invalidate()
        let activity = makeActivity(sessionId: sessionId)
        activity.becomeCurrent()
        current = activity
    }

    /// 只在自己正在广播这个会话时停止(另一个会话已接手广播就不动它)。
    @MainActor
    static func stop(sessionId: String?) {
        guard let sessionId, current?.userInfo?[sessionIdKey] as? String == sessionId else { return }
        advertise(sessionId: nil)
    }
}
