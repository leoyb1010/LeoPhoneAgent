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
//  [T-ssrf] 抓取前必须过 SSRF 闸:这个抓取器会主动对用户收藏的任意
//  URL 发起请求。不设防的话,收藏一条 http://127.0.0.1:… 或内网地址,
//  app 就成了打内网的代理(读到路由器后台、本机服务、云元数据端点
//  169.254.169.254 等)。公网 URL 302 跳内网同样要拦 —— 所以解析后的
//  最终地址也要复检。

import Foundation
import LinkPresentation
import UIKit

enum LinkPreviewFetcher {
    struct Preview {
        var title: String?
        var image: UIImage?
    }

    /// 会拦截"跳向内网"的重定向的 session。URLSession.shared 会自动跟随
    /// 302,公网 URL 一跳就进内网,SSRF 闸只查首地址是拦不住的。
    private static let session: URLSession = {
        let delegate = RedirectGuard()
        return URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
    }()

    /// 移动端 UA:很多站(尤其公众号)对桌面 UA 返回"请在微信中打开"的空壳。
    private static let mobileUA =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 " +
        "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

    // MARK: - SSRF 闸

    /// 内网 / 环回 / 链路本地 / 云元数据地址一律不抓。返回 true = 危险。
    ///
    /// 这是**词法层**检查:host 本身就是内网地址的各种写法时直接拦。
    /// 只认"4 段十进制 IPv4"是不够的 —— 系统解析器同样接受
    /// http://2130706433/(纯十进制)、http://0177.0.0.1/(八进制)、
    /// http://0x7f.0.0.1/(十六进制)、http://[::ffff:169.254.169.254]/
    /// (IPv4-mapped IPv6),词法上不像内网,连出去全是 127.0.0.1 /
    /// 元数据端点。所以 IPv4 必须按 inet_aton 语义归一化,IPv6 必须
    /// 归一化后识别内嵌的 IPv4。
    /// 非 IP 的域名这里放行,DNS 归属由 isBlockedHostResolved 复核。
    static func isBlockedHost(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              var host = url.host?.lowercased(), !host.isEmpty else { return true }
        // 不同系统版本的 URL.host 对 IPv6 字面量可能带/不带方括号,统一剥掉
        if host.hasPrefix("["), host.hasSuffix("]") {
            host = String(host.dropFirst().dropLast())
        }
        // 直接域名黑名单
        if host == "localhost" || host.hasSuffix(".localhost")
            || host.hasSuffix(".local") || host == "metadata.google.internal" {
            return true
        }
        // IPv6 字面量。合法域名不含冒号 —— 含冒号又解析不出的,按危险
        // 处理(fail closed),不给畸形写法留缝。
        if host.contains(":") {
            let bare = host.split(separator: "%").first.map(String.init) ?? host   // 去掉 zone id
            var addr = in6_addr()
            guard inet_pton(AF_INET6, bare, &addr) == 1 else { return true }
            return isBlockedIPv6(addr)
        }
        // IPv4 字面量(含非点分十进制写法):归一化成功就按 32 位地址判段
        if let addr = normalizedIPv4(host) {
            return isBlockedIPv4(addr)
        }
        return false
    }

