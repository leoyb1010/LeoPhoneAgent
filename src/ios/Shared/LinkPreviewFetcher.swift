//
//  LinkPreviewFetcher.swift
//  MinisApp
//
//  [T-preview] 链接预览:标题 + 封面。
//
//  为什么不只用 LPMetadataProvider:它只认标准 Open Graph 标签。公众号
//  文章的封面根本不在 og:image 里 —— 藏在页面内联脚本的 msg_cdn_url
//  变量中,系统抓取器拿到的是一片空白,于是收藏列表里公众号永远没图。
//
//  这是一条**通用**管线,不是给某个站开的后门:
//  1) 系统抓取器(对多数站最稳,带缓存)
//  2) 自己下 HTML,按优先级依次试 og:image → twitter:image → JSON-LD →
//     link[rel=image_src] → 站点特有变量(公众号 msg_cdn_url 之类)→
//     正文第一张够大的 <img>
//  3) 还是没有 → 站点图标(favicon / apple-touch-icon),至少有个标识
//  4) 全失败 → 明确返回空,UI 用来源色块 + 标题首字占位,绝不留白
//
//  标题同理:og:title → twitter:title → 站点变量 → <h1> → <title>。
//  任何链接都能进收藏,拿不到预览也不影响收藏本身成立。
//

import Foundation
import LinkPresentation
import UIKit

enum LinkPreviewFetcher {
    struct Preview {
        var title: String?
        var image: UIImage?
    }

    /// 移动端 UA:很多站(尤其公众号)对桌面 UA 返回"请在微信中打开"的空壳。
    private static let mobileUA =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 " +
        "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

    static func fetch(_ url: URL) async -> Preview {
        var result = Preview()

        // 1) 系统抓取器
        let provider = LPMetadataProvider()
        provider.timeout = 12
        if let metadata = try? await provider.startFetchingMetadata(for: url) {
            if let t = metadata.title, !t.isEmpty { result.title = t }
            if let imageProvider = metadata.imageProvider,
               let image = await loadProvidedImage(imageProvider) {
                result.image = image
            }
        }

        // 2) 缺什么补什么。公众号几乎必然走到这里。
        if result.title == nil || result.image == nil {
            if let html = await fetchHTML(url) {
                if result.title == nil { result.title = parseTitle(html) }
                if result.image == nil,
                   let imageURL = parseImageURL(html, base: url),
                   let image = await loadImage(imageURL, referer: url.absoluteString) {
                    result.image = image
                }
            }
        }
        return result
    }

    /// NSItemProvider → UIImage。CollectionsView 里那个同名助手是 private,
    /// 跨文件用不了,这里自带一份。
    private static func loadProvidedImage(_ provider: NSItemProvider) async -> UIImage? {
        await withCheckedContinuation { cont in
            provider.loadObject(ofClass: UIImage.self) { object, _ in
                cont.resume(returning: object as? UIImage)
            }
        }
    }

    // MARK: - HTML 兜底

    private static func fetchHTML(_ url: URL) async -> String? {
        var request = URLRequest(url: url)
        request.timeoutInterval = 12
        request.setValue(mobileUA, forHTTPHeaderField: "User-Agent")
        // 流式读:data(for:) 会把整个响应体收完才返回 —— 收藏一条视频/
        // 安装包直链时,那是几十 MB 的流量和内存尖峰,哪怕后面只 prefix。
        // bytes(for:) 读到 512KB 就断,预览要的 <head> 早就在里面了。
        guard let (bytes, resp) = try? await URLSession.shared.bytes(for: request),
              let http = resp as? HTTPURLResponse,
              // 不看状态码的话,403/404/风控页的 <title>("请在微信客户端
              // 打开""人机验证")会覆盖掉导入时截好的真标题,而
              // metadataFetched 置位后不再重试,标题就永久废在那儿。
              (200..<300).contains(http.statusCode) else { return nil }
        let mime = (http.mimeType ?? "").lowercased()
        guard mime.isEmpty || mime.hasPrefix("text/") || mime.contains("html") else { return nil }
        var capped = Data()
        capped.reserveCapacity(512 * 1024)
        do {
            for try await byte in bytes {
                capped.append(byte)
                if capped.count >= 512 * 1024 { break }
            }
        } catch {
            if capped.isEmpty { return nil }   // 读了一半断线:有多少解多少
        }
        // 公众号返回 UTF-8;少数老站是 GBK,解不出就放弃(总比乱码强)
        return String(data: capped, encoding: .utf8)
            ?? String(data: capped, encoding: .init(rawValue:
                CFStringConvertEncodingToNSStringEncoding(
                    CFStringEncoding(CFStringEncodings.GB_18030_2000.rawValue))))
    }

