//
//  CollectionStore.swift
//  MinisApp
//
//  [T-collections] 全局收藏(三星式):任意 app 分享进来 → 存收藏库。
//
//  被主 app 与 ShareExtension 两个 target 共同编译:扩展里写入(收藏模式),
//  主 app 里读取/补抓元数据/管理。存储在 App Group 容器:
//    collections/items.json   条目(个人量级,JSON 足够)
//    collections/files/       附件(从分享容器移入,躲开 pendingShare 清理)
//    collections/thumbs/      链接封面缩略图(主 app 抓取后回填)
//
//  扩展进程内存上限 ~120MB,所以链接标题/封面一律不在扩展里抓,
//  由主 app 打开收藏页时惰性补抓(fetchMissingMetadata)。
//

import Foundation

struct CollectedItem: Codable, Identifiable, Equatable {
    enum Kind: String, Codable {
        case link, text, file
    }

    let id: String
    var kind: Kind
    /// link/text:内容本身;file:collections/files/ 里的文件名。
    var value: String
    /// [T-collections-deeplink] 短链解析后的真实地址。有它就能私有 scheme
    /// 直达 app,不必让浏览器先吃一次 302。老数据缺此键解码为 nil。
    var resolvedURL: String?
    /// 链接标题(主 app 元数据抓取后回填;文本类为 nil)。
    var title: String?
    /// collections/thumbs/ 里的缩略图文件名。
    var thumbnailFile: String?
    /// 来源徽标:小红书/微博/B站/网页/文本/图片…(由 URL host 推断)。
    var sourceLabel: String
    var createdAt: Date
    var tags: [String]
    var pinned: Bool
    /// Agent 一句话摘要(可选,回填)。
    var summary: String?
    /// 元数据抓取已尝试过(成败都算),避免每次进页重复抓。
    var metadataFetched: Bool

    init(kind: Kind, value: String, sourceLabel: String) {
        self.id = UUID().uuidString
        self.kind = kind
        self.value = value
        self.resolvedURL = nil
        self.title = nil
        self.thumbnailFile = nil
        self.sourceLabel = sourceLabel
        self.createdAt = Date()
        self.tags = []
        self.pinned = false
        self.summary = nil
        self.metadataFetched = false
    }
}

enum CollectionStore {
    static let defaultActionKey = "leo.share.defaultAction"   // ask | chat | collect

    // MARK: 目录

