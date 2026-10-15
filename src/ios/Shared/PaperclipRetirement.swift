//
//  PaperclipRetirement.swift
//  MinisApp
//
//  [T-paperclip-retired] 1.72 下架服务器任务(Paperclip)后,升级上来的设备第一次启动时清掉它留下的东西。
//  编进 App 和逻辑测试两个 target(纯 Foundation / WebKit / CoreSpotlight / UserNotifications)。
//

import CoreSpotlight
import Foundation
import UserNotifications
import WebKit


/// 老版本的服务器任务(Paperclip)在本机留下的东西:UserDefaults 里的服务器配置、草稿、状态缓存,
/// 每个服务器一份的网页登录数据(WKWebsiteDataStore),Spotlight 里的工单条目,以及完成通知。
/// 都不再有用,也不该继续占着用户的登录态。只跑一次;失败也不重试(下次启动不会再进来)。
enum PaperclipRetirement {
    static let doneKey = "leo.paperclip.retired.v1"
    static let profilesKey = "leo.paperclip.profiles.v1"
    static let spotlightDomain = "com.leoyuan.leophoneagent.paperclip"

    /// 要删的键:以 leo.paperclip. 开头的全部,外加旧的工作区开关。
    static func keysToRemove(in all: [String]) -> [String] {
        all.filter { $0.hasPrefix("leo.paperclip.") && $0 != doneKey } + ["leo.ios.executionBackend.v1"]
    }

    /// 旧配置里每个服务器的 id(网页数据按这个 id 分开存)。读不出来就当没有。
    static func profileIds(from data: Data?) -> [UUID] {
        guard let data,
              let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return list.compactMap { ($0["id"] as? String).flatMap(UUID.init(uuidString:)) }
    }

    /// 只清 UserDefaults(纯逻辑,逻辑测试直接调)。已经跑过返回 nil;否则返回要清网页数据的服务器 id。
    static func clearDefaultsOnce(_ defaults: UserDefaults) -> [UUID]? {
        guard !defaults.bool(forKey: doneKey) else { return nil }
        defaults.set(true, forKey: doneKey)
        let ids = profileIds(from: defaults.data(forKey: profilesKey))
        for key in keysToRemove(in: Array(defaults.dictionaryRepresentation().keys)) {
            defaults.removeObject(forKey: key)
        }
        return ids
    }

    /// App 启动时调用:清配置,再在后台清网页登录数据、Spotlight 和通知。
    /// 系统状态这一半只能在 App 里跑:逻辑测试没有宿主 App,碰 UNUserNotificationCenter 会让测试进程崩掉。
    static func runOnce(defaults: UserDefaults = .standard) {
        guard let ids = clearDefaultsOnce(defaults) else { return }
        Task { @MainActor in
            for id in ids {
                try? await WKWebsiteDataStore.remove(forIdentifier: id)
            }
            try? await CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: [spotlightDomain])
            let center = UNUserNotificationCenter.current()
            let delivered = await center.deliveredNotifications()
            let stale = delivered.map(\.request.identifier).filter { $0.hasPrefix("paperclip.") }
            if !stale.isEmpty { center.removeDeliveredNotifications(withIdentifiers: stale) }
            AppLogger(category: "PaperclipRetirement").info("cleaned profiles=\(ids.count) notifications=\(stale.count)")
        }
    }
}
