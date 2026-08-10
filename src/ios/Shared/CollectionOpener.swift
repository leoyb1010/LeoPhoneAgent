//
//  CollectionOpener.swift
//  MinisApp
//
//  [T-collections-deeplink] 收藏点开 = 直达原 App,不经浏览器。
//
//  为什么之前会"先闪浏览器再进 app":小红书这类分享出来的是短链
//  (xhslink.com/xxx),短链域名本身没有注册 Universal Link,必须先由
//  浏览器吃一次 302 跳到 xiaohongshu.com,那个域名才触发 app 接管。
//
//  三级直达策略:
//  1) 短链先在后台解析成真实地址(HEAD 跟随重定向),结果缓存进收藏条目,
//     以后每次点都是零延迟;
//  2) 真实地址映射到 app 私有 scheme(xhsdiscover:// 等)——命中就直接
//     进 app,浏览器一帧都不闪;
//  3) scheme 打不开(没装这个 app)才退回 https,让 Universal Link 或
//     浏览器兜底。
//

import Foundation
import UIKit

enum CollectionOpener {
    /// 需要先解析才知道真身的短链域名。
    private static let shortHosts = [
        "xhslink.com", "b23.tv", "t.cn", "v.douyin.com", "v.kuaishou.com",
        "dwz.cn", "url.cn", "m.tb.cn", "3.cn", "youtu.be",
    ]

    static func isShortLink(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        return shortHosts.contains { host == $0 || host.hasSuffix("." + $0) }
    }

    /// 跟随重定向拿到真实地址。失败原样返回——宁可走老路也不能打不开。
    static func resolve(_ url: URL) async -> URL {
        guard isShortLink(url) else { return url }
        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"
        request.timeoutInterval = 8
        // 短链服务大多按 UA 决定跳向 app 还是网页版,给一个移动端 UA。
        request.setValue(
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
            forHTTPHeaderField: "User-Agent")
        if let (_, response) = try? await URLSession.shared.data(for: request),
           let final = response.url, final != url {
            return final
        }
        // 少数服务器拒绝 HEAD,退回 GET(只要拿到 response.url 即可)。
        request.httpMethod = "GET"
        if let (_, response) = try? await URLSession.shared.data(for: request),
           let final = response.url {
            return final
        }
        return url
    }

    /// 真实地址 → app 私有 scheme。映射不到返回 nil。
    static func appScheme(for url: URL) -> URL? {
        guard let host = url.host?.lowercased() else { return nil }
        let segments = url.pathComponents.filter { $0 != "/" && !$0.isEmpty }

        // 小红书:/explore/<id>、/discovery/item/<id>
        if host.contains("xiaohongshu") {
            if let noteId = segments.last, noteId.count >= 16,
               noteId.allSatisfy({ $0.isHexDigit }) {
                return URL(string: "xhsdiscover://item/\(noteId)")
            }
            // 拿不到笔记 id 时,让小红书自己用内置浏览器打开原地址,
            // 仍然比系统浏览器接近"回到原处"。
            if let encoded = url.absoluteString.addingPercentEncoding(
                withAllowedCharacters: .alphanumerics) {
                return URL(string: "xhsdiscover://webview?url=\(encoded)")
            }
            return nil
        }

        // B 站:/video/BVxxxx 或 /video/avNNN
        if host.contains("bilibili") {
            if let vid = segments.first(where: { $0.hasPrefix("BV") || $0.hasPrefix("av") }) {
                return URL(string: "bilibili://video/\(vid)")
            }
            return URL(string: "bilibili://")
        }

        // 知乎:/question/<id>、/answer/<id>、/p/<id>
        if host.contains("zhihu") {
            if let idx = segments.firstIndex(of: "answer"), idx + 1 < segments.count {
                return URL(string: "zhihu://answers/\(segments[idx + 1])")
            }
            if let idx = segments.firstIndex(of: "question"), idx + 1 < segments.count {
                return URL(string: "zhihu://questions/\(segments[idx + 1])")
            }
            if let idx = segments.firstIndex(of: "p"), idx + 1 < segments.count {
                return URL(string: "zhihu://posts/\(segments[idx + 1])")
            }
            return URL(string: "zhihu://")
        }

        if host.contains("weibo") {
            return URL(string: "sinaweibo://browser?url=\(url.absoluteString.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")")
        }

        if host.contains("douyin") {
            return URL(string: "snssdk1128://")
        }

        if host.contains("youtube") || host == "youtu.be" {
            return URL(string: url.absoluteString.replacingOccurrences(
                of: "https://", with: "youtube://"))
        }

        if host.contains("twitter") || host == "x.com" || host.hasSuffix(".x.com") {
            if let idx = segments.firstIndex(of: "status"), idx + 1 < segments.count {
                return URL(string: "twitter://status?id=\(segments[idx + 1])")
            }
            return URL(string: "twitter://")
        }

        if host.contains("taobao") || host.contains("tmall") {
            return URL(string: "taobao://\(url.host ?? "")\(url.path)")
        }

        return nil
    }

    /// 打开一条收藏的原内容。返回解析后的真实地址(调用方可回写缓存),
    /// 以及是否真的跳进了某个 app。
    @discardableResult
    @MainActor
    static func open(_ raw: String, cachedResolved: String?) async -> (resolved: String?, openedApp: Bool) {
        guard let original = URL(string: raw) else { return (nil, false) }

        // 已缓存过真实地址就不再联网
        let target: URL
        var newlyResolved: String? = nil
        if let cachedResolved, let cached = URL(string: cachedResolved) {
            target = cached
        } else {
            let resolved = await resolve(original)
            target = resolved
            if resolved != original { newlyResolved = resolved.absoluteString }
        }

        // 1) 私有 scheme 直达
        if let scheme = appScheme(for: target), UIApplication.shared.canOpenURL(scheme) {
            let ok = await UIApplication.shared.open(scheme)
            if ok { return (newlyResolved, true) }
        }
        // 2) Universal Link:真实地址交给系统,装了对应 app 就直接进
        let ok = await UIApplication.shared.open(target)
        return (newlyResolved, ok)
    }
}
