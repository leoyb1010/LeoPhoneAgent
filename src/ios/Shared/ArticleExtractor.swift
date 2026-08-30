//
//  ArticleExtractor.swift
//  MinisApp
//
//  [T-collections-fulltext] 把收藏的链接抽成正文,存下来能搜。
//
//  为什么不用 Safari 扩展:那要新开一个 target、走一整套扩展审核与权限
//  模型,而我们要的只是"把这个 URL 的正文拿到手"。主 app 里开一个不可见
//  的 WKWebView 加载页面,注入一段正文抽取脚本,拿结果——同样的结果,
//  没有新 target。
//
//  抽取算法用的是 Mozilla Readability 的思路(Firefox 阅读模式同款):
//  按标签语义与文本密度给候选容器打分,取分最高的那棵子树。这里内联了
//  一个精简实现,避免为几十行逻辑引入一个需要打包的 JS 依赖。
//
//  硬约束:整个过程有超时(页面可能永远不停加载),失败一律返回 nil,
//  收藏条目保持原样——全文是加分项,不是必需品。
//

import Foundation
import CFNetwork
import WebKit

enum TreasuryURLPolicy {
    static func isCandidate(_ url: URL) -> Bool {
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              url.user == nil, url.password == nil,
              let host = url.host?.lowercased(), !host.isEmpty else { return false }
        if host == "localhost" || host.hasSuffix(".localhost") || host.hasSuffix(".local") ||
            host.hasSuffix(".internal") || host.hasSuffix(".lan") || host.hasSuffix(".home") ||
            host.hasSuffix(".arpa") { return false }
        return true
    }

    static func allows(_ url: URL) async -> Bool {
        guard isCandidate(url), let host = url.host else { return false }
        return await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                continuation.resume(returning: resolvedAddressesArePublic(host))
            }
        }
    }

    private static func resolvedAddressesArePublic(_ host: String) -> Bool {
        let target = CFHostCreateWithName(nil, host as CFString).takeRetainedValue()
        var error = CFStreamError()
        guard CFHostStartInfoResolution(target, .addresses, &error) else { return false }
        var resolved = DarwinBoolean(false)
        guard let raw = CFHostGetAddressing(target, &resolved)?.takeUnretainedValue(),
              resolved.boolValue,
              let addresses = raw as? [Data], !addresses.isEmpty else { return false }
        return addresses.allSatisfy(isPublicSocketAddress)
    }

    private static func isPublicSocketAddress(_ data: Data) -> Bool {
        guard data.count >= MemoryLayout<sockaddr>.size else { return false }
        return data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress?.assumingMemoryBound(to: sockaddr.self) else { return false }
            switch Int32(base.pointee.sa_family) {
            case AF_INET:
                guard data.count >= MemoryLayout<sockaddr_in>.size else { return false }
                var address = sockaddr_in()
                _ = withUnsafeMutableBytes(of: &address) { data.copyBytes(to: $0) }
                let value = UInt32(bigEndian: address.sin_addr.s_addr)
                return isPublicIPv4([
                    Int((value >> 24) & 0xff), Int((value >> 16) & 0xff),
                    Int((value >> 8) & 0xff), Int(value & 0xff)
                ])
            case AF_INET6:
                guard data.count >= MemoryLayout<sockaddr_in6>.size else { return false }
                var address = sockaddr_in6()
                _ = withUnsafeMutableBytes(of: &address) { data.copyBytes(to: $0) }
                let octets = withUnsafeBytes(of: address.sin6_addr) { Array($0) }
                return isPublicIPv6(octets)
            default:
                return false
            }
        }
    }

    private static func isPublicIPv4(_ b: [Int]) -> Bool {
        guard b.count == 4 else { return false }
        return !(
            b[0] == 0 || b[0] == 10 || b[0] == 127 || b[0] >= 224 ||
            (b[0] == 100 && (64...127).contains(b[1])) ||
            (b[0] == 169 && b[1] == 254) ||
            (b[0] == 172 && (16...31).contains(b[1])) ||
            (b[0] == 192 && b[1] == 168) ||
            (b[0] == 192 && b[1] == 0 && (0...2).contains(b[2])) ||
            (b[0] == 198 && (18...19).contains(b[1])) ||
            (b[0] == 198 && b[1] == 51 && b[2] == 100) ||
            (b[0] == 203 && b[1] == 0 && b[2] == 113)
        )
    }

    private static func isPublicIPv6(_ b: [UInt8]) -> Bool {
        guard b.count == 16 else { return false }
        if b.allSatisfy({ $0 == 0 }) || b == Array(repeating: 0, count: 15) + [1] { return false }
        if (b[0] & 0xfe) == 0xfc || (b[0] == 0xfe && (b[1] & 0xc0) == 0x80) || b[0] == 0xff {
            return false
        }
        if b[0...3].elementsEqual([0x20, 0x01, 0x0d, 0xb8]) { return false }
        if b[0..<10].allSatisfy({ $0 == 0 }) && b[10] == 0xff && b[11] == 0xff {
            return isPublicIPv4(b[12...15].map(Int.init))
        }
        return true
    }
}

@MainActor
final class ArticleExtractor: NSObject {
    static let shared = ArticleExtractor()

