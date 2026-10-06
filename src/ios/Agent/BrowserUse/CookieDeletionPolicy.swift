//
//  CookieDeletionPolicy.swift
//  MinisApp
//
//  Cookie 备份恢复要区分两种「cookie 不见了」:
//  - ITP 清理:WebKit 把一个站点的数据整站抹掉 —— 该站一个 cookie 都不剩。这是备份要恢复的。
//  - 站点自己删:登出、Set-Cookie 过期、CSRF 轮换 —— 该站其它 cookie 还在,只少了几个。
//    以前一律从备份里恢复,刚登出 60 秒内登录态又被塞回来。这类删除要尊重:从备份里去掉。
//
//  只比较本进程上一次同步时看到的在线 cookie(冷启动后的首次同步没有对照,照旧恢复)。
//

import Foundation

enum CookieDeletionPolicy {
    /// - Parameters:
    ///   - previous: 上次同步时在线的 cookie 键,按可注册域分组。
    ///   - current: 这次在线的 cookie 键,按可注册域分组。
    /// - Returns: 站点自己删掉的键(该站仍有其它在线 cookie)。整站消失的不算(按 ITP 清理处理,照旧恢复)。
    static func deliberatelyRemovedKeys(previous: [String: Set<String>],
                                        current: [String: Set<String>]) -> Set<String> {
        var removed = Set<String>()
        for (domain, before) in previous {
            guard let now = current[domain], !now.isEmpty else { continue }
            removed.formUnion(before.subtracting(now))
        }
        return removed
    }
}
