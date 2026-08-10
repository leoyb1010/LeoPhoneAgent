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
//  [T-reader] 打开策略只有两类去向,没有第三种:
//
//  A) 能直达原 app 里那条内容 → 跳 app(小红书笔记、B站视频、知乎回答…);
//  B) 其余一律**应用内阅读器**(SFSafariViewController)。
//
//  以前的兜底是 UIApplication.open(https),那等于把人甩去外部 Safari ——
//  公众号没有任何 deep-link 方案,于是**每次**都被甩出去;小红书短链解析
//  失败时也掉进同一条路。现在没有"甩出去"这个选项了。
//
//  另一条重要修正:只在能定位到**具体内容**时才跳 app。以前拿不到 id 就
//  返回 bilibili:// / snssdk1128:// 这类首页 scheme,用户被丢在 app 首页
//  自己找 —— 那比应用内直接读还糟。现在这些情况一律走阅读器。
//
//  短链仍然后台解析并缓存(HEAD 跟随重定向),以后每次点都是零延迟。
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
            return nil   // 定位不到这条视频,不如在阅读器里直接看
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
            return nil
        }

        if host.contains("weibo") {
            return URL(string: "sinaweibo://browser?url=\(url.absoluteString.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")")
        }

        if host.contains("douyin") {
            // 短链解析后形如 .../share/video/<id>,能定位才跳
            if let idx = segments.firstIndex(of: "video"), idx + 1 < segments.count {
                return URL(string: "snssdk1128://aweme/detail/\(segments[idx + 1])")
            }
            return nil
        }

        if host.contains("youtube") || host == "youtu.be" {
            return URL(string: url.absoluteString.replacingOccurrences(
                of: "https://", with: "youtube://"))
        }

        if host.contains("twitter") || host == "x.com" || host.hasSuffix(".x.com") {
            if let idx = segments.firstIndex(of: "status"), idx + 1 < segments.count {
                return URL(string: "twitter://status?id=\(segments[idx + 1])")
            }
            return nil
        }

        if host.contains("taobao") || host.contains("tmall") {
            return URL(string: "taobao://\(url.host ?? "")\(url.path)")
        }

        return nil
    }

    /// 这条收藏该怎么打开。
    enum Destination {
        /// 已经跳进原 app 了,调用方不用做别的。
        case openedApp
        /// 在应用内阅读器里打开这个地址。
        case readInApp(URL)
        /// 地址根本解析不出来。
        case unopenable
    }

    /// 决定去向并执行"跳 app"那一半。返回解析后的真实地址(调用方回写缓存)
    /// 与最终去向。
    ///
    /// 注意这里**不再**有 `UIApplication.open(https)` 这条路 —— 那是把人
    /// 甩去外部 Safari 的元凶。跳不了 app 就交给应用内阅读器。
    @MainActor
    static func plan(_ raw: String, cachedResolved: String?) async -> (resolved: String?, destination: Destination) {
        guard let original = URL(string: raw) else { return (nil, .unopenable) }

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

        // 能定位到原 app 里那条内容才跳
        if let scheme = appScheme(for: target), UIApplication.shared.canOpenURL(scheme) {
            if await UIApplication.shared.open(scheme) {
                return (newlyResolved, .openedApp)
            }
        }
        // 其余一律应用内阅读器。http(s) 之外的(mailto: 等)才交给系统。
        if let s = target.scheme?.lowercased(), s == "http" || s == "https" {
            return (newlyResolved, .readInApp(target))
        }
        _ = await UIApplication.shared.open(target)
        return (newlyResolved, .openedApp)
    }
}