    /// inet_aton 语义的 IPv4 归一化:1~4 段,每段可以是十进制 / 八进制
    /// (前导 0)/ 十六进制(0x),最后一段填满剩余字节。解析失败返回 nil
    /// (说明不是 IP 字面量,当域名处理)。
    static func normalizedIPv4(_ host: String) -> UInt32? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard (1...4).contains(parts.count) else { return nil }
        var nums: [UInt64] = []
        for part in parts {
            guard let v = parseIPv4Part(part) else { return nil }
            nums.append(v)
        }
        let tail = nums.removeLast()
        for v in nums where v > 255 { return nil }   // 前面各段是单字节
        let tailByteCount = 4 - nums.count
        guard tailByteCount == 4 || tail < (1 << (8 * tailByteCount)) else { return nil }
        var addr: UInt64 = 0
        for v in nums { addr = addr << 8 | v }
        addr = addr << (8 * tailByteCount) | tail
        return UInt32(truncatingIfNeeded: addr)
    }

    /// inet_aton 的单段解析:0x/0X 开头按十六进制,前导 0 按八进制,
    /// 其余十进制。拒绝符号/空段(UInt64(_:radix:) 会接受 "+",这里不要)。
    private static func parseIPv4Part(_ s: String) -> UInt64? {
        var str = s
        var radix = 10
        if str.hasPrefix("0x") || str.hasPrefix("0X") {
            radix = 16
            str = String(str.dropFirst(2))
        } else if str.count > 1, str.hasPrefix("0") {
            radix = 8
            str = String(str.dropFirst())
        }
        guard !str.isEmpty, str.allSatisfy({ $0.isHexDigit }),
              let v = UInt64(str, radix: radix), v <= 0xFFFF_FFFF else { return nil }
        return v
    }

    /// 32 位地址的内网段判定,统一 CIDR 写法,一处维护:
    /// 127/8 环回、10/8、172.16/12、192.168/16 私网、169.254/16 链路本地
    /// (云元数据 169.254.169.254 在此)、100.64/10 CGNAT(尾镜/内网穿透
    /// 常用,同样能打到别人内网)、0/8 保留("0.0.0.0" 在多数栈上等于本机)、
    /// 224.0.0.0 起的组播/保留/广播。
    static func isBlockedIPv4(_ addr: UInt32) -> Bool {
        let blockedCIDRs: [(base: UInt32, bits: UInt32)] = [
            (0x7F00_0000, 8),    // 127.0.0.0/8
            (0x0A00_0000, 8),    // 10.0.0.0/8
            (0xAC10_0000, 12),   // 172.16.0.0/12
            (0xC0A8_0000, 16),   // 192.168.0.0/16
            (0xA9FE_0000, 16),   // 169.254.0.0/16
            (0x6440_0000, 10),   // 100.64.0.0/10 CGNAT
            (0x0000_0000, 8),    // 0.0.0.0/8
        ]
        for cidr in blockedCIDRs {
            let mask = ~UInt32(0) << (32 - cidr.bits)
            if addr & mask == cidr.base { return true }
        }
        if addr >= 0xE000_0000 { return true }   // 224.0.0.0 起:组播 + 保留 + 广播
        return false
    }

    /// IPv6 内网判定。关键是 IPv4-mapped(::ffff:a.b.c.d 与 ::ffff:xxxx:xxxx
    /// 两种写法 inet_pton 都归一成同样 16 字节):内嵌的 IPv4 抠出来走
    /// IPv4 检查,否则 [::ffff:169.254.169.254] 一穿就过。链路本地按
    /// fe80::/10 整段判 —— 旧版只匹配 "fe80" 字符串前缀,fe9x/feax/febx 全漏。
    static func isBlockedIPv6(_ addr: in6_addr) -> Bool {
        let b = withUnsafeBytes(of: addr) { Array($0) }   // 16 字节,网络序
        // 环回 ::1 与未指定 ::
        if b[0..<15].allSatisfy({ $0 == 0 }), b[15] <= 1 { return true }
        // 链路本地 fe80::/10
        if b[0] == 0xFE, b[1] & 0xC0 == 0x80 { return true }
        // 唯一本地 fc00::/7(fcxx / fdxx)
        if b[0] & 0xFE == 0xFC { return true }
        // IPv4-mapped ::ffff:0:0/96 与(已废弃但部分栈仍路由的)
        // IPv4-compatible ::/96:内嵌 IPv4 按 IPv4 段判
        if b[0..<10].allSatisfy({ $0 == 0 }),
           (b[10] == 0xFF && b[11] == 0xFF) || (b[10] == 0 && b[11] == 0) {
            let v4 = UInt32(b[12]) << 24 | UInt32(b[13]) << 16
                | UInt32(b[14]) << 8 | UInt32(b[15])
            return isBlockedIPv4(v4)
        }
        return false
    }

    /// [T-ssrf] DNS rebinding 预检:公网域名可以把解析记录指向 127.0.0.1
    /// 或 10.x,词法检查对它无能为力。发请求前先把域名解析一遍,任一地址
    /// 落在内网段就拒绝。
    /// 注意:这是预检,不是完备防御 —— 预检和真正连接是两次独立解析,
    /// 攻击者用超短 TTL 仍可能在两次之间换记录(TOCTOU 残余)。彻底解法
    /// 要在 socket 层固定已校验的 IP,URLSession 做不到;这里的目标是把
    /// 攻击门槛从"改一条 A 记录"抬高到"精确卡时序的 rebinding 服务"。
    /// 解析失败返回 false(放行):交给系统正常报错,不误伤离线/DNS 抖动。
    /// getaddrinfo 会阻塞,只能在后台线程调。
    static func hostResolvesToBlockedAddress(_ host: String) -> Bool {
        var hints = addrinfo()
        hints.ai_family = AF_UNSPEC
        hints.ai_socktype = SOCK_STREAM
        var list: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, nil, &hints, &list) == 0, let first = list else { return false }
        defer { freeaddrinfo(first) }
        var cursor: UnsafeMutablePointer<addrinfo>? = first
        while let info = cursor {
            if let sa = info.pointee.ai_addr {
                switch Int32(sa.pointee.sa_family) {
                case AF_INET:
                    let v4 = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
                        UInt32(bigEndian: $0.pointee.sin_addr.s_addr)
                    }
                    if isBlockedIPv4(v4) { return true }
                case AF_INET6:
                    let v6 = sa.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) {
                        $0.pointee.sin6_addr
                    }
                    if isBlockedIPv6(v6) { return true }
                default:
                    break
                }
            }
            cursor = info.pointee.ai_next
        }
        return false
    }

    /// 完整校验(词法 + DNS 预解析)的同步版。会阻塞,只给后台队列用
    /// (RedirectGuard 的 delegate 回调就在 session 后台队列上)。
    static func isBlockedHostWithDNS(_ url: URL) -> Bool {
        if isBlockedHost(url) { return true }
        guard let host = url.host?.lowercased(), !host.isEmpty else { return true }
        // IP 字面量在词法层已判过,不必再查 DNS
        if host.contains(":") || normalizedIPv4(host) != nil { return false }
        return hostResolvesToBlockedAddress(host)
    }

    /// 完整校验的 async 版:DNS 解析挪到后台线程,不卡调用方。
    static func isBlockedHostResolved(_ url: URL) async -> Bool {
        await Task.detached(priority: .utility) {
            isBlockedHostWithDNS(url)
        }.value
    }

    /// http → https(仅换 scheme)。已是 https 或非 http 原样返回。
    private static func upgradeToHTTPS(_ url: URL) -> URL {
        guard url.scheme?.lowercased() == "http",
              var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        comps.scheme = "https"
        return comps.url ?? url
    }

    static func fetch(_ rawURL: URL) async -> Preview {
        var result = Preview()
        // [T-ats-tighten] ATS 收紧后主 app 不再抓明文 http。但很多 http
        // 链接的站点其实支持 https(用户只是复制了 http 版)—— 先升级成
        // https 试,抓不到再说,把"收藏预览没了"的概率压到最低。
        let url = upgradeToHTTPS(rawURL)
        // SSRF 闸:词法 + DNS 预解析,必须在 LPMetadataProvider 之前做完。
        // 系统抓取器自己跟随重定向,不走下面带 RedirectGuard 的 session,
        // 请求进了它内部就再也拦不住 —— 所以初始 URL 在这里查到最严(含
        // 域名实际解析到的地址);重定向逃逸的兜底,靠 fetchHTML/loadImage
        // 走的受保护 session 补。
        guard !(await isBlockedHostResolved(url)) else { return result }

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
        // HTML 里解析出来的 URL 也可能指内网,同样过完整闸(词法 + DNS)
        guard !(await isBlockedHostResolved(url)) else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 12
        request.setValue(mobileUA, forHTTPHeaderField: "User-Agent")
        // 流式读:data(for:) 会把整个响应体收完才返回 —— 收藏一条视频/
        // 安装包直链时,那是几十 MB 的流量和内存尖峰,哪怕后面只 prefix。
        // bytes(for:) 读到 512KB 就断,预览要的 <head> 早就在里面了。
        guard let (bytes, resp) = try? await session.bytes(for: request),
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
        // 图片 URL 来自页面内容,完全不可信,同样过完整闸(词法 + DNS)
        guard !(await isBlockedHostResolved(url)) else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 12
        request.setValue(mobileUA, forHTTPHeaderField: "User-Agent")
        // 防盗链:很多图床(公众号 qpic、B站 hdslb、知乎 zhimg…)按 Referer
        // 拒绝跨站请求。统一带上来源页的 Referer —— 这是通用做法,不是
        // 给某个站开的特例。
        request.setValue(referer, forHTTPHeaderField: "Referer")
        // 图片也必须流式限额。data(for:) 会先把伪装成图片的超大响应完整
        // 收进内存，一条恶意收藏就能制造几十/几百 MB 峰值。12 MB 足够
        // 覆盖常见封面与原图，超过就停止读取并把这次预览当作无图。
        guard let (bytes, response) = try? await session.bytes(for: request),
              let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode) else { return nil }
        let mime = (http.mimeType ?? "").lowercased()
        guard mime.isEmpty || mime.hasPrefix("image/") else { return nil }
        let maxImageBytes = 12 * 1024 * 1024
        var data = Data()
        data.reserveCapacity(min(maxImageBytes, 2 * 1024 * 1024))
        do {
            for try await byte in bytes {
                data.append(byte)
                if data.count > maxImageBytes { return nil }
            }
        } catch {
            return nil
        }
        guard let image = UIImage(data: data) else { return nil }
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

/// 重定向到内网/环回一律掐断(返回 nil request = 取消跳转)。
/// 复检用与首查同一套完整校验(词法 + DNS 预解析)—— 只查词法的话,
/// 公网 URL 302 到"解析指向内网的公网域名"照样穿。delegate 回调本来
/// 就在 session 的后台队列上,阻塞式 getaddrinfo 可以直接调。
private final class RedirectGuard: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        if let url = request.url, !LinkPreviewFetcher.isBlockedHostWithDNS(url) {
            completionHandler(request)
        } else {
            completionHandler(nil)   // 跳向内网 → 取消
        }
    }
}
