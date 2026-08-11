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
        /// [T-notes] 纯笔记:没有链接,正文另存在 notes/<id>.md。
        /// 你的想法和你收藏的东西住在同一个库里。
        case note
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

    // ── [T-notes] 笔记能力 ─────────────────────────────────────
    /// 正文文件名(notes/<id>.md)。**正文绝不进这个 JSON** —— 一篇几万字
    /// 塞进来,每次读写整个收藏库都拖着它走,列表就卡了。
    var bodyFile: String?
    /// 我对这条收藏的批注。读完一篇文章写两句想法,和原文放在一起。
    var annotation: String?
    /// 归档:从主列表收起来,但不删。
    var archived: Bool
    /// 最后修改时间(笔记排序用;收藏类等于创建时间)。
    var updatedAt: Date

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
        self.bodyFile = nil
        self.annotation = nil
        self.archived = false
        self.updatedAt = Date()
    }

    /// 新建一条空笔记。
    static func newNote(title: String = "") -> CollectedItem {
        var item = CollectedItem(kind: .note, value: "", sourceLabel: "笔记")
        item.title = title.isEmpty ? nil : title
        item.bodyFile = "note-\(item.id).md"
        item.metadataFetched = true    // 笔记没有网页元数据可抓
        return item
    }

    // MARK: - 容错解码
    //
    // CollectionStore.load() 用的是 `try?`,解码一失败就返回空数组 ——
    // 也就是**整个收藏库在用户眼里消失**。所以新增字段一律 decodeIfPresent
    // 带默认值,老数据(没有 bodyFile/annotation/archived/updatedAt 这些键)
    // 必须照样解得出来。这不是防御性编程,这是不许弄丢用户数据。

    enum CodingKeys: String, CodingKey {
        case id, kind, value, resolvedURL, title, thumbnailFile, sourceLabel
        case createdAt, tags, pinned, summary, metadataFetched
        case bodyFile, annotation, archived, updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = (try? c.decode(Kind.self, forKey: .kind)) ?? .text
        value = (try? c.decode(String.self, forKey: .value)) ?? ""
        resolvedURL = try c.decodeIfPresent(String.self, forKey: .resolvedURL)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        thumbnailFile = try c.decodeIfPresent(String.self, forKey: .thumbnailFile)
        sourceLabel = (try? c.decode(String.self, forKey: .sourceLabel)) ?? "收藏"
        createdAt = (try? c.decode(Date.self, forKey: .createdAt)) ?? Date()
        tags = (try? c.decode([String].self, forKey: .tags)) ?? []
        pinned = (try? c.decode(Bool.self, forKey: .pinned)) ?? false
        summary = try c.decodeIfPresent(String.self, forKey: .summary)
        metadataFetched = (try? c.decode(Bool.self, forKey: .metadataFetched)) ?? false
        bodyFile = try c.decodeIfPresent(String.self, forKey: .bodyFile)
        annotation = try c.decodeIfPresent(String.self, forKey: .annotation)
        archived = (try? c.decode(Bool.self, forKey: .archived)) ?? false
        updatedAt = (try? c.decode(Date.self, forKey: .updatedAt)) ?? createdAt
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

    /// [T-notes] 笔记正文。单文件一篇,不进 items.json。
    static var notesDirectory: URL? {
        guard let dir = directory?.appendingPathComponent("notes", isDirectory: true) else { return nil }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// [T-notes] 版本快照。每次保存留一份,只保最近 10 版 ——
    /// 几 KB 的文件复制换"手滑删了能找回来",不值得上 diff 系统。
    static var versionsDirectory: URL? {
        guard let dir = directory?.appendingPathComponent("versions", isDirectory: true) else { return nil }
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
    //
    // 每个改动都是"整份读出 → 改 → 整份写回"。没有同步的话,后台补抓
    // 元数据的那条流水线(能跑一分多钟)和前台的编辑/导入/删除会互相
    // 覆盖:后台拿着一份过期数组,改完写回去,把这期间用户的编辑整份
    // 抹掉。所以读-改-写必须是一个不可分割的整体。
    //
    // 用串行队列而不是 actor:CollectionStore 被 ShareExtension 与主 app
    // 共同编译,调用方遍布同步上下文(含 nonisolated 的视图方法),
    // 改成 actor 要把所有调用点变成 async,牵动面太大。

    private static let ioQueue = DispatchQueue(label: "leo.collections.io")

    /// [T-notes] 正文文件的串行队列。声明在这里而不是 NoteBodyStore,
    /// 是因为本文件被 ShareExtension 一起编译而 NoteBodyStore 只在主 app ——
    /// 删除条目时正文的清理必须与正文保存排同一条队列(见 delete)。
    static let noteIOQueue = DispatchQueue(label: "leo.note.body", qos: .userInitiated)

    static func load() -> [CollectedItem] { ioQueue.sync { loadLocked() } }

    static func save(_ items: [CollectedItem]) { ioQueue.sync { saveLocked(items) } }

    // ioQueue 只序列化本进程;ShareExtension 与主 app 各有一条 ioQueue,
    // 两个进程并发读-改-写 items.json 还是 last-writer-wins,慢的一方
    // 整份写回会抹掉另一方刚存的条目。所以叶子 IO 处再包一层
    // NSFileCoordinator(系统级跨进程锁)。它在同进程重入会死锁 ——
    // 只允许在 ioQueue 内的这几个 Locked 方法里各包一层,绝不嵌套。

    /// 队列内部使用,自身不再加锁 —— 嵌套 sync 会死锁。
    private static func loadLocked() -> [CollectedItem] {
        guard let url = indexURL else { return [] }
        var items: [CollectedItem] = []
        var coordError: NSError?
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordError) { readURL in
            items = decodeItems(at: readURL)
        }
        // 协调失败(极少)退化为直读:宁可读到一份可能过期的数据,也不能
        // 返回空数组让调用方以为"库是空的"、下一次 save 把空写回去。
        if coordError != nil { items = decodeItems(at: url) }
        return items
    }

    private static func decodeItems(at url: URL) -> [CollectedItem] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        do {
            return try JSONDecoder().decode([CollectedItem].self, from: data)
        } catch {
            // 解码失败返回空 = 用户眼里"收藏全没了",而下一次 save 就会
            // 把空数组写回去,真的没了。先把原文件备份出来再说。
            if let backup = directory?.appendingPathComponent("items.corrupt.json") {
                try? data.write(to: backup, options: .atomic)
            }
            return []
        }
    }

    private static func saveLocked(_ items: [CollectedItem]) {
        guard let url = indexURL, let data = try? JSONEncoder().encode(items) else { return }
        var coordError: NSError?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing,
                                       error: &coordError) { writeURL in
            try? data.write(to: writeURL, options: .atomic)
        }
        if coordError != nil { try? data.write(to: url, options: .atomic) }
    }

    /// 读-改-写必须在**同一个**写协调块里完成才对另一个进程原子:
    /// 分开的 coordinate(reading) + coordinate(writing) 之间,对方照样
    /// 能插进来写一版,又回到 last-writer-wins。
    private static func mutateLocked(_ transform: (inout [CollectedItem]) -> Void) {
        guard let url = indexURL else { return }
        var coordError: NSError?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forMerging,
                                       error: &coordError) { activeURL in
            var items = decodeItems(at: activeURL)
            transform(&items)
            if let data = try? JSONEncoder().encode(items) {
                try? data.write(to: activeURL, options: .atomic)
            }
        }
        if coordError != nil {
            var items = decodeItems(at: url)
            transform(&items)
            if let data = try? JSONEncoder().encode(items) {
                try? data.write(to: url, options: .atomic)
            }
        }
    }

    static func add(_ new: [CollectedItem]) {
        guard !new.isEmpty else { return }
        ioQueue.sync {
            mutateLocked { items in
                items.insert(contentsOf: new, at: 0)
            }
        }
    }

    /// 条目级读-改-写:整个变换在队列内完成,写的是"库里此刻的最新版"。
    ///
    /// update(整条覆盖) 的问题:调用方在长 await(网络抓取能跑一分钟)
    /// 之前拿的副本,写回时会把期间用户的置顶/批注/归档整条回滚。
    /// 长路径一律用这个,只改自己的字段。
    static func mutate(id: String, _ transform: (inout CollectedItem) -> Void) {
        ioQueue.sync {
            mutateLocked { items in
                guard let i = items.firstIndex(where: { $0.id == id }) else { return }
                transform(&items[i])
            }
        }
    }

    static func update(_ item: CollectedItem) {
        ioQueue.sync {
            mutateLocked { items in
                guard let i = items.firstIndex(where: { $0.id == item.id }) else { return }
                items[i] = item
            }
        }
    }

    static func delete(ids: Set<String>) {
        ioQueue.sync {
            mutateLocked { items in
                for item in items where ids.contains(item.id) {
                    if item.kind == .file, let dir = filesDirectory {
                        try? FileManager.default.removeItem(at: dir.appendingPathComponent(item.value))
                    }
                    if let thumb = item.thumbnailFile, let dir = thumbsDirectory {
                        try? FileManager.default.removeItem(at: dir.appendingPathComponent(thumb))
                    }
                    // 正文与版本快照一起清:只删索引会在容器里留下永远没人
                    // 认领的文件,用户只会看到容量一直涨却找不到原因。
                    //
                    // 直接写文件操作而不调 NoteBodyStore —— 这个文件被
                    // ShareExtension 一起编译,而 NoteBodyStore 只在主 app 里。
                    if let body = item.bodyFile { removeBodyAndVersions(body) }
                }
                items.removeAll { ids.contains($0.id) }
            }
        }
    }

    /// 删正文与它的全部版本快照。
    ///
    /// 排进 noteIOQueue 而不是就地删:正文保存(NoteBodyStore)走的正是
    /// 这条串行队列,"关编辑器立刻删条目"时去抖存盘可能还排在队列里 ——
    /// 就地删完文件后,那次 save 会把正文重写出来,而索引里已没有这条,
    /// 文件成了永远没人认领的孤儿。同队列 FIFO 保证排队的 save 先跑、
    /// 随后的删除把它连同新落的版本快照一起清干净。
    private static func removeBodyAndVersions(_ fileName: String) {
        noteIOQueue.async {
            if let dir = notesDirectory {
                try? FileManager.default.removeItem(at: dir.appendingPathComponent(fileName))
            }
            guard let versionDir = versionsDirectory,
                  let all = try? FileManager.default.contentsOfDirectory(
                    at: versionDir, includingPropertiesForKeys: nil) else { return }
            let stem = (fileName as NSString).deletingPathExtension
            for url in all where url.lastPathComponent.hasPrefix(stem + "@") {
                try? FileManager.default.removeItem(at: url)
            }
        }
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
