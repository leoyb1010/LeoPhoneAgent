//
//  CollectionStore.swift
//  MinisApp
//
//  [T-collections] 全局收藏(三星式):任意 app 分享进来 → 存收藏库。
//
//  被主 app 与 ShareExtension 两个 target 共同编译:扩展里写入(收藏模式),
//  主 app 里读取/补抓元数据/管理。存储在 App Group 容器:
//    collections/treasury.sqlite3   条目、任务、变更与检索索引
//    collections/files/       附件(从分享容器移入,躲开 pendingShare 清理)
//    collections/thumbs/      链接封面缩略图(主 app 抓取后回填)
//
//  扩展进程内存上限 ~120MB,所以链接标题/封面一律不在扩展里抓,
//  由主 app 打开收藏页时惰性补抓(fetchMissingMetadata)。
//

import CryptoKit
import Foundation
import SQLite3

enum TreasuryEnhancementPolicy {
    static func shouldReplaceTitle(current: String?, captured: String?) -> Bool {
        let normalizedCurrent = current?.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalizedCurrent?.isEmpty != false { return true }
        return current == captured
    }

    static func canRetry(kind: CollectedItem.Kind, errorCode: String?) -> Bool {
        kind == .link && errorCode == "article_extraction_unavailable"
    }
}

struct TreasuryLocalQuery: Equatable {
    let textQuery: String
    let kinds: Set<String>
    let processingStates: Set<String>
    let readingStates: Set<String>
    let tags: Set<String>
    let pinned: Bool?
    let archived: Bool
    let recent: Bool
    let after: Date?
    let before: Date?

    private static let allowedKinds = Set([
        "link", "text", "note", "image", "document", "audio", "video", "artifact"
    ])
    private static let allowedProcessing = Set([
        "saved", "queued", "processing", "ready", "partial", "failed"
    ])
    private static let allowedReading = Set(["none", "unread", "reading", "read"])

    static func parse(_ raw: String) -> TreasuryLocalQuery {
        var text: [String] = []
        var kinds = Set<String>()
        var processingStates = Set<String>()
        var readingStates = Set<String>()
        var tags = Set<String>()
        var pinned: Bool?
        var archived = false
        var recent = false
        var after: Date?
        var before: Date?

        for token in raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .prefix(512).split(whereSeparator: \.isWhitespace).map(String.init) {
            let pair = token.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
            guard pair.count == 2 else { text.append(token); continue }
            let name = pair[0].lowercased()
            let value = pair[1].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let values = value.split(separator: ",").map(String.init).filter { !$0.isEmpty }
            var consumed = false
            switch name {
            case "type", "kind":
                let valid = values.filter(allowedKinds.contains)
                kinds.formUnion(valid); consumed = !valid.isEmpty
            case "state", "process":
                let valid = values.filter(allowedProcessing.contains)
                processingStates.formUnion(valid); consumed = !valid.isEmpty
            case "read", "reading":
                let valid = values.filter(allowedReading.contains)
                readingStates.formUnion(valid); consumed = !valid.isEmpty
            case "tag":
                let valid = values.map { String($0.prefix(100)) }
                tags.formUnion(valid); consumed = !valid.isEmpty
            case "is":
                switch value {
                case "pinned": pinned = true; consumed = true
                case "unpinned": pinned = false; consumed = true
                case "archived": archived = true; consumed = true
                case "recent": recent = true; consumed = true
                default: break
                }
            case "after": after = parseDay(value); consumed = after != nil
            case "before": before = parseDay(value); consumed = before != nil
            default: break
            }
            if !consumed { text.append(token) }
        }
        return TreasuryLocalQuery(
            textQuery: text.joined(separator: " "), kinds: kinds,
            processingStates: processingStates, readingStates: readingStates,
            tags: tags, pinned: pinned, archived: archived, recent: recent,
            after: after, before: before
        )
    }

    private static func parseDay(_ value: String) -> Date? {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.isLenient = false
        return formatter.date(from: value)
    }
}

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
    var readingState: String
    var readingProgress: Double
    var lastOpenedAt: Date?
    var processingState: String
    var processingErrorCode: String?

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
        self.readingState = kind == .link ? "unread" : "none"
        self.readingProgress = 0
        self.lastOpenedAt = nil
        self.processingState = (kind == .text || kind == .note) ? "ready" : "saved"
        self.processingErrorCode = nil
    }

    init(id: String, kind: Kind, value: String, resolvedURL: String?, title: String?,
         thumbnailFile: String?, sourceLabel: String, createdAt: Date, tags: [String],
         pinned: Bool, summary: String?, metadataFetched: Bool, bodyFile: String?,
         annotation: String?, archived: Bool, updatedAt: Date,
         readingState: String = "none", readingProgress: Double = 0,
         lastOpenedAt: Date? = nil, processingState: String = "saved",
         processingErrorCode: String? = nil) {
        self.id = id
        self.kind = kind
        self.value = value
        self.resolvedURL = resolvedURL
        self.title = title
        self.thumbnailFile = thumbnailFile
        self.sourceLabel = sourceLabel
        self.createdAt = createdAt
        self.tags = tags
        self.pinned = pinned
        self.summary = summary
        self.metadataFetched = metadataFetched
        self.bodyFile = bodyFile
        self.annotation = annotation
        self.archived = archived
        self.updatedAt = updatedAt
        self.readingState = readingState
        self.readingProgress = readingProgress
        self.lastOpenedAt = lastOpenedAt
        self.processingState = processingState
        self.processingErrorCode = processingErrorCode
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
        case bodyFile, annotation, archived, updatedAt, readingState, readingProgress
        case lastOpenedAt, processingState, processingErrorCode
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
        readingState = (try? c.decode(String.self, forKey: .readingState))
            ?? (kind == .link ? "unread" : "none")
        readingProgress = min(1, max(0, (try? c.decode(Double.self, forKey: .readingProgress)) ?? 0))
        lastOpenedAt = try c.decodeIfPresent(Date.self, forKey: .lastOpenedAt)
        processingState = (try? c.decode(String.self, forKey: .processingState))
            ?? (metadataFetched ? "ready" : "saved")
        processingErrorCode = try c.decodeIfPresent(String.self, forKey: .processingErrorCode)
    }
}

extension CollectedItem {
    var treasuryKind: String {
        if kind == .text && sourceLabel.localizedCaseInsensitiveContains("artifact") {
            return "artifact"
        }
        guard kind == .file else { return kind.rawValue }
        if sourceLabel.localizedCaseInsensitiveContains("artifact") { return "artifact" }
        let ext = (value as NSString).pathExtension.lowercased()
        if ["jpg", "jpeg", "png", "gif", "webp", "heic"].contains(ext) { return "image" }
        if ["mp3", "m4a", "wav", "aac"].contains(ext) { return "audio" }
        if ["mp4", "mov", "m4v"].contains(ext) { return "video" }
        return "document"
    }
}

struct TreasureHighlight: Codable, Identifiable, Equatable {
    let id: String
    let itemID: String
    let quoteText: String
    let note: String?
    let startOffset: Int
    let endOffset: Int
    let pageNumber: Int?
    let createdAt: Date
    let updatedAt: Date
    let originDeviceID: String
}