    private static func parseTitle(_ html: String) -> String? {
        for pattern in [
            #"<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']"#,
            #"<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']"#,
            // 公众号的标题变量
            #"<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']"#,
            // 站点特有变量(公众号 msg_title 等)
            #"var\s+msg_title\s*=\s*['"]([^'"]+)['"]"#,
            #"["']headline["']\s*:\s*["']([^"']{4,200})["']"#,   // JSON-LD
            #"<h1[^>]*>\s*([^<]{2,200}?)\s*</h1>"#,
            #"<title[^>]*>([^<]+)</title>"#,
        ] {
            if let value = firstMatch(pattern, in: html) {
                let cleaned = decodeEntities(value).trimmingCharacters(in: .whitespacesAndNewlines)
                if !cleaned.isEmpty { return cleaned }
            }
        }
        return nil
    }

    private static func parseImageURL(_ html: String, base: URL) -> URL? {
        // 通用标准在前,站点特有在后,正文首图与站点图标兜最后 ——
        // 顺序就是"命中率 × 质量"从高到低。
        for pattern in [
            #"<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']"#,
            #"<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::url)?["']"#,
            #"<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']"#,
            #"<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']"#,
            #"["']image["']\s*:\s*["'](https?://[^"']+)["']"#,          // JSON-LD
            #"<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']"#,
            // 站点特有变量(公众号 msg_cdn_url / cdn_url_1_1 等)
            #"var\s+msg_cdn_url\s*=\s*["']([^"']+)["']"#,
            #"var\s+cdn_url_1_1\s*=\s*["']([^"']+)["']"#,
            // 正文里第一张看起来够大的图(带宽高属性或常见大图路径)
            #"<img[^>]+(?:data-src|src)=["']([^"']+\.(?:jpe?g|png|webp)[^"']*)["'][^>]*width=["']?[3-9]\d{2,}"#,
            #"<img[^>]+(?:data-src|src)=["'](https?://[^"']+\.(?:jpe?g|png|webp)[^"']*)["']"#,
            // 最后:站点图标,至少给个标识而不是空白
            #"<link[^>]+rel=["'](?:apple-touch-icon[^"']*|icon|shortcut icon)["'][^>]+href=["']([^"']+)["']"#,
        ] {
            guard var value = firstMatch(pattern, in: html) else { continue }
            value = decodeEntities(value)
                .replacingOccurrences(of: "\\x26", with: "&")
                .replacingOccurrences(of: "\\/", with: "/")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if value.hasPrefix("//") { value = "https:" + value }
            if let url = URL(string: value), url.scheme != nil { return url }
            if let url = URL(string: value, relativeTo: base)?.absoluteURL { return url }
        }
        return nil
    }

    private static func loadImage(_ url: URL, referer: String) async -> UIImage? {
        var request = URLRequest(url: url)
        request.timeoutInterval = 12
        request.setValue(mobileUA, forHTTPHeaderField: "User-Agent")
        // 防盗链:很多图床(公众号 qpic、B站 hdslb、知乎 zhimg…)按 Referer
        // 拒绝跨站请求。统一带上来源页的 Referer —— 这是通用做法,不是
        // 给某个站开的特例。
        request.setValue(referer, forHTTPHeaderField: "Referer")
        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let image = UIImage(data: data) else { return nil }
        // 太小的多半是占位图标/像素图,当作没抓到,让上层继续往下试
        guard image.size.width >= 48, image.size.height >= 48 else { return nil }
        return image
    }

    // MARK: - 小工具

    private static func firstMatch(_ pattern: String, in text: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              match.numberOfRanges > 1,
              let range = Range(match.range(at: 1), in: text) else { return nil }
        return String(text[range])
    }

    private static func decodeEntities(_ s: String) -> String {
        s.replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&nbsp;", with: " ")
    }
}
