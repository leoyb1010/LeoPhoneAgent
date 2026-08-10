//
//  LeoReaderView.swift
//  MinisApp
//
//  [T-reader] 应用内阅读器。
//
//  为什么用 SFSafariViewController 而不是自己搭 WKWebView:
//  它跑在系统进程里,不占 app 内存,自带阅读模式、字号调节、查找、
//  分享和"在 Safari 中打开",还共享 Safari 的登录状态 —— 公众号、知乎
//  这些要登录才看得全的站,自己搭的 WebView 是登不进去的。
//  真正要自己渲染的场景(正文快照)另有 ArticleExtractor,不在这里。
//
//  entersReaderIfAvailable:文章类页面直接进阅读模式,去掉广告和导航,
//  这正是"收藏一篇文章回头读"想要的样子。
//

import SafariServices
import SwiftUI

struct LeoReaderView: UIViewControllerRepresentable {
    let url: URL
    /// 文章类内容默认进阅读模式;视频、商品页这类进了反而是坏的。
    var preferReaderMode: Bool = true

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let config = SFSafariViewController.Configuration()
        config.entersReaderIfAvailable = preferReaderMode
        config.barCollapsingEnabled = true
        let vc = SFSafariViewController(url: url, configuration: config)
        vc.dismissButtonStyle = .close
        vc.preferredControlTintColor = UIColor(named: "AccentColor") ?? .systemBlue
        return vc
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

/// 阅读器要打开的目标。`Identifiable` 让它能直接喂给 `.fullScreenCover(item:)`。
struct ReaderTarget: Identifiable {
    let id: UUID
    let url: URL
    let preferReaderMode: Bool

    /// 判断这个地址适不适合进阅读模式。
    ///
    /// 视频站、商品页进阅读模式会把内容本体(播放器、图集)剥掉,只剩
    /// 一段说明文字 —— 比不进还糟。文章站(公众号、知乎、博客)才该进。
    init(url: URL) {
        self.id = UUID()
        self.url = url
        let host = url.host?.lowercased() ?? ""
        let videoOrShop = ["bilibili", "douyin", "youtube", "youtu.be", "kuaishou",
                           "taobao", "tmall", "jd.com", "xiaohongshu", "weibo"]
        self.preferReaderMode = !videoOrShop.contains { host.contains($0) }
    }
}
