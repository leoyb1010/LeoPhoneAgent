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
import WebKit

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

        let raw: String? = await withCheckedContinuation { cont in
            self.continuation = cont
            let config = WKWebViewConfiguration()
            config.defaultWebpagePreferences.allowsContentJavaScript = true
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
}

extension ArticleExtractor: WKNavigationDelegate {
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