    private var webView: WKWebView?
    private var continuation: CheckedContinuation<String?, Never>?
    private var timeoutTask: Task<Void, Never>?

    struct Article {
        let text: String
        let title: String?
    }

    /// 抽取一个 URL 的正文。超时 20 秒;任何失败返回 nil。
    /// 串行执行(一次一个)——批量抓取时由调用方排队,避免同时开多个 WebView。
    func extract(url: URL, timeout: TimeInterval = 20) async -> Article? {
        // 已有任务在跑就直接拒绝,不排队不并发(WebView 很重)
        guard continuation == nil else { return nil }
        guard await TreasuryURLPolicy.allows(url) else { return nil }
        let blocker = await Self.subresourceBlocker()

        let raw: String? = await withCheckedContinuation { cont in
            self.continuation = cont
            let config = WKWebViewConfiguration()
            // 页面脚本和网络子资源都不执行；正文抽取脚本由 App 自己注入。
            config.defaultWebpagePreferences.allowsContentJavaScript = false
            if let blocker { config.userContentController.add(blocker) }
            // 不要媒体自动播放,省电省流量
            config.allowsInlineMediaPlayback = false
            let web = WKWebView(frame: .init(x: 0, y: 0, width: 390, height: 844),
                                configuration: config)
            web.navigationDelegate = self
            self.webView = web
            web.load(URLRequest(url: url, timeoutInterval: timeout))

            self.timeoutTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                await MainActor.run { self?.finish(nil) }
            }
        }

        guard let raw, let data = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let text = obj["text"] as? String else { return nil }
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard cleaned.count >= 80 else { return nil }   // 太短多半是抽歪了
        return Article(text: String(cleaned.prefix(60_000)),
                       title: (obj["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private func finish(_ result: String?) {
        timeoutTask?.cancel()
        timeoutTask = nil
        webView?.navigationDelegate = nil
        webView?.stopLoading()
        webView = nil
        continuation?.resume(returning: result)
        continuation = nil
    }

    /// 正文抽取脚本。按 Readability 的思路做:先去掉导航/页脚/广告这类
    /// 明确不是正文的节点,再对候选容器按"段落文本量 - 链接文本量"打分,
    /// 取最高分那棵子树的纯文本。
    private static let extractionJS = """
    (function () {
      try {
        var KILL = 'script,style,noscript,nav,header,footer,aside,form,iframe,svg,button,' +
                   '[role=navigation],[role=banner],[role=complementary],[aria-hidden=true]';
        var doc = document.cloneNode(true);
        doc.querySelectorAll(KILL).forEach(function (n) { n.remove(); });

        var BAD = /(^|[\\s_-])(comment|share|related|sidebar|footer|header|nav|promo|ad|advert|banner|subscribe|newsletter|cookie|popup)([\\s_-]|$)/i;
        function textLen(el) { return (el.innerText || '').trim().length; }
        function linkLen(el) {
          var n = 0;
          el.querySelectorAll('a').forEach(function (a) { n += (a.innerText || '').length; });
          return n;
        }
        var best = null, bestScore = 0;
        var candidates = doc.querySelectorAll('article, main, [role=main], section, div');
        for (var i = 0; i < candidates.length; i++) {
          var el = candidates[i];
          var id = (el.id || '') + ' ' + (el.className || '');
          if (typeof id === 'string' && BAD.test(id)) continue;
          var t = textLen(el);
          if (t < 200) continue;
          var paras = el.querySelectorAll('p').length;
          var score = t - linkLen(el) * 2 + paras * 40;
          if (el.tagName === 'ARTICLE' || el.getAttribute('role') === 'main') score *= 1.5;
          if (score > bestScore) { bestScore = score; best = el; }
        }
        var node = best || doc.body;
        var text = (node.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
        var title = document.title || '';
        var og = document.querySelector('meta[property="og:title"]');
        if (og && og.content) title = og.content;
        return JSON.stringify({ text: text, title: title });
      } catch (e) {
        return JSON.stringify({ text: '', title: '' });
      }
    })();
    """

    private static func subresourceBlocker() async -> WKContentRuleList? {
        let rules = """
        [{"trigger":{"url-filter":".*","resource-type":["image","style-sheet","script","font","media","svg-document","raw"]},"action":{"type":"block"}}]
        """
        return await withCheckedContinuation { continuation in
            WKContentRuleListStore.default().compileContentRuleList(
                forIdentifier: "LeoTreasuryNoSubresources", encodedContentRuleList: rules
            ) { list, _ in
                continuation.resume(returning: list)
            }
        }
    }
}

extension ArticleExtractor: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard navigationAction.targetFrame?.isMainFrame != false,
              let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        Task {
            let allowed = await TreasuryURLPolicy.allows(url)
            decisionHandler(allowed ? .allow : .cancel)
            if !allowed { await MainActor.run { self.finish(nil) } }
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor in
            // 让首屏 JS 渲染一拍再抽,单页应用的正文常常是后填的
            try? await Task.sleep(nanoseconds: 800_000_000)
            guard self.continuation != nil else { return }
            let result = try? await webView.evaluateJavaScript(Self.extractionJS)
            self.finish(result as? String)
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        Task { @MainActor in self.finish(nil) }
    }

    nonisolated func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        Task { @MainActor in self.finish(nil) }
    }
}