/// Wire/import/export contract shared with Android and Mac. This is separate
/// from the legacy UI model so storage and sync fields can evolve without
/// forcing an immediate cross-platform UI rewrite.
struct TreasureItemContract: Codable, Equatable {
    let id: String
    let schemaVersion: Int
    let kind: String
    let title: String?
    let sourceURI: String?
    let sourceApp: String?
    let sourceLabel: String
    let originalText: String?
    let bodyRef: String?
    let previewRef: String?
    let mimeType: String?
    let byteCount: Int
    let contentDigest: String?
    let summary: String?
    let annotation: String?
    let tags: [String]
    let collectionIDs: [String]
    let pinned: Bool
    let archived: Bool
    let readingState: String
    let readingProgress: Double
    let createdAt: String
    let updatedAt: String
    let lastOpenedAt: String?
    let processingState: String
    let processingErrorCode: String?
    let syncState: String
    let originDeviceID: String
    let deletedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, kind, title, summary, annotation, tags, pinned, archived
        case schemaVersion = "schema_version"
        case sourceURI = "source_uri"
        case sourceApp = "source_app"
        case sourceLabel = "source_label"
        case originalText = "original_text"
        case bodyRef = "body_ref"
        case previewRef = "preview_ref"
        case mimeType = "mime_type"
        case byteCount = "byte_count"
        case contentDigest = "content_digest"
        case collectionIDs = "collection_ids"
        case readingState = "reading_state"
        case readingProgress = "reading_progress"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case lastOpenedAt = "last_opened_at"
        case processingState = "processing_state"
        case processingErrorCode = "processing_error_code"
        case syncState = "sync_state"
        case originDeviceID = "origin_device_id"
        case deletedAt = "deleted_at"
    }

    init(item: CollectedItem, originDeviceID: String, byteCount: Int = 0,
         contentDigest: String? = nil, sourceApp: String? = nil,
         mimeType: String? = nil, collectionIDs: [String] = [],
         readingState: String = "none", readingProgress: Double = 0,
         lastOpenedAt: String? = nil, processingState: String? = nil,
         processingErrorCode: String? = nil, syncState: String = "local",
         deletedAt: String? = nil) {
        id = item.id
        schemaVersion = 1
        kind = item.kind == .file ? Self.fileKind(item.value) : item.kind.rawValue
        title = item.title
        sourceURI = item.kind == .link ? item.value : nil
        self.sourceApp = sourceApp
        sourceLabel = item.sourceLabel
        originalText = item.kind == .text ? item.value : nil
        bodyRef = item.bodyFile.map { "notes/\($0)" }
            ?? (item.kind == .file ? "files/\(item.value)" : nil)
        previewRef = item.thumbnailFile.map { "thumbs/\($0)" }
        self.mimeType = mimeType
            ?? (item.kind == .file ? TreasurySQLiteStore.mimeTypeForContract(item.value) : nil)
        self.byteCount = byteCount
        self.contentDigest = contentDigest
        summary = item.summary
        annotation = item.annotation
        tags = item.tags
        self.collectionIDs = collectionIDs
        pinned = item.pinned
        archived = item.archived
        self.readingState = readingState
        self.readingProgress = readingProgress
        createdAt = Self.string(from: item.createdAt)
        updatedAt = Self.string(from: item.updatedAt)
        self.lastOpenedAt = lastOpenedAt
        self.processingState = processingState ?? (item.metadataFetched ? "ready" : "saved")
        self.processingErrorCode = processingErrorCode
        self.syncState = syncState
        self.originDeviceID = originDeviceID
        self.deletedAt = deletedAt
    }

    func collectedItem() -> CollectedItem? {
        guard !id.isEmpty, readingProgress >= 0, readingProgress <= 1 else { return nil }
        guard let created = Self.date(from: createdAt),
              let updated = Self.date(from: updatedAt) else { return nil }
        let legacyKind: CollectedItem.Kind
        let value: String
        switch kind {
        case "link":
            guard let sourceURI, TreasurySQLiteStore.normalizedURLKey(sourceURI) != nil else { return nil }
            legacyKind = .link; value = sourceURI
        case "note":
            legacyKind = .note; value = ""
        case "text", "artifact":
            legacyKind = .text; value = originalText ?? ""
        case "image", "document", "audio", "video":
            if let bodyRef, let name = Self.safeLastPathComponent(bodyRef) {
                legacyKind = .file; value = name
            } else if ["remote_only", "synced", "conflict"].contains(syncState) {
                legacyKind = .file; value = "remote-\(id)"
            } else {
                return nil
            }
        default: return nil
        }
        return CollectedItem(
            id: id, kind: legacyKind, value: value, resolvedURL: nil, title: title,
            thumbnailFile: previewRef.flatMap(Self.safeLastPathComponent),
            sourceLabel: sourceLabel, createdAt: created, tags: tags, pinned: pinned,
            summary: summary, metadataFetched: processingState == "ready",
            bodyFile: legacyKind == .note ? bodyRef.flatMap(Self.safeLastPathComponent) : nil,
            annotation: annotation, archived: archived, updatedAt: updated,
            readingState: readingState, readingProgress: readingProgress,
            lastOpenedAt: lastOpenedAt.flatMap(Self.date),
            processingState: processingState,
            processingErrorCode: processingErrorCode
        )
    }

    static func safeLastPathComponent(_ ref: String) -> String? {
        guard !ref.hasPrefix("/"), !ref.hasPrefix("\\"), !ref.contains("\0"),
              ref.range(of: #"^[A-Za-z]:[\\/]"#, options: .regularExpression) == nil else { return nil }
        let parts = ref.split(whereSeparator: { $0 == "/" || $0 == "\\" })
        guard !parts.isEmpty, !parts.contains(".."), !parts.contains(".") else { return nil }
        let value = String(parts.last!)
        return SharedContainerStore.isSafeFileName(value) ? value : nil
    }

    static func date(from value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        return ISO8601DateFormatter().date(from: value)
    }

    static func string(from date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static func fileKind(_ name: String) -> String {
        let ext = (name as NSString).pathExtension.lowercased()
        if ["jpg", "jpeg", "png", "gif", "webp", "heic"].contains(ext) { return "image" }
        if ["mp3", "m4a", "wav", "aac"].contains(ext) { return "audio" }
        if ["mp4", "mov", "m4v"].contains(ext) { return "video" }
        return "document"
    }
}

enum CollectionStore {
    typealias Job = TreasurySQLiteStore.Job

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

    static func fileURL(named name: String) -> URL? {
        guard SharedContainerStore.isSafeFileName(name), let directory = filesDirectory else { return nil }
        return directory.appendingPathComponent(name, isDirectory: false)
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

    private static var legacyIndexURL: URL? {
        directory?.appendingPathComponent("items.json")
    }

    // MARK: 读写
    // SQLite WAL 负责主 App 与 Share Extension 的跨进程并发。
    // 串行队列仅保证本进程同步调用顺序；旧 JSON 只在 SQLite
    // 临时无法打开时作为不丢数的恢复路径。

    private static let ioQueue = DispatchQueue(label: "leo.collections.io")

    /// [T-notes] 正文文件的串行队列，供主 App 的 NoteBodyStore 统一排序。
    /// 条目删除现在只写 tombstone，正文保留到后续可恢复的保留期清理。
    static let noteIOQueue = DispatchQueue(label: "leo.note.body", qos: .userInitiated)

    static func load() -> [CollectedItem] { ioQueue.sync { loadLocked() } }

    static func save(_ items: [CollectedItem]) { ioQueue.sync { saveLocked(items) } }

    /// 队列内部使用,自身不再加锁 —— 嵌套 sync 会死锁。
    private static func loadLocked() -> [CollectedItem] {
        guard let directory else { return [] }
        do {
            return try TreasurySQLiteStore(directory: directory).load()
        } catch {
            // Database/migration failures never become an empty library. The
            // untouched legacy JSON remains available as a recovery source.
            guard let url = legacyIndexURL else { return [] }
            return coordinatedLegacyLoad(at: url)
        }
    }

    private static func coordinatedLegacyLoad(at url: URL) -> [CollectedItem] {
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
        guard let directory else { return }
        do {
            try TreasurySQLiteStore(directory: directory).replaceActiveItems(items)
        } catch {
            mutateLegacyLocked { $0 = items }
        }
    }

    /// Only used if SQLite cannot be opened. Keeping this path coordinated
    /// prevents a temporary storage failure from dropping a Share Extension
    /// capture while still making SQLite the normal source of truth.
    private static func mutateLegacyLocked(_ transform: (inout [CollectedItem]) -> Void) {
        guard let url = legacyIndexURL else { return }
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
            guard let directory else { return }
            do {
                try TreasurySQLiteStore(directory: directory).add(new)
            } catch {
                mutateLegacyLocked { items in
                    items.insert(contentsOf: new, at: 0)
                }
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
            guard let directory else { return }
            do {
                try TreasurySQLiteStore(directory: directory).mutate(id: id, transform)
            } catch {
                mutateLegacyLocked { items in
                    guard let index = items.firstIndex(where: { $0.id == id }) else { return }
                    transform(&items[index])
                }
            }
        }
    }

    @discardableResult
    static func agentUpdate(_ item: CollectedItem, collectionIDs: [String]?) -> Bool {
        ioQueue.sync {
            guard let directory else { return false }
            do {
                return try TreasurySQLiteStore(directory: directory)
                    .agentUpdate(item, collectionIDs: collectionIDs)
            } catch {
                // Legacy JSON has no collection_ids field. Never report a
                // successful update while silently dropping the requested collection change.
                if collectionIDs != nil { return false }
                var found = false
                mutateLegacyLocked { items in
                    guard let index = items.firstIndex(where: { $0.id == item.id }) else { return }
                    items[index] = item
                    found = true
                }
                return found
            }
        }
    }

    /// Collection membership lives in the SQLite contract table rather than
    /// `CollectedItem`. Search must read it explicitly instead of advertising
    /// a collection filter that silently does nothing.
    static func collectionIDs(itemIDs: [String]) -> [String: Set<String>] {
        ioQueue.sync {
            guard let directory else { return [:] }
            return (try? TreasurySQLiteStore(directory: directory)
                .collectionIDs(itemIDs: itemIDs)) ?? [:]
        }
    }

    static func update(_ item: CollectedItem) {
        ioQueue.sync {
            guard let directory else { return }
            do {
                try TreasurySQLiteStore(directory: directory).update(item)
            } catch {
                mutateLegacyLocked { items in
                    guard let index = items.firstIndex(where: { $0.id == item.id }) else { return }
                    items[index] = item
                }
            }
        }
    }

    static func highlights(itemID: String) -> [TreasureHighlight] {
        ioQueue.sync {
            guard let directory else { return [] }
            return (try? TreasurySQLiteStore(directory: directory).highlights(itemID: itemID)) ?? []
        }
    }

    @discardableResult
    static func addHighlight(itemID: String, body: String, quoteText: String, note: String?,
                             startOffset: Int, endOffset: Int,
                             pageNumber: Int? = nil) -> TreasureHighlight? {
        ioQueue.sync {
            guard let directory else { return nil }
            let utf16Body = body as NSString
            guard startOffset >= 0, endOffset > startOffset,
                  endOffset <= utf16Body.length,
                  utf16Body.substring(with: NSRange(
                    location: startOffset, length: endOffset - startOffset
                  )) == quoteText else { return nil }
            let cleanNote = note?.trimmingCharacters(in: .whitespacesAndNewlines)
            let highlight = TreasureHighlight(
                id: UUID().uuidString, itemID: itemID, quoteText: String(quoteText.prefix(20_000)),
                note: cleanNote.flatMap { $0.isEmpty ? nil : String($0.prefix(20_000)) },
                startOffset: startOffset, endOffset: endOffset,
                pageNumber: pageNumber.flatMap { $0 > 0 ? $0 : nil },
                createdAt: Date(), updatedAt: Date(), originDeviceID: TreasurySQLiteStore.originDeviceID()
            )
            do {
                try TreasurySQLiteStore(directory: directory).addHighlight(highlight, body: body)
                return highlight
            } catch {
                return nil
            }
        }
    }

    static func deleteHighlight(id: String) {
        ioQueue.sync {
            guard let directory else { return }
            try? TreasurySQLiteStore(directory: directory).deleteHighlight(id: id)
        }
    }

    @discardableResult
    static func retryFailedJobs(itemID: String) -> Int {
        ioQueue.sync {
            guard let directory else { return 0 }
            return (try? TreasurySQLiteStore(directory: directory).retryFailedJobs(itemID: itemID)) ?? 0
        }
    }

    static func pendingJobs(limit: Int = 50, now: Date = Date()) -> [Job] {
        ioQueue.sync {
            guard let directory else { return [] }
            return (try? TreasurySQLiteStore(directory: directory)
                .pendingJobs(limit: limit, now: now)) ?? []
        }
    }

    @discardableResult
    static func claimJob(id: String, now: Date = Date()) -> Bool {
        ioQueue.sync {
            guard let directory else { return false }
            return (try? TreasurySQLiteStore(directory: directory)
                .claimJob(id: id, now: now)) ?? false
        }
    }

    static func completeJob(id: String, now: Date = Date()) {
        ioQueue.sync {
            guard let directory else { return }
            try? TreasurySQLiteStore(directory: directory).completeJob(id: id, now: now)
        }
    }

    static func failJob(id: String, errorCode: String, now: Date = Date()) {
        ioQueue.sync {
            guard let directory else { return }
            try? TreasurySQLiteStore(directory: directory)
                .failJob(id: id, errorCode: errorCode, now: now)
        }
    }

    static func delete(ids: Set<String>) {
        ioQueue.sync {
            guard let directory else { return }
            do {
                // Deletion is now a recoverable sync tombstone. Bodies and
                // assets are retained until a later retention cleanup.
                try TreasurySQLiteStore(directory: directory).tombstone(ids: ids)
            } catch {
                mutateLegacyLocked { items in
                    items.removeAll { ids.contains($0.id) }
                }
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

// MARK: - Phase 1 SQLite persistence

/// Native SQLite storage shared by the app and Share Extension. Connections
/// are intentionally short-lived; WAL + BEGIN IMMEDIATE provides cross-process
/// serialization without holding a database handle while doing extraction,
/// OCR, hashing, or network work.
final class TreasurySQLiteStore {
    private static let initializationLock = NSLock()

    struct MigrationReport: Equatable {
        let importedCount: Int
        let quarantinedCount: Int
        let didRun: Bool
    }

    struct Job: Equatable {
        let id: String
        let itemID: String
        let type: String
        let state: String
        let attemptCount: Int
        let nextAttemptAt: Date?
        let lastErrorCode: String?
    }

    struct Change: Equatable {
        let sequence: Int64
        let id: String
        let itemID: String
        let operation: String
        let updatedAt: Date
        let originDeviceID: String
        let payloadDigest: String
    }

    struct RemoteChange {
        let sequence: Int64
        let id: String
        let itemID: String
        let operation: String
        let updatedAt: Date
        let originDeviceID: String
        let payloadDigest: String
        let contract: TreasureItemContract?
    }

    struct SyncAsset {
        let fileURL: URL
        let mimeType: String
        let byteCount: Int
        let digest: String
        let removeAfterUpload: Bool
    }

    enum StoreError: Error {
        case open(String)
        case sqlite(String)
        case invalidImport
        case migrationCountMismatch(expected: Int, actual: Int)
    }

    let directory: URL
    let databaseURL: URL
    private let legacyURL: URL
    private var filesDirectoryURL: URL {
        directory.appendingPathComponent("files", isDirectory: true)
    }
    private(set) var migrationReport = MigrationReport(importedCount: 0,
                                                       quarantinedCount: 0,
                                                       didRun: false)

    init(directory: URL) throws {
        self.directory = directory
        databaseURL = directory.appendingPathComponent("treasury.sqlite3")
        legacyURL = directory.appendingPathComponent("items.json")
        try FileManager.default.createDirectory(at: directory,
                                                withIntermediateDirectories: true)
        Self.initializationLock.lock()
        defer { Self.initializationLock.unlock() }
        migrationReport = try withDatabase { db in
            try Self.createSchema(db)
            return try migrateLegacyJSONIfNeeded(db)
        }
    }

    func load(includeDeleted: Bool = false, limit: Int? = nil,
              offset: Int = 0) throws -> [CollectedItem] {
        try withDatabase { db in
            let predicate = includeDeleted ? "" : "WHERE deleted_at IS NULL"
            let pagination = limit.map {
                "LIMIT \(max(1, min($0, 500))) OFFSET \(max(0, offset))"
            } ?? ""
            let sql = """
            SELECT id, kind, legacy_value, resolved_url, title, preview_ref,
                   source_label, created_at, tags_json, pinned, summary,
                   metadata_fetched, body_ref, annotation, archived, updated_at,
                   reading_state, reading_progress, last_opened_at,
                   processing_state, processing_error_code
            FROM treasure_items \(predicate)
            ORDER BY pinned DESC, updated_at DESC, created_at DESC
            \(pagination)
            """
            return try Self.queryItems(db, sql: sql)
        }
    }

    func add(_ items: [CollectedItem]) throws {
        _ = try addReturningInsertedCount(items)
    }

    private func addReturningInsertedCount(_ items: [CollectedItem]) throws -> Int {
        let prepared = items.map(prepareForPersistence)
        return try withDatabase { db in
            var insertedCount = 0
            try Self.transaction(db) {
                for record in prepared {
                    if try Self.findDuplicateID(db, normalizedURL: record.normalizedURL,
                                                contentDigest: record.contentDigest) != nil {
                        continue
                    }
                    let alreadyExists = try Self.scalarInt(
                        db, sql: "SELECT COUNT(*) FROM treasure_items WHERE id=?",
                        bindings: [record.item.id]
                    ) > 0
                    try Self.upsert(record.item, normalizedURL: record.normalizedURL,
                                    contentDigest: record.contentDigest,
                                    filesDirectory: filesDirectoryURL, db: db)
                    try Self.enqueueDefaultJobs(for: record.item, db: db)
                    try Self.appendChange(for: record.item, operation: "upsert", db: db)
                    if !alreadyExists { insertedCount += 1 }
                }
            }
            return insertedCount
        }
    }

    func update(_ item: CollectedItem) throws {
        let record = prepareForPersistence(item)
        try withDatabase { db in
            try Self.transaction(db) {
                guard try Self.scalarInt(
                    db, sql: "SELECT COUNT(*) FROM treasure_items WHERE id=? AND deleted_at IS NULL",
                    bindings: [item.id]
                ) > 0 else { return }
                try Self.upsert(item, normalizedURL: record.normalizedURL,
                                contentDigest: record.contentDigest,
                                filesDirectory: filesDirectoryURL, db: db)
                try Self.appendChange(for: item, operation: "upsert", db: db)
            }
        }
    }

    func highlights(itemID: String) throws -> [TreasureHighlight] {
        try withDatabase { db in
            var stmt: OpaquePointer?
            try Self.prepare(db, """
                SELECT id,item_id,quote_text,note,start_offset,end_offset,page_number,
                       created_at,updated_at,origin_device_id
                FROM treasure_highlights
                WHERE item_id=? AND deleted_at IS NULL
                ORDER BY COALESCE(page_number,0),start_offset,created_at
                """, &stmt)
            defer { sqlite3_finalize(stmt) }
            Self.bind(itemID, stmt, 1)
            var values: [TreasureHighlight] = []
            while sqlite3_step(stmt) == SQLITE_ROW {
                values.append(TreasureHighlight(
                    id: Self.text(stmt, 0), itemID: Self.text(stmt, 1),
                    quoteText: Self.text(stmt, 2), note: Self.optionalText(stmt, 3),
                    startOffset: Int(sqlite3_column_int64(stmt, 4)),
                    endOffset: Int(sqlite3_column_int64(stmt, 5)),
                    pageNumber: sqlite3_column_type(stmt, 6) == SQLITE_NULL ? nil
                        : Int(sqlite3_column_int64(stmt, 6)),
                    createdAt: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 7)),
                    updatedAt: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 8)),
                    originDeviceID: Self.text(stmt, 9)
                ))
            }
            return values
        }
    }

    func addHighlight(_ highlight: TreasureHighlight, body: String) throws {
        guard highlight.startOffset >= 0, highlight.endOffset > highlight.startOffset,
              !highlight.quoteText.isEmpty else { throw StoreError.invalidImport }
        let utf16Body = body as NSString
        guard highlight.endOffset <= utf16Body.length,
              utf16Body.substring(with: NSRange(
                location: highlight.startOffset,
                length: highlight.endOffset - highlight.startOffset
              )) == highlight.quoteText else { throw StoreError.invalidImport }
        try withDatabase { db in
            try Self.transaction(db) {
                guard try Self.scalarInt(
                    db, sql: "SELECT COUNT(*) FROM treasure_items WHERE id=? AND deleted_at IS NULL",
                    bindings: [highlight.itemID]
                ) > 0 else { throw StoreError.invalidImport }
                var stmt: OpaquePointer?
                try Self.prepare(db, """
                    INSERT INTO treasure_highlights(
                      id,item_id,quote_text,note,start_offset,end_offset,page_number,
                      created_at,updated_at,origin_device_id,deleted_at
                    ) VALUES(?,?,?,?,?,?,?,?,?,?,NULL)
                    """, &stmt)
                defer { sqlite3_finalize(stmt) }
                Self.bind(highlight.id, stmt, 1); Self.bind(highlight.itemID, stmt, 2)
                Self.bind(highlight.quoteText, stmt, 3); Self.bind(highlight.note, stmt, 4)
                sqlite3_bind_int64(stmt, 5, Int64(highlight.startOffset))
                sqlite3_bind_int64(stmt, 6, Int64(highlight.endOffset))
                if let pageNumber = highlight.pageNumber { sqlite3_bind_int(stmt, 7, Int32(pageNumber)) }
                else { sqlite3_bind_null(stmt, 7) }
                sqlite3_bind_double(stmt, 8, highlight.createdAt.timeIntervalSince1970)
                sqlite3_bind_double(stmt, 9, highlight.updatedAt.timeIntervalSince1970)
                Self.bind(highlight.originDeviceID, stmt, 10)
                try Self.stepDone(db, stmt)
                try Self.touchItemAndAppendChange(highlight.itemID, at: highlight.updatedAt, db: db)
            }
        }
    }

    func deleteHighlight(id: String) throws {
        try withDatabase { db in
            try Self.transaction(db) {
                var lookup: OpaquePointer?
                try Self.prepare(db, "SELECT item_id FROM treasure_highlights WHERE id=? AND deleted_at IS NULL", &lookup)
                Self.bind(id, lookup, 1)
                guard sqlite3_step(lookup) == SQLITE_ROW else { sqlite3_finalize(lookup); return }
                let itemID = Self.text(lookup, 0)
                sqlite3_finalize(lookup)
                let now = Date()
                var stmt: OpaquePointer?
                try Self.prepare(db, "UPDATE treasure_highlights SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL", &stmt)
                defer { sqlite3_finalize(stmt) }
                sqlite3_bind_double(stmt, 1, now.timeIntervalSince1970)
                sqlite3_bind_double(stmt, 2, now.timeIntervalSince1970)
                Self.bind(id, stmt, 3)
                try Self.stepDone(db, stmt)
                try Self.touchItemAndAppendChange(itemID, at: now, db: db)
            }
        }
    }

    func mutate(id: String, _ transform: (inout CollectedItem) -> Void) throws {
        try withDatabase { db in
            try Self.transaction(db) {
                guard var item = try Self.queryItems(
                    db,
                    sql: """
                    SELECT id, kind, legacy_value, resolved_url, title, preview_ref,
                           source_label, created_at, tags_json, pinned, summary,
                           metadata_fetched, body_ref, annotation, archived, updated_at,
                           reading_state, reading_progress, last_opened_at,
                           processing_state, processing_error_code
                    FROM treasure_items WHERE id = ? AND deleted_at IS NULL
                    """,
                    bindings: [id]
                ).first else { return }
                transform(&item)
                let record = prepareForPersistence(item)
                try Self.upsert(item, normalizedURL: record.normalizedURL,
                                contentDigest: record.contentDigest,
                                filesDirectory: filesDirectoryURL, db: db)
                try Self.appendChange(for: item, operation: "upsert", db: db)
            }
        }
    }

    func agentUpdate(_ item: CollectedItem, collectionIDs: [String]?) throws -> Bool {
        try withDatabase { db in
            var updated = false
            try Self.transaction(db) {
                guard try Self.scalarInt(
                    db, sql: "SELECT COUNT(*) FROM treasure_items WHERE id=? AND deleted_at IS NULL",
                    bindings: [item.id]
                ) > 0 else { return }
                let record = prepareForPersistence(item)
                try Self.upsert(item, normalizedURL: record.normalizedURL,
                                contentDigest: record.contentDigest,
                                filesDirectory: filesDirectoryURL, db: db)
                if let collectionIDs {
                    let normalized = Array(Set(collectionIDs)).sorted()
                    let encoded = (try? String(data: JSONEncoder().encode(normalized),
                                               encoding: .utf8)) ?? "[]"
                    var stmt: OpaquePointer?
                    try Self.prepare(db, "UPDATE treasure_items SET collection_ids_json=? WHERE id=?", &stmt)
                    defer { sqlite3_finalize(stmt) }
                    Self.bind(encoded, stmt, 1)
                    Self.bind(item.id, stmt, 2)
                    try Self.stepDone(db, stmt)
                }
                try Self.appendChange(for: item, operation: "upsert", db: db)
                updated = true
            }
            return updated
        }
    }

    func collectionIDs(itemIDs: [String]) throws -> [String: Set<String>] {
        let uniqueIDs = Array(Set(itemIDs.filter { !$0.isEmpty }))
        guard !uniqueIDs.isEmpty else { return [:] }
        return try withDatabase { db in
            var memberships: [String: Set<String>] = [:]
            // Stay below SQLite's host-parameter ceiling without silently
            // dropping collection membership for libraries larger than 500 rows.
            for start in stride(from: 0, to: uniqueIDs.count, by: 400) {
                let end = min(start + 400, uniqueIDs.count)
                let batch = uniqueIDs[start..<end]
                let placeholders = batch.map { _ in "?" }.joined(separator: ",")
                var stmt: OpaquePointer?
                try Self.prepare(
                    db,
                    "SELECT id,collection_ids_json FROM treasure_items WHERE deleted_at IS NULL AND id IN (\(placeholders))",
                    &stmt
                )
                defer { sqlite3_finalize(stmt) }
                for (offset, id) in batch.enumerated() {
                    Self.bind(id, stmt, Int32(offset + 1))
                }
                while sqlite3_step(stmt) == SQLITE_ROW {
                    let values = (try? JSONDecoder().decode(
                        [String].self, from: Data(Self.text(stmt, 1).utf8)
                    )) ?? []
                    memberships[Self.text(stmt, 0)] = Set(values)
                }
            }
            return memberships
        }
    }

    func replaceActiveItems(_ items: [CollectedItem]) throws {
        let prepared = items.map(prepareForPersistence)
        let activeIDs = Set(items.map(\.id))
        try withDatabase { db in
            try Self.transaction(db) {
                let existing = try Self.stringColumn(
                    db, sql: "SELECT id FROM treasure_items WHERE deleted_at IS NULL"
                )
                for record in prepared {
                    try Self.upsert(record.item, normalizedURL: record.normalizedURL,
                                    contentDigest: record.contentDigest,
                                    filesDirectory: filesDirectoryURL, db: db)
                    try Self.appendChange(for: record.item, operation: "upsert", db: db)
                }
                try Self.tombstone(existing.filter { !activeIDs.contains($0) }, db: db)
            }
        }
    }

    func tombstone(ids: Set<String>) throws {
        try withDatabase { db in
            try Self.transaction(db) { try Self.tombstone(Array(ids), db: db) }
        }
    }

    func pendingJobs(limit: Int = 50, now: Date = Date()) throws -> [Job] {
        try withDatabase { db in
            // A process can be killed after claiming a job. Without leasing,
            // that row remains `processing` forever and neither automatic nor
            // explicit retries can see it. Reclaim only work whose heartbeat
            // has been stale for 30 minutes, longer than the bounded metadata
            // and extraction operations used by the main app.
            let staleCutoff = now.addingTimeInterval(-30 * 60).timeIntervalSince1970
            var recovery: OpaquePointer?
            try Self.prepare(db, """
                UPDATE treasure_jobs
                SET state=CASE WHEN attempt_count >= 5 THEN 'failed' ELSE 'queued' END,
                    next_attempt_at=NULL,updated_at=?,last_error_code='unknown'
                WHERE state='processing' AND updated_at <= ?
                """, &recovery)
            sqlite3_bind_double(recovery, 1, now.timeIntervalSince1970)
            sqlite3_bind_double(recovery, 2, staleCutoff)
            try Self.stepDone(db, recovery)
            sqlite3_finalize(recovery)

            var recoverItems: OpaquePointer?
            try Self.prepare(db, """
                UPDATE treasure_items
                SET processing_state=CASE
                      WHEN EXISTS(SELECT 1 FROM treasure_jobs j
                                  WHERE j.item_id=treasure_items.id
                                    AND j.state='failed' AND j.attempt_count >= 5)
                      THEN 'failed' ELSE 'queued' END,
                    processing_error_code=CASE
                      WHEN EXISTS(SELECT 1 FROM treasure_jobs j
                                  WHERE j.item_id=treasure_items.id
                                    AND j.state='failed' AND j.attempt_count >= 5)
                      THEN 'unknown' ELSE NULL END,
                    updated_at=?
                WHERE id IN (SELECT item_id FROM treasure_jobs
                             WHERE updated_at=? AND last_error_code='unknown')
                """, &recoverItems)
            sqlite3_bind_double(recoverItems, 1, now.timeIntervalSince1970)
            sqlite3_bind_double(recoverItems, 2, now.timeIntervalSince1970)
            try Self.stepDone(db, recoverItems)
            sqlite3_finalize(recoverItems)

            let sql = """
            SELECT id, item_id, job_type, state, attempt_count, next_attempt_at,
                   last_error_code FROM treasure_jobs
            WHERE state IN ('queued','failed')
              AND attempt_count < 5
              AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            ORDER BY created_at ASC LIMIT ?
            """
            var stmt: OpaquePointer?
            try Self.prepare(db, sql, &stmt)
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_double(stmt, 1, now.timeIntervalSince1970)
            sqlite3_bind_int(stmt, 2, Int32(max(1, min(limit, 500))))
            var jobs: [Job] = []
            while sqlite3_step(stmt) == SQLITE_ROW {
                jobs.append(Job(
                    id: Self.text(stmt, 0), itemID: Self.text(stmt, 1),
                    type: Self.text(stmt, 2), state: Self.text(stmt, 3),
                    attemptCount: Int(sqlite3_column_int(stmt, 4)),
                    nextAttemptAt: Self.optionalDate(stmt, 5),
                    lastErrorCode: Self.optionalText(stmt, 6)
                ))
            }
            return jobs
        }
    }

    func claimJob(id: String, now: Date = Date()) throws -> Bool {
        try withDatabase { db in
            try Self.transaction(db) {
                var stmt: OpaquePointer?
                try Self.prepare(db, "UPDATE treasure_jobs SET state='processing',attempt_count=attempt_count+1,next_attempt_at=NULL,updated_at=?,last_error_code=NULL WHERE id=? AND state IN ('queued','failed')", &stmt)
                defer { sqlite3_finalize(stmt) }
                sqlite3_bind_double(stmt, 1, now.timeIntervalSince1970)
                Self.bind(id, stmt, 2)
                try Self.stepDone(db, stmt)
            }
            return sqlite3_changes(db) > 0
        }
    }

    func completeJob(id: String, now: Date = Date()) throws {
        try withDatabase { db in
            var stmt: OpaquePointer?
            try Self.prepare(db, "UPDATE treasure_jobs SET state='completed',updated_at=?,next_attempt_at=NULL,last_error_code=NULL WHERE id=?", &stmt)
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_double(stmt, 1, now.timeIntervalSince1970)
            Self.bind(id, stmt, 2)
            try Self.stepDone(db, stmt)
        }
    }

    func failJob(id: String, errorCode: String, now: Date = Date()) throws {
        let safeCode = String(errorCode.filter { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" }.prefix(80))
        try withDatabase { db in
            try Self.transaction(db) {
                let attempts = try Self.scalarInt(
                    db, sql: "SELECT attempt_count FROM treasure_jobs WHERE id=?", bindings: [id]
                )
                let delay = min(86_400.0, pow(2.0, Double(min(max(attempts, 1), 16))))
                var stmt: OpaquePointer?
                try Self.prepare(db, "UPDATE treasure_jobs SET state='failed',next_attempt_at=?,updated_at=?,last_error_code=? WHERE id=?", &stmt)
                defer { sqlite3_finalize(stmt) }
                sqlite3_bind_double(stmt, 1, now.addingTimeInterval(delay).timeIntervalSince1970)
                sqlite3_bind_double(stmt, 2, now.timeIntervalSince1970)
                Self.bind(safeCode.isEmpty ? "unknown" : safeCode, stmt, 3)
                Self.bind(id, stmt, 4)
                try Self.stepDone(db, stmt)
            }
        }
    }

    @discardableResult
    func retryFailedJobs(itemID: String, now: Date = Date()) throws -> Int {
        try withDatabase { db in
            var stmt: OpaquePointer?
            try Self.prepare(db, "UPDATE treasure_jobs SET state='queued',attempt_count=0,next_attempt_at=NULL,updated_at=?,last_error_code=NULL WHERE item_id=? AND state='failed'", &stmt)
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_double(stmt, 1, now.timeIntervalSince1970)
            Self.bind(itemID, stmt, 2)
            try Self.stepDone(db, stmt)
            return Int(sqlite3_changes(db))
        }
    }

    func changes(afterRowID: Int64 = 0, limit: Int = 500) throws -> [Change] {
        try withDatabase { db in
            let sql = """
            SELECT rowid, change_id, item_id, operation, updated_at, origin_device_id,
                   payload_digest FROM treasure_changes
            WHERE rowid > ? ORDER BY rowid ASC LIMIT ?
            """
            var stmt: OpaquePointer?
            try Self.prepare(db, sql, &stmt)
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_int64(stmt, 1, afterRowID)
            sqlite3_bind_int(stmt, 2, Int32(max(1, min(limit, 1_000))))
            var changes: [Change] = []
            while sqlite3_step(stmt) == SQLITE_ROW {
                changes.append(Change(
                    sequence: sqlite3_column_int64(stmt, 0),
                    id: Self.text(stmt, 1), itemID: Self.text(stmt, 2),
                    operation: Self.text(stmt, 3),
                    updatedAt: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 4)),
                    originDeviceID: Self.text(stmt, 5), payloadDigest: Self.text(stmt, 6)
                ))
            }
            return changes
        }
    }

    func syncContracts(ids: Set<String>) throws -> [String: TreasureItemContract] {
        guard !ids.isEmpty else { return [:] }
        let items = try load(includeDeleted: true).filter { ids.contains($0.id) }
        let storage = try contractStorageFields()
        return Dictionary(uniqueKeysWithValues: items.map { item in
            let fields = storage[item.id]
            let contract = TreasureItemContract(
                item: item,
                originDeviceID: fields?.originDeviceID ?? Self.originDeviceID(),
                byteCount: fields?.byteCount ?? 0,
                contentDigest: fields?.contentDigest,
                sourceApp: fields?.sourceApp,
                mimeType: fields?.mimeType,
                collectionIDs: fields?.collectionIDs ?? [],
                readingState: fields?.readingState ?? item.readingState,
                readingProgress: fields?.readingProgress ?? item.readingProgress,
                lastOpenedAt: fields?.lastOpenedAt,
                processingState: fields?.processingState ?? item.processingState,
                processingErrorCode: fields?.processingErrorCode,
                syncState: fields?.syncState ?? "local",
                deletedAt: fields?.deletedAt
            )
            return (item.id, contract)
        })
    }

    func syncAsset(itemID: String, kind: String) throws -> SyncAsset? {
        guard ["body", "attachment"].contains(kind) else { return nil }
        return try withDatabase { db in
            var stmt: OpaquePointer?
            try Self.prepare(db, """
                SELECT kind,legacy_value,original_text,body_ref,mime_type,
                       byte_count,content_digest,origin_device_id
                FROM treasure_items WHERE id=? AND deleted_at IS NULL LIMIT 1
                """, &stmt)
            defer { sqlite3_finalize(stmt) }
            Self.bind(itemID, stmt, 1)
            guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
            let itemKind = Self.text(stmt, 0)
            let legacyValue = Self.text(stmt, 1)
            let originalText = Self.optionalText(stmt, 2)
            let bodyRef = Self.optionalText(stmt, 3)
            let storedMime = Self.optionalText(stmt, 4)
            let storedCount = Int(sqlite3_column_int64(stmt, 5))
            let storedDigest = Self.optionalText(stmt, 6)?.lowercased()

            if kind == "body" {
                if let originalText {
                    let data = Data(originalText.utf8)
                    guard data.count <= 8 * 1024 * 1024 else { return nil }
                    let temp = FileManager.default.temporaryDirectory
                        .appendingPathComponent("treasury-body-\(UUID().uuidString).txt")
                    try data.write(to: temp, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                    guard let digest = Self.sha256(temp) else {
                        try? FileManager.default.removeItem(at: temp)
                        return nil
                    }
                    return SyncAsset(fileURL: temp, mimeType: "text/plain",
                                     byteCount: data.count, digest: digest,
                                     removeAfterUpload: true)
                }
                guard let ref = bodyRef.flatMap(TreasureItemContract.safeLastPathComponent) else {
                    return nil
                }
                let file = directory.appendingPathComponent("notes", isDirectory: true)
                    .appendingPathComponent(ref, isDirectory: false)
                guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize,
                      size <= 8 * 1024 * 1024, let digest = Self.sha256(file) else { return nil }
                return SyncAsset(fileURL: file, mimeType: "text/plain", byteCount: size,
                                 digest: digest, removeAfterUpload: false)
            }

            guard ["file", "image", "document", "audio", "video", "artifact"].contains(itemKind),
                  SharedContainerStore.isSafeFileName(legacyValue) else { return nil }
            let file = directory.appendingPathComponent("files", isDirectory: true)
                .appendingPathComponent(legacyValue, isDirectory: false)
            guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize,
                  size <= 128 * 1024 * 1024, let digest = Self.sha256(file),
                  storedCount <= 0 || storedCount == size,
                  storedDigest == nil || storedDigest == digest else { return nil }
            return SyncAsset(fileURL: file, mimeType: storedMime ?? "application/octet-stream",
                             byteCount: size, digest: digest, removeAfterUpload: false)
        }
    }

    func applyRemoteChanges(_ changes: [RemoteChange]) throws {
        guard !changes.isEmpty else { return }
        let localOrigin = Self.originDeviceID()
        try withDatabase { db in
            try Self.transaction(db) {
                for change in changes.sorted(by: { $0.sequence < $1.sequence }) {
                    guard change.originDeviceID != localOrigin,
                          ["upsert", "delete"].contains(change.operation),
                          !change.itemID.isEmpty else { continue }
                    var state: OpaquePointer?
                    try Self.prepare(db, "SELECT updated_at,origin_device_id,sync_state,deleted_at FROM treasure_items WHERE id=?", &state)
                    Self.bind(change.itemID, state, 1)
                    let hasExisting = sqlite3_step(state) == SQLITE_ROW
                    let existingUpdated = hasExisting
                        ? Date(timeIntervalSince1970: sqlite3_column_double(state, 0)) : .distantPast
                    let existingOrigin = hasExisting ? Self.text(state, 1) : ""
                    let existingSync = hasExisting ? Self.text(state, 2) : ""
                    let existingDeleted = hasExisting && sqlite3_column_type(state, 3) != SQLITE_NULL
                    sqlite3_finalize(state)

                    // Android and the relay exchange epoch milliseconds. Compare the
                    // same canonical precision here so a sub-millisecond SQLite value
                    // cannot make an otherwise concurrent remote edit look stale.
                    let incomingTimestamp = Self.syncTimestampMilliseconds(change.updatedAt)
                    let existingTimestamp = Self.syncTimestampMilliseconds(existingUpdated)
                    let incomingKey = (incomingTimestamp,
                                       change.operation == "delete" ? 1 : 0,
                                       change.originDeviceID, change.id)
                    let existingKey = (existingTimestamp,
                                       existingDeleted ? 1 : 0, existingOrigin, "")
                    guard !hasExisting || incomingKey > existingKey else {
                        if existingSync == "pending" && existingOrigin == localOrigin &&
                            incomingTimestamp >= existingTimestamp {
                            var conflict: OpaquePointer?
                            try Self.prepare(db, "UPDATE treasure_items SET sync_state='conflict' WHERE id=?", &conflict)
                            Self.bind(change.itemID, conflict, 1)
                            try Self.stepDone(db, conflict)
                            sqlite3_finalize(conflict)
                        }
                        continue
                    }
                    let conflict = hasExisting && existingSync == "pending" && existingOrigin == localOrigin
                    let finalSync = conflict ? "conflict" : (hasExisting ? "synced" : "remote_only")

                    if change.operation == "delete" {
                        if !hasExisting {
                            var insertTombstone: OpaquePointer?
                            try Self.prepare(db, """
                                INSERT INTO treasure_items(
                                  id,kind,legacy_value,source_label,created_at,updated_at,
                                  processing_state,sync_state,origin_device_id,deleted_at,
                                  metadata_fetched
                                ) VALUES(?,'text','','同步删除',?,?,'saved','remote_only',?,?,1)
                                """, &insertTombstone)
                            Self.bind(change.itemID, insertTombstone, 1)
                            sqlite3_bind_double(insertTombstone, 2, change.updatedAt.timeIntervalSince1970)
                            sqlite3_bind_double(insertTombstone, 3, change.updatedAt.timeIntervalSince1970)
                            Self.bind(change.originDeviceID, insertTombstone, 4)
                            sqlite3_bind_double(insertTombstone, 5, change.updatedAt.timeIntervalSince1970)
                            try Self.stepDone(db, insertTombstone)
                            sqlite3_finalize(insertTombstone)
                            continue
                        }
                        var deletion: OpaquePointer?
                        try Self.prepare(db, "UPDATE treasure_items SET deleted_at=?,updated_at=?,sync_state=?,origin_device_id=? WHERE id=?", &deletion)
                        sqlite3_bind_double(deletion, 1, change.updatedAt.timeIntervalSince1970)
                        sqlite3_bind_double(deletion, 2, change.updatedAt.timeIntervalSince1970)
                        Self.bind(finalSync, deletion, 3)
                        Self.bind(change.originDeviceID, deletion, 4)
                        Self.bind(change.itemID, deletion, 5)
                        try Self.stepDone(db, deletion)
                        sqlite3_finalize(deletion)
                        continue
                    }

                    guard let contract = change.contract,
                          contract.id == change.itemID,
                          contract.originDeviceID == change.originDeviceID,
                          Self.isValidContract(contract),
                          let item = contract.collectedItem() else { continue }
                    if existingDeleted {
                        var resurrect: OpaquePointer?
                        try Self.prepare(db, "UPDATE treasure_items SET deleted_at=NULL WHERE id=?", &resurrect)
                        Self.bind(change.itemID, resurrect, 1)
                        try Self.stepDone(db, resurrect)
                        sqlite3_finalize(resurrect)
                    }
                    let prepared = prepareForPersistence(item)
                    try Self.upsert(item, normalizedURL: prepared.normalizedURL,
                                    contentDigest: prepared.contentDigest,
                                    filesDirectory: filesDirectoryURL, db: db)
                    try Self.applyContractMetadata(contract, db: db)
                    var finalize: OpaquePointer?
                    let clearMissingBody = !hasExisting && contract.originalText == nil
                    try Self.prepare(db, "UPDATE treasure_items SET updated_at=?,sync_state=?,origin_device_id=?,deleted_at=NULL,original_text=CASE WHEN ? THEN NULL ELSE original_text END WHERE id=?", &finalize)
                    sqlite3_bind_double(finalize, 1, change.updatedAt.timeIntervalSince1970)
                    Self.bind(finalSync, finalize, 2)
                    Self.bind(change.originDeviceID, finalize, 3)
                    sqlite3_bind_int(finalize, 4, clearMissingBody ? 1 : 0)
                    Self.bind(change.itemID, finalize, 5)
                    try Self.stepDone(db, finalize)
                    sqlite3_finalize(finalize)
                }
            }
        }
    }

    func rebuildIndex(bodyProvider: (CollectedItem) -> String? = { _ in nil }) throws {
        let items = try load()
        try withDatabase { db in
            try Self.transaction(db) {
                try Self.exec(db, "DELETE FROM treasure_fts")
                let sql = """
                INSERT INTO treasure_fts(item_id, title, body, summary, annotation, tags)
                VALUES (?, ?, ?, ?, ?, ?)
                """
                for item in items {
                    var stmt: OpaquePointer?
                    try Self.prepare(db, sql, &stmt)
                    defer { sqlite3_finalize(stmt) }
                    Self.bind(item.id, stmt, 1)
                    Self.bind(item.title ?? "", stmt, 2)
                    Self.bind(bodyProvider(item) ?? (item.kind == .text ? item.value : ""), stmt, 3)
                    Self.bind(item.summary ?? "", stmt, 4)
                    Self.bind(item.annotation ?? "", stmt, 5)
                    Self.bind(item.tags.joined(separator: " "), stmt, 6)
                    try Self.stepDone(db, stmt)
                }
            }
        }
    }

    private struct ContractStorageFields {
        let byteCount: Int
        let contentDigest: String?
        let sourceApp: String?
        let mimeType: String?
        let collectionIDs: [String]
        let readingState: String
        let readingProgress: Double
        let lastOpenedAt: String?
        let processingState: String
        let processingErrorCode: String?
        let syncState: String
        let originDeviceID: String
        let deletedAt: String?
    }

    private func contractStorageFields() throws -> [String: ContractStorageFields] {
        try withDatabase { db in
            var stmt: OpaquePointer?
            try Self.prepare(db, """
                SELECT id, byte_count, content_digest, source_app, mime_type,
                       collection_ids_json, reading_state, reading_progress,
                       last_opened_at, processing_state, processing_error_code,
                       sync_state, origin_device_id, deleted_at
                FROM treasure_items
                """, &stmt)
            defer { sqlite3_finalize(stmt) }
            var values: [String: ContractStorageFields] = [:]
            while sqlite3_step(stmt) == SQLITE_ROW {
                let collectionData = Data(Self.text(stmt, 5).utf8)
                let collectionIDs = (try? JSONDecoder().decode([String].self,
                                                                from: collectionData)) ?? []
                let lastOpened = Self.optionalDate(stmt, 8).map(TreasureItemContract.string(from:))
                let deleted = Self.optionalDate(stmt, 13).map(TreasureItemContract.string(from:))
                values[Self.text(stmt, 0)] = ContractStorageFields(
                    byteCount: Int(sqlite3_column_int64(stmt, 1)),
                    contentDigest: Self.optionalText(stmt, 2),
                    sourceApp: Self.optionalText(stmt, 3),
                    mimeType: Self.optionalText(stmt, 4),
                    collectionIDs: collectionIDs,
                    readingState: Self.text(stmt, 6),
                    readingProgress: sqlite3_column_double(stmt, 7),
                    lastOpenedAt: lastOpened,
                    processingState: Self.text(stmt, 9),
                    processingErrorCode: Self.optionalText(stmt, 10),
                    syncState: Self.text(stmt, 11),
                    originDeviceID: Self.text(stmt, 12),
                    deletedAt: deleted
                )
            }
            return values
        }
    }

    func exportJSON() throws -> Data {
        let items = try load()
        let storage = try contractStorageFields()
        let contracts = items.map { item in
            let fields = storage[item.id]
            return TreasureItemContract(
                item: item,
                originDeviceID: fields?.originDeviceID ?? Self.originDeviceID(),
                byteCount: fields?.byteCount ?? 0,
                contentDigest: fields?.contentDigest,
                sourceApp: fields?.sourceApp,
                mimeType: fields?.mimeType,
                collectionIDs: fields?.collectionIDs ?? [],
                readingState: fields?.readingState ?? "none",
                readingProgress: fields?.readingProgress ?? 0,
                lastOpenedAt: fields?.lastOpenedAt,
                processingState: fields?.processingState,
                processingErrorCode: fields?.processingErrorCode,
                syncState: fields?.syncState ?? "local",
                deletedAt: fields?.deletedAt
            )
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(contracts)
    }

    func importJSON(_ data: Data) throws {
        if let contracts = try? JSONDecoder().decode([TreasureItemContract].self, from: data) {
            let pairs = contracts.compactMap { contract -> (TreasureItemContract, CollectedItem)? in
                guard Self.isValidContract(contract), let item = contract.collectedItem() else { return nil }
                return (contract, item)
            }
            guard pairs.count == contracts.count else { throw StoreError.invalidImport }
            let prepared = pairs.map { pair in
                (pair.0, prepareForPersistence(pair.1))
            }
            try withDatabase { db in
                try Self.transaction(db) {
                    for (contract, record) in prepared {
                        let isTombstoned = try Self.scalarInt(
                            db,
                            sql: "SELECT COUNT(*) FROM treasure_items WHERE id=? AND deleted_at IS NOT NULL",
                            bindings: [record.item.id]
                        ) > 0
                        if isTombstoned { continue }
                        let digest = contract.contentDigest ?? record.contentDigest
                        if let duplicateID = try Self.findDuplicateID(
                            db, normalizedURL: record.normalizedURL, contentDigest: digest
                        ), duplicateID != record.item.id {
                            continue
                        }
                        try Self.upsert(record.item, normalizedURL: record.normalizedURL,
                                        contentDigest: digest,
                                        filesDirectory: filesDirectoryURL, db: db)
                        try Self.applyContractMetadata(contract, db: db)
                        if contract.deletedAt == nil {
                            try Self.enqueueDefaultJobs(for: record.item, db: db)
                            try Self.appendChange(for: record.item, operation: "upsert", db: db)
                        } else {
                            try Self.appendDeleteChange(itemID: record.item.id,
                                                        updatedAt: record.item.updatedAt, db: db)
                        }
                    }
                }
            }
            return
        }
        // Backward-compatible import of the pre-Phase-1 local JSON format.
        guard let legacy = try? JSONDecoder().decode([CollectedItem].self, from: data) else {
            throw StoreError.invalidImport
        }
        try add(legacy)
    }

    func exportMarkdown() throws -> String {
        try load().map { item in
            let title = item.title?.trimmingCharacters(in: .whitespacesAndNewlines)
            let heading = title?.isEmpty == false ? title! : item.sourceLabel
            let source = item.kind == .link ? "\n\nSource: \(item.value)" : ""
            let body = item.kind == .text ? "\n\n\(item.value)" : ""
            let tags = item.tags.isEmpty ? "" : "\n\nTags: \(item.tags.map { "#\($0)" }.joined(separator: " "))"
            return "## \(heading)\(source)\(body)\(tags)"
        }.joined(separator: "\n\n---\n\n")
    }

    func importMarkdown(_ markdown: String) throws -> Int {
        let sections = markdown.components(separatedBy: "\n\n---\n\n")
        let items = sections.compactMap { section -> CollectedItem? in
            let lines = section.components(separatedBy: .newlines)
            guard let headingLine = lines.first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) else {
                return nil
            }
            let title = headingLine.replacingOccurrences(of: #"^#{1,6}\s*"#, with: "",
                                                         options: .regularExpression)
            let source = lines.first { $0.hasPrefix("Source: ") }
                .map { String($0.dropFirst("Source: ".count)).trimmingCharacters(in: .whitespaces) }
            let tagLine = lines.first { $0.hasPrefix("Tags: ") }
            let tags = tagLine?.split(separator: " ").dropFirst().map {
                String($0).trimmingCharacters(in: CharacterSet(charactersIn: "#"))
            } ?? []
            if let source, Self.normalizedURLKey(source) != nil {
                var item = CollectedItem(kind: .link, value: source,
                                         sourceLabel: CollectionStore.sourceLabel(forHost: URL(string: source)?.host))
                item.title = title.isEmpty ? nil : title
                item.tags = tags
                return item
            }
            let body = lines.dropFirst().filter {
                !$0.hasPrefix("Tags: ") && !$0.hasPrefix("Source: ")
            }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !body.isEmpty || !title.isEmpty else { return nil }
            var item = CollectedItem(kind: .text, value: body, sourceLabel: "文本")
            item.title = title.isEmpty ? nil : title
            item.tags = tags
            return item
        }
        return try addReturningInsertedCount(items)
    }

    func importBrowserBookmarksHTML(_ html: String) throws -> Int {
        let pattern = #"(?is)<a\b[^>]*href\s*=\s*[\"']([^\"']+)[\"'][^>]*>(.*?)</a>"#
        let regex = try NSRegularExpression(pattern: pattern)
        let range = NSRange(html.startIndex..<html.endIndex, in: html)
        let items = regex.matches(in: html, range: range).compactMap { match -> CollectedItem? in
            guard let urlRange = Range(match.range(at: 1), in: html),
                  let titleRange = Range(match.range(at: 2), in: html) else { return nil }
            let rawURL = String(html[urlRange])
            guard let url = URL(string: rawURL), ["http", "https"].contains(url.scheme?.lowercased()) else {
                return nil
            }
            let visibleTitle = String(html[titleRange])
                .replacingOccurrences(of: #"<[^>]+>"#, with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            var item = CollectedItem(kind: .link, value: rawURL,
                                     sourceLabel: CollectionStore.sourceLabel(forHost: url.host))
            item.title = visibleTitle.isEmpty ? nil : visibleTitle
            return item
        }
        return try addReturningInsertedCount(items)
    }

    private static func isValidContract(_ contract: TreasureItemContract) -> Bool {
        let readingStates = Set(["none", "unread", "reading", "read"])
        let processingStates = Set(["saved", "queued", "processing", "ready", "partial", "failed"])
        let syncStates = Set(["local", "pending", "synced", "conflict", "remote_only"])
        guard contract.schemaVersion == 1, contract.byteCount >= 0,
              readingStates.contains(contract.readingState),
              processingStates.contains(contract.processingState),
              syncStates.contains(contract.syncState),
              !contract.originDeviceID.isEmpty,
              TreasureItemContract.date(from: contract.createdAt) != nil,
              TreasureItemContract.date(from: contract.updatedAt) != nil else { return false }
        if let value = contract.lastOpenedAt,
           TreasureItemContract.date(from: value) == nil { return false }
        if let value = contract.deletedAt,
           TreasureItemContract.date(from: value) == nil { return false }
        if let value = contract.bodyRef,
           TreasureItemContract.safeLastPathComponent(value) == nil { return false }
        if let value = contract.previewRef,
           TreasureItemContract.safeLastPathComponent(value) == nil { return false }
        if let digest = contract.contentDigest {
            let hexadecimal = CharacterSet(charactersIn: "0123456789abcdefABCDEF")
            guard digest.count == 64,
                  digest.unicodeScalars.allSatisfy(hexadecimal.contains) else { return false }
        }
        return true
    }

    private static func applyContractMetadata(_ contract: TreasureItemContract,
                                              db: OpaquePointer?) throws {
        let collectionIDs = (try? String(
            data: JSONEncoder().encode(Array(Set(contract.collectionIDs)).sorted()),
            encoding: .utf8
        )) ?? "[]"
        let sql = """
        UPDATE treasure_items SET
          schema_version=?, source_app=?, body_ref=COALESCE(?,body_ref),
          preview_ref=COALESCE(?,preview_ref), mime_type=COALESCE(?,mime_type),
          byte_count=MAX(byte_count,?), content_digest=COALESCE(?,content_digest),
          collection_ids_json=?, reading_state=?,
          reading_progress=?, last_opened_at=?, processing_state=?,
          processing_error_code=?, sync_state=?, origin_device_id=?, deleted_at=?
        WHERE id=?
        """
        var stmt: OpaquePointer?
        try prepare(db, sql, &stmt)
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int(stmt, 1, Int32(contract.schemaVersion))
        bind(contract.sourceApp, stmt, 2)
        bind(contract.bodyRef, stmt, 3)
        bind(contract.previewRef, stmt, 4)
        bind(contract.mimeType, stmt, 5)
        sqlite3_bind_int64(stmt, 6, Int64(contract.byteCount))
        bind(contract.contentDigest?.lowercased(), stmt, 7)
        bind(collectionIDs, stmt, 8)
        bind(contract.readingState, stmt, 9)
        sqlite3_bind_double(stmt, 10, contract.readingProgress)
        if let value = contract.lastOpenedAt.flatMap(TreasureItemContract.date(from:)) {
            sqlite3_bind_double(stmt, 11, value.timeIntervalSince1970)
        } else {
            sqlite3_bind_null(stmt, 11)
        }
        bind(contract.processingState, stmt, 12)
        bind(contract.processingErrorCode, stmt, 13)
        bind(contract.syncState, stmt, 14)
        bind(contract.originDeviceID, stmt, 15)
        if let value = contract.deletedAt.flatMap(TreasureItemContract.date(from:)) {
            sqlite3_bind_double(stmt, 16, value.timeIntervalSince1970)
        } else {
            sqlite3_bind_null(stmt, 16)
        }
        bind(contract.id, stmt, 17)
        try stepDone(db, stmt)
    }

    // MARK: Migration and schema

    private func migrateLegacyJSONIfNeeded(_ db: OpaquePointer?) throws -> MigrationReport {
        if try Self.metadata(db, key: "legacy_items_json_v1") != nil {
            return MigrationReport(importedCount: 0, quarantinedCount: 0, didRun: false)
        }
        guard FileManager.default.fileExists(atPath: legacyURL.path) else {
            try Self.setMetadata(db, key: "legacy_items_json_v1", value: "no-source")
            return MigrationReport(importedCount: 0, quarantinedCount: 0, didRun: true)
        }

        let data = try Data(contentsOf: legacyURL)
        let backupURL = directory.appendingPathComponent("items.pre-sqlite-v1.json")
        if !FileManager.default.fileExists(atPath: backupURL.path) {
            try data.write(to: backupURL, options: [.atomic])
        }
        guard let values = try JSONSerialization.jsonObject(with: data) as? [Any] else {
            throw StoreError.invalidImport
        }
        var valid: [CollectedItem] = []
        var quarantined: [Any] = []
        var seenIDs = Set<String>()
        for value in values {
            guard JSONSerialization.isValidJSONObject(value),
                  let row = try? JSONSerialization.data(withJSONObject: value),
                  let item = try? JSONDecoder().decode(CollectedItem.self, from: row),
                  !item.id.isEmpty, seenIDs.insert(item.id).inserted else {
                quarantined.append(value)
                continue
            }
            valid.append(item)
        }
        if !quarantined.isEmpty,
           JSONSerialization.isValidJSONObject(quarantined),
           let badData = try? JSONSerialization.data(withJSONObject: quarantined,
                                                      options: [.prettyPrinted, .sortedKeys]) {
            try badData.write(to: directory.appendingPathComponent("items.quarantine-v1.json"),
                              options: [.atomic])
        }

        // File digesting is deliberately outside the write transaction.
        let prepared = valid.map(prepareForPersistence)
        var anotherProcessCompletedMigration = false
        try Self.transaction(db) {
            if try Self.metadata(db, key: "legacy_items_json_v1") != nil {
                anotherProcessCompletedMigration = true
                return
            }
            for record in prepared {
                let item = record.item
                try Self.upsert(item, normalizedURL: record.normalizedURL,
                                contentDigest: record.contentDigest,
                                filesDirectory: filesDirectoryURL, db: db)
            }
            let actual = try Self.scalarInt(db, sql: "SELECT COUNT(*) FROM treasure_items")
            guard actual >= valid.count else {
                throw StoreError.migrationCountMismatch(expected: valid.count, actual: actual)
            }
            try Self.setMetadata(
                db, key: "legacy_items_json_v1",
                value: "imported=\(valid.count);quarantined=\(quarantined.count)"
            )
        }
        if anotherProcessCompletedMigration {
            return MigrationReport(importedCount: 0, quarantinedCount: 0, didRun: false)
        }
        return MigrationReport(importedCount: valid.count,
                               quarantinedCount: quarantined.count, didRun: true)
    }

    private static func createSchema(_ db: OpaquePointer?) throws {
        try exec(db, """
        CREATE TABLE IF NOT EXISTS treasury_metadata (
          key TEXT PRIMARY KEY, value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS treasure_items (
          id TEXT PRIMARY KEY NOT NULL,
          schema_version INTEGER NOT NULL DEFAULT 1,
          kind TEXT NOT NULL,
          legacy_value TEXT NOT NULL DEFAULT '',
          source_uri TEXT,
          normalized_url_key TEXT,
          resolved_url TEXT,
          title TEXT,
          source_app TEXT,
          source_label TEXT NOT NULL,
          original_text TEXT,
          body_ref TEXT,
          preview_ref TEXT,
          mime_type TEXT,
          byte_count INTEGER NOT NULL DEFAULT 0,
          content_digest TEXT,
          summary TEXT,
          annotation TEXT,
          tags_json TEXT NOT NULL DEFAULT '[]',
          collection_ids_json TEXT NOT NULL DEFAULT '[]',
          pinned INTEGER NOT NULL DEFAULT 0,
          archived INTEGER NOT NULL DEFAULT 0,
          reading_state TEXT NOT NULL DEFAULT 'none',
          reading_progress REAL NOT NULL DEFAULT 0 CHECK(reading_progress BETWEEN 0 AND 1),
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL,
          last_opened_at REAL,
          processing_state TEXT NOT NULL DEFAULT 'saved',
          processing_error_code TEXT,
          sync_state TEXT NOT NULL DEFAULT 'local',
          origin_device_id TEXT NOT NULL,
          deleted_at REAL,
          metadata_fetched INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_treasure_items_updated ON treasure_items(deleted_at, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_treasure_items_url ON treasure_items(normalized_url_key) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_treasure_items_digest ON treasure_items(content_digest) WHERE deleted_at IS NULL;
        CREATE TABLE IF NOT EXISTS treasure_collections (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, color_token TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL,
          updated_at REAL NOT NULL, deleted_at REAL
        );
        CREATE TABLE IF NOT EXISTS treasure_chunks (
          item_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, section_label TEXT,
          text TEXT NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
          PRIMARY KEY(item_id, chunk_index),
          FOREIGN KEY(item_id) REFERENCES treasure_items(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS treasure_highlights (
          id TEXT PRIMARY KEY, item_id TEXT NOT NULL, quote_text TEXT NOT NULL,
          note TEXT, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
          page_number INTEGER, created_at REAL NOT NULL, updated_at REAL NOT NULL,
          origin_device_id TEXT NOT NULL, deleted_at REAL,
          FOREIGN KEY(item_id) REFERENCES treasure_items(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_treasure_highlights_item
          ON treasure_highlights(item_id, deleted_at, updated_at);
        CREATE TABLE IF NOT EXISTS treasure_jobs (
          id TEXT PRIMARY KEY, item_id TEXT NOT NULL, job_type TEXT NOT NULL,
          state TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at REAL, created_at REAL NOT NULL, updated_at REAL NOT NULL,
          last_error_code TEXT,
          FOREIGN KEY(item_id) REFERENCES treasure_items(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_treasure_jobs_ready ON treasure_jobs(state, next_attempt_at, created_at);
        CREATE TABLE IF NOT EXISTS treasure_changes (
          change_id TEXT PRIMARY KEY, item_id TEXT NOT NULL, operation TEXT NOT NULL,
          updated_at REAL NOT NULL, origin_device_id TEXT NOT NULL,
          payload_digest TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS treasure_fts USING fts5(
          item_id UNINDEXED, title, body, summary, annotation, tags,
          tokenize='unicode61 remove_diacritics 2'
        );
        """)
    }

    // MARK: SQLite primitives

    private func withDatabase<T>(_ body: (OpaquePointer?) throws -> T) throws -> T {
        var db: OpaquePointer?
        let flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(databaseURL.path, &db, flags, nil) == SQLITE_OK else {
            let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown"
            sqlite3_close(db)
            throw StoreError.open(message)
        }
        defer { sqlite3_close(db) }
        sqlite3_busy_timeout(db, 5_000)
        try Self.exec(db, "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;")
        return try body(db)
    }

    private static func transaction(_ db: OpaquePointer?, _ body: () throws -> Void) throws {
        try exec(db, "BEGIN IMMEDIATE")
        do {
            try body()
            try exec(db, "COMMIT")
        } catch {
            try? exec(db, "ROLLBACK")
            throw error
        }
    }

    private static func exec(_ db: OpaquePointer?, _ sql: String) throws {
        var error: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(db, sql, nil, nil, &error) == SQLITE_OK else {
            let message = error.map { String(cString: $0) }
                ?? db.map { String(cString: sqlite3_errmsg($0)) } ?? "SQLite error"
            sqlite3_free(error)
            throw StoreError.sqlite(message)
        }
    }

    private static func prepare(_ db: OpaquePointer?, _ sql: String,
                                _ stmt: inout OpaquePointer?) throws {
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw StoreError.sqlite(db.map { String(cString: sqlite3_errmsg($0)) } ?? "prepare")
        }
    }

    private static func stepDone(_ db: OpaquePointer?, _ stmt: OpaquePointer?) throws {
        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw StoreError.sqlite(db.map { String(cString: sqlite3_errmsg($0)) } ?? "step")
        }
    }

    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    private static func bind(_ value: String?, _ stmt: OpaquePointer?, _ index: Int32) {
        guard let value else { sqlite3_bind_null(stmt, index); return }
        sqlite3_bind_text(stmt, index, (value as NSString).utf8String, -1, transient)
    }

    private static func upsert(_ item: CollectedItem, normalizedURL: String?,
                               contentDigest: String?, filesDirectory: URL?,
                               db: OpaquePointer?) throws {
        let tags = (try? String(data: JSONEncoder().encode(normalizedTags(item.tags)),
                                encoding: .utf8)) ?? "[]"
        let sourceURI = item.kind == .link ? item.value : nil
        let originalText = item.kind == .text ? item.value : nil
        let mime = item.kind == .file ? mimeTypeForContract(item.value) : nil
        let byteCount = item.kind == .file ? fileByteCount(item.value, in: filesDirectory) : 0
        let sql = """
        INSERT INTO treasure_items (
          id, kind, legacy_value, source_uri, normalized_url_key, resolved_url,
          title, source_label, original_text, body_ref, preview_ref, mime_type,
          byte_count, content_digest, summary, annotation, tags_json, pinned,
          archived, reading_state, reading_progress, created_at, updated_at,
          last_opened_at, processing_state, processing_error_code, sync_state,
          origin_device_id, deleted_at, metadata_fetched
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)
        ON CONFLICT(id) DO UPDATE SET
          kind=excluded.kind, legacy_value=excluded.legacy_value,
          source_uri=excluded.source_uri, normalized_url_key=excluded.normalized_url_key,
          resolved_url=excluded.resolved_url, title=excluded.title,
          source_label=excluded.source_label,
          original_text=COALESCE(excluded.original_text,treasure_items.original_text),
          body_ref=COALESCE(excluded.body_ref,treasure_items.body_ref),
          preview_ref=COALESCE(excluded.preview_ref,treasure_items.preview_ref),
          mime_type=COALESCE(excluded.mime_type,treasure_items.mime_type),
          byte_count=MAX(excluded.byte_count,treasure_items.byte_count),
          content_digest=COALESCE(excluded.content_digest, treasure_items.content_digest),
          summary=excluded.summary, annotation=excluded.annotation,
          tags_json=excluded.tags_json, pinned=excluded.pinned,
          archived=excluded.archived, reading_state=excluded.reading_state,
          reading_progress=excluded.reading_progress,
          last_opened_at=excluded.last_opened_at,
          processing_state=excluded.processing_state,
          processing_error_code=excluded.processing_error_code,
          updated_at=excluded.updated_at,
          sync_state='pending', origin_device_id=excluded.origin_device_id,
          metadata_fetched=excluded.metadata_fetched
        WHERE treasure_items.deleted_at IS NULL
        """
        var stmt: OpaquePointer?
        try prepare(db, sql, &stmt)
        defer { sqlite3_finalize(stmt) }
        let strings: [String?] = [item.id, item.kind.rawValue, item.value, sourceURI,
                                  normalizedURL, item.resolvedURL, item.title,
                                  item.sourceLabel, originalText, item.bodyFile,
                                  item.thumbnailFile, mime]
        for (offset, value) in strings.enumerated() { bind(value, stmt, Int32(offset + 1)) }
        sqlite3_bind_int64(stmt, 13, Int64(byteCount))
        bind(contentDigest, stmt, 14)
        bind(item.summary, stmt, 15)
        bind(item.annotation, stmt, 16)
        bind(tags, stmt, 17)
        sqlite3_bind_int(stmt, 18, item.pinned ? 1 : 0)
        sqlite3_bind_int(stmt, 19, item.archived ? 1 : 0)
        bind(item.readingState, stmt, 20)
        sqlite3_bind_double(stmt, 21, min(1, max(0, item.readingProgress)))
        sqlite3_bind_double(stmt, 22, item.createdAt.timeIntervalSince1970)
        sqlite3_bind_double(stmt, 23, item.updatedAt.timeIntervalSince1970)
        if let lastOpenedAt = item.lastOpenedAt {
            sqlite3_bind_double(stmt, 24, lastOpenedAt.timeIntervalSince1970)
        } else {
            sqlite3_bind_null(stmt, 24)
        }
        bind(item.processingState, stmt, 25)
        bind(item.processingErrorCode, stmt, 26)
        bind("pending", stmt, 27)
        bind(originDeviceID(), stmt, 28)
        sqlite3_bind_int(stmt, 29, item.metadataFetched ? 1 : 0)
        try stepDone(db, stmt)
    }

    private static func queryItems(_ db: OpaquePointer?, sql: String,
                                   bindings: [String] = []) throws -> [CollectedItem] {
        var stmt: OpaquePointer?
        try prepare(db, sql, &stmt)
        defer { sqlite3_finalize(stmt) }
        for (offset, value) in bindings.enumerated() { bind(value, stmt, Int32(offset + 1)) }
        var items: [CollectedItem] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let kind = CollectedItem.Kind(rawValue: text(stmt, 1)) ?? .text
            let tagData = Data(text(stmt, 8).utf8)
            let tags = (try? JSONDecoder().decode([String].self, from: tagData)) ?? []
            items.append(CollectedItem(
                id: text(stmt, 0), kind: kind, value: text(stmt, 2),
                resolvedURL: optionalText(stmt, 3), title: optionalText(stmt, 4),
                thumbnailFile: optionalText(stmt, 5).flatMap(TreasureItemContract.safeLastPathComponent),
                sourceLabel: text(stmt, 6),
                createdAt: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 7)),
                tags: tags, pinned: sqlite3_column_int(stmt, 9) != 0,
                summary: optionalText(stmt, 10), metadataFetched: sqlite3_column_int(stmt, 11) != 0,
                bodyFile: optionalText(stmt, 12).flatMap(TreasureItemContract.safeLastPathComponent),
                annotation: optionalText(stmt, 13),
                archived: sqlite3_column_int(stmt, 14) != 0,
                updatedAt: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 15)),
                readingState: text(stmt, 16),
                readingProgress: sqlite3_column_double(stmt, 17),
                lastOpenedAt: sqlite3_column_type(stmt, 18) == SQLITE_NULL ? nil
                    : Date(timeIntervalSince1970: sqlite3_column_double(stmt, 18)),
                processingState: text(stmt, 19),
                processingErrorCode: optionalText(stmt, 20)
            ))
        }
        return items
    }

    private static func tombstone(_ ids: [String], db: OpaquePointer?) throws {
        let now = Date()
        for id in ids {
            var stmt: OpaquePointer?
            try prepare(db, "UPDATE treasure_items SET deleted_at=?, updated_at=?, sync_state='pending' WHERE id=? AND deleted_at IS NULL", &stmt)
            sqlite3_bind_double(stmt, 1, now.timeIntervalSince1970)
            sqlite3_bind_double(stmt, 2, now.timeIntervalSince1970)
            bind(id, stmt, 3)
            try stepDone(db, stmt)
            sqlite3_finalize(stmt)
            if sqlite3_changes(db) > 0 {
                try appendDeleteChange(itemID: id, updatedAt: now, db: db)
            }
        }
    }

    private static func appendChange(for item: CollectedItem, operation: String,
                                     db: OpaquePointer?) throws {
        try appendChange(itemID: item.id, item: item, operation: operation, db: db)
    }

    private static func touchItemAndAppendChange(_ itemID: String, at date: Date,
                                                 db: OpaquePointer?) throws {
        var touch: OpaquePointer?
        try prepare(db, "UPDATE treasure_items SET updated_at=?,sync_state='pending' WHERE id=? AND deleted_at IS NULL", &touch)
        sqlite3_bind_double(touch, 1, date.timeIntervalSince1970)
        bind(itemID, touch, 2)
        try stepDone(db, touch)
        sqlite3_finalize(touch)
        guard let item = try queryItems(
            db,
            sql: """
            SELECT id, kind, legacy_value, resolved_url, title, preview_ref,
                   source_label, created_at, tags_json, pinned, summary,
                   metadata_fetched, body_ref, annotation, archived, updated_at,
                   reading_state, reading_progress, last_opened_at,
                   processing_state, processing_error_code
            FROM treasure_items WHERE id=? AND deleted_at IS NULL
            """,
            bindings: [itemID]
        ).first else { return }
        try appendChange(for: item, operation: "upsert", db: db)
    }

    private static func appendChange(itemID: String, item: CollectedItem, operation: String,
                                     db: OpaquePointer?) throws {
        let payload = (try? JSONEncoder().encode(item)) ?? Data(itemID.utf8)
        let digest = SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
        var stmt: OpaquePointer?
        try prepare(db, "INSERT INTO treasure_changes(change_id,item_id,operation,updated_at,origin_device_id,payload_digest) VALUES(?,?,?,?,?,?)", &stmt)
        defer { sqlite3_finalize(stmt) }
        bind(UUID().uuidString, stmt, 1); bind(itemID, stmt, 2); bind(operation, stmt, 3)
        sqlite3_bind_double(stmt, 4, Date().timeIntervalSince1970)
        bind(originDeviceID(), stmt, 5); bind(digest, stmt, 6)
        try stepDone(db, stmt)
    }

    private static func appendDeleteChange(itemID: String, updatedAt: Date,
                                           db: OpaquePointer?) throws {
        let payload = Data("delete:\(itemID):\(updatedAt.timeIntervalSince1970)".utf8)
        let digest = SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
        var stmt: OpaquePointer?
        try prepare(db, "INSERT INTO treasure_changes(change_id,item_id,operation,updated_at,origin_device_id,payload_digest) VALUES(?,?,'delete',?,?,?)", &stmt)
        defer { sqlite3_finalize(stmt) }
        bind(UUID().uuidString, stmt, 1); bind(itemID, stmt, 2)
        sqlite3_bind_double(stmt, 3, updatedAt.timeIntervalSince1970)
        bind(originDeviceID(), stmt, 4); bind(digest, stmt, 5)
        try stepDone(db, stmt)
    }

    private static func enqueueDefaultJobs(for item: CollectedItem, db: OpaquePointer?) throws {
        var types = ["index"]
        if item.kind == .link && !item.metadataFetched { types.insert("metadata", at: 0) }
        let now = Date().timeIntervalSince1970
        for type in types {
            let existing = try scalarInt(
                db,
                sql: "SELECT COUNT(*) FROM treasure_jobs WHERE item_id=? AND job_type=? AND state IN ('queued','processing')",
                bindings: [item.id, type]
            )
            guard existing == 0 else { continue }
            var stmt: OpaquePointer?
            try prepare(db, "INSERT INTO treasure_jobs(id,item_id,job_type,state,attempt_count,created_at,updated_at) VALUES(?,?,?,'queued',0,?,?)", &stmt)
            bind(UUID().uuidString, stmt, 1); bind(item.id, stmt, 2); bind(type, stmt, 3)
            sqlite3_bind_double(stmt, 4, now); sqlite3_bind_double(stmt, 5, now)
            try stepDone(db, stmt); sqlite3_finalize(stmt)
        }
    }

    private func prepareForPersistence(_ item: CollectedItem) ->
        (item: CollectedItem, normalizedURL: String?, contentDigest: String?) {
        let normalized = item.kind == .link ? Self.normalizedURLKey(item.value) : nil
        let digest: String?
        if item.kind == .file,
           SharedContainerStore.isSafeFileName(item.value) {
            digest = Self.sha256(directory.appendingPathComponent("files").appendingPathComponent(item.value))
        } else {
            digest = nil
        }
        return (item, normalized, digest)
    }

    static func normalizedURLKey(_ raw: String) -> String? {
        guard var components = URLComponents(string: raw),
              let scheme = components.scheme?.lowercased(),
              ["http", "https"].contains(scheme), components.host != nil else { return nil }
        components.scheme = scheme
        components.host = components.host?.lowercased()
        components.fragment = nil
        if (scheme == "http" && components.port == 80) || (scheme == "https" && components.port == 443) {
            components.port = nil
        }
        let tracking = Set(["fbclid", "gclid", "mc_cid", "mc_eid"])
        let retainedQueryItems = components.queryItems?
            .filter { !$0.name.lowercased().hasPrefix("utm_") && !tracking.contains($0.name.lowercased()) }
            .sorted { ($0.name, $0.value ?? "") < ($1.name, $1.value ?? "") }
        components.queryItems = retainedQueryItems?.isEmpty == true ? nil : retainedQueryItems
        if components.percentEncodedPath.isEmpty { components.percentEncodedPath = "/" }
        return components.string
    }

    private static func sha256(_ url: URL) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        var hasher = SHA256()
        do {
            while true {
                let data = try handle.read(upToCount: 1_048_576) ?? Data()
                if data.isEmpty { break }
                hasher.update(data: data)
            }
            return hasher.finalize().map { String(format: "%02x", $0) }.joined()
        } catch { return nil }
    }

    private static func findDuplicateID(_ db: OpaquePointer?, normalizedURL: String?,
                                        contentDigest: String?) throws -> String? {
        guard normalizedURL != nil || contentDigest != nil else { return nil }
        var stmt: OpaquePointer?
        try prepare(db, "SELECT id FROM treasure_items WHERE deleted_at IS NULL AND ((? IS NOT NULL AND normalized_url_key=?) OR (? IS NOT NULL AND content_digest=?)) LIMIT 1", &stmt)
        defer { sqlite3_finalize(stmt) }
        bind(normalizedURL, stmt, 1); bind(normalizedURL, stmt, 2)
        bind(contentDigest, stmt, 3); bind(contentDigest, stmt, 4)
        return sqlite3_step(stmt) == SQLITE_ROW ? text(stmt, 0) : nil
    }

    private static func normalizedTags(_ tags: [String]) -> [String] {
        var seen = Set<String>()
        return tags.compactMap { raw in
            let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty, seen.insert(value.folding(options: [.caseInsensitive], locale: .current)).inserted else {
                return nil
            }
            return value
        }
    }

    static func originDeviceID() -> String {
        let key = "leo.treasury.originDeviceID"
        let defaults = UserDefaults(suiteName: SharedContainerStore.appGroupID) ?? .standard
        if let existing = defaults.string(forKey: key), !existing.isEmpty { return existing }
        let seed = CollectionStore.directory?.path ?? SharedContainerStore.appGroupID
        let suffix = SHA256.hash(data: Data(seed.utf8)).prefix(16)
            .map { String(format: "%02x", $0) }.joined()
        let value = "ios-\(suffix)"
        defaults.set(value, forKey: key)
        return value
    }

    private static func syncTimestampMilliseconds(_ date: Date) -> Int64 {
        Int64(date.timeIntervalSince1970 * 1_000)
    }

    static func mimeTypeForContract(_ name: String) -> String? {
        switch (name as NSString).pathExtension.lowercased() {
        case "jpg", "jpeg": return "image/jpeg"
        case "png": return "image/png"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "heic": return "image/heic"
        case "pdf": return "application/pdf"
        case "md": return "text/markdown"
        case "txt": return "text/plain"
        case "mp3": return "audio/mpeg"
        case "m4a": return "audio/mp4"
        case "mp4": return "video/mp4"
        default: return nil
        }
    }

    private static func fileByteCount(_ name: String, in directory: URL?) -> Int {
        guard SharedContainerStore.isSafeFileName(name),
              let directory,
              let values = try? directory.appendingPathComponent(name)
                .resourceValues(forKeys: [.fileSizeKey]) else { return 0 }
        return values.fileSize ?? 0
    }

    private static func metadata(_ db: OpaquePointer?, key: String) throws -> String? {
        var stmt: OpaquePointer?
        try prepare(db, "SELECT value FROM treasury_metadata WHERE key=?", &stmt)
        defer { sqlite3_finalize(stmt) }
        bind(key, stmt, 1)
        return sqlite3_step(stmt) == SQLITE_ROW ? text(stmt, 0) : nil
    }

    private static func setMetadata(_ db: OpaquePointer?, key: String, value: String) throws {
        var stmt: OpaquePointer?
        try prepare(db, "INSERT INTO treasury_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", &stmt)
        defer { sqlite3_finalize(stmt) }
        bind(key, stmt, 1); bind(value, stmt, 2); try stepDone(db, stmt)
    }

    private static func scalarInt(_ db: OpaquePointer?, sql: String,
                                  bindings: [String] = []) throws -> Int {
        var stmt: OpaquePointer?
        try prepare(db, sql, &stmt)
        defer { sqlite3_finalize(stmt) }
        for (offset, value) in bindings.enumerated() { bind(value, stmt, Int32(offset + 1)) }
        guard sqlite3_step(stmt) == SQLITE_ROW else { return 0 }
        return Int(sqlite3_column_int64(stmt, 0))
    }

    private static func stringColumn(_ db: OpaquePointer?, sql: String) throws -> [String] {
        var stmt: OpaquePointer?
        try prepare(db, sql, &stmt)
        defer { sqlite3_finalize(stmt) }
        var values: [String] = []
        while sqlite3_step(stmt) == SQLITE_ROW { values.append(text(stmt, 0)) }
        return values
    }

    private static func text(_ stmt: OpaquePointer?, _ column: Int32) -> String {
        guard let raw = sqlite3_column_text(stmt, column) else { return "" }
        return String(cString: raw)
    }

    private static func optionalText(_ stmt: OpaquePointer?, _ column: Int32) -> String? {
        sqlite3_column_type(stmt, column) == SQLITE_NULL ? nil : text(stmt, column)
    }

    private static func optionalDate(_ stmt: OpaquePointer?, _ column: Int32) -> Date? {
        sqlite3_column_type(stmt, column) == SQLITE_NULL
            ? nil : Date(timeIntervalSince1970: sqlite3_column_double(stmt, column))
    }
}