    static var directory: URL? {
        guard let base = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: SharedContainerStore.appGroupID) else { return nil }
        let dir = base.appendingPathComponent("collections", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static var filesDirectory: URL? {
        guard let dir = directory?.appendingPathComponent("files", isDirectory: true) else { return nil }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static var thumbsDirectory: URL? {
        guard let dir = directory?.appendingPathComponent("thumbs", isDirectory: true) else { return nil }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private static var indexURL: URL? {
        directory?.appendingPathComponent("items.json")
    }

    // MARK: 读写

    static func load() -> [CollectedItem] {
        guard let url = indexURL, let data = try? Data(contentsOf: url),
              let items = try? JSONDecoder().decode([CollectedItem].self, from: data) else {
            return []
        }
        return items
    }

    static func save(_ items: [CollectedItem]) {
        guard let url = indexURL, let data = try? JSONEncoder().encode(items) else { return }
        try? data.write(to: url, options: .atomic)
    }

    static func add(_ new: [CollectedItem]) {
        guard !new.isEmpty else { return }
        var items = load()
        items.insert(contentsOf: new, at: 0)
        save(items)
    }

    static func update(_ item: CollectedItem) {
        var items = load()
        guard let i = items.firstIndex(where: { $0.id == item.id }) else { return }
        items[i] = item
        save(items)
    }

    static func delete(ids: Set<String>) {
        var items = load()
        for item in items where ids.contains(item.id) {
            if item.kind == .file, let dir = filesDirectory {
                try? FileManager.default.removeItem(at: dir.appendingPathComponent(item.value))
            }
            if let thumb = item.thumbnailFile, let dir = thumbsDirectory {
                try? FileManager.default.removeItem(at: dir.appendingPathComponent(thumb))
            }
        }
        items.removeAll { ids.contains($0.id) }
        save(items)
    }

    // MARK: 从分享物料收藏(扩展进程调用)

    /// 把一次分享转成收藏条目。附件从 pendingShare 的共享目录**移动**到
    /// collections/files/(共享目录会被 app 清理,收藏必须自己保管文件)。
    @discardableResult
    static func ingest(_ share: PendingShare) -> Int {
        var new: [CollectedItem] = []
        for item in share.items {
            switch item.kind {
            case .inlineText:
                let text = item.value.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { continue }
                if let url = URL(string: text), let scheme = url.scheme?.lowercased(),
                   scheme == "http" || scheme == "https" {
                    new.append(CollectedItem(kind: .link, value: text,
                                             sourceLabel: sourceLabel(forHost: url.host)))
                } else {
                    new.append(CollectedItem(kind: .text, value: text, sourceLabel: "文本"))
                }
            case .attachment:
                guard let src = SharedContainerStore.sharedFileDirectory?
                          .appendingPathComponent(item.value),
                      let destDir = filesDirectory else { continue }
                let dest = destDir.appendingPathComponent(item.value)
                try? FileManager.default.removeItem(at: dest)
                do {
                    try FileManager.default.moveItem(at: src, to: dest)
                } catch {
                    // 移动失败(极少)退化为复制,宁可占空间不可丢内容
                    try? FileManager.default.copyItem(at: src, to: dest)
                }
                let isImage = ["jpg","jpeg","png","gif","webp","heic"]
                    .contains((item.value as NSString).pathExtension.lowercased())
                new.append(CollectedItem(kind: .file, value: item.value,
                                         sourceLabel: isImage ? "图片" : "文件"))
            }
        }
        add(new)
        return new.count
    }

    // MARK: 从一段文字收藏(剪贴板 / 快捷指令 / Siri)

    /// 收藏一段原始文字。很多 app(小红书、抖音)只提供"复制链接",
    /// 剪出来的是一整段文案:
    ///   `99 复制打开小红书,看看【标题…】 http://xhslink.com/xxx`
    /// 所以这里用 NSDataDetector 抽 URL,剩下的文字当标题——用户粘贴
    /// 整段即可,不必自己剪链接。
    /// 返回新增条数(0 = 空内容)。
    @discardableResult
    static func ingestText(_ raw: String) -> Int {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return 0 }

        let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        let match = detector?.firstMatch(in: text, range: range)

        guard let match, let url = match.url,
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            add([CollectedItem(kind: .text, value: text, sourceLabel: "文本")])
            return 1
        }

        var item = CollectedItem(kind: .link, value: url.absoluteString,
                                 sourceLabel: sourceLabel(forHost: url.host))
        // 链接之外的文字做临时标题(元数据抓到真标题后会被覆盖)。
        var leftover = text
        if let r = Range(match.range, in: text) {
            leftover.removeSubrange(r)
        }
        let caption = leftover
            .replacingOccurrences(of: "复制本条信息", with: "")
            .trimmingCharacters(in: CharacterSet(charactersIn: " ,,。;;、\n\t"))
        if !caption.isEmpty {
            item.title = String(caption.prefix(80))
        }
        add([item])
        return 1
    }

    // MARK: 来源推断

    static func sourceLabel(forHost host: String?) -> String {
        guard let host = host?.lowercased() else { return "网页" }
        let table: [(String, String)] = [
            ("xiaohongshu", "小红书"), ("xhslink", "小红书"),
            ("weibo", "微博"), ("bilibili", "B站"), ("b23.tv", "B站"),
            ("douyin", "抖音"), ("iesdouyin", "抖音"),
            ("zhihu", "知乎"), ("mp.weixin", "公众号"), ("weixin", "微信"),
            ("x.com", "X"), ("twitter", "X"),
            ("youtube", "YouTube"), ("youtu.be", "YouTube"),
            ("github", "GitHub"), ("taobao", "淘宝"), ("jd.com", "京东"),
            ("v2ex", "V2EX"), ("reddit", "Reddit"),
        ]
        for (needle, label) in table where host.contains(needle) {
            return label
        }
        return "网页"
    }
}
