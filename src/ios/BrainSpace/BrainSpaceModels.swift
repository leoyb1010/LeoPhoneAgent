//
//  BrainSpaceModels.swift
//  LeoPhoneAgent
//
//  [brain-space] 资料库 /api 的数据形状与显示格式。只依赖 Foundation,测试目标也编译这份(合同测试)。
//

import Combine
import Foundation

enum BrainSpaceJSON {
    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()
}

// MARK: - Models (archive /api shapes, all optional where the archive may omit them)

struct BrainArchiveSession: Decodable { let token: String }

struct BrainSpaceManifest: Decodable {
    struct Can: Decodable { var upload = false, save = false, share = false, steward = false, web = false }
    var app: Bool
    var can: Can
    var scopes: [String]
}

struct BrainWebSession: Decodable {
    let cookie: String
    let value: String
    let expiresAt: Double
}

struct BrainWall: Decodable {
    struct Item: Decodable, Identifiable, Hashable {
        let id: String
        var capturedAt: String?
        var place: String?
        var event: String?
        var names: [String]?
        var thumbnailUrl: String?
    }
    var items: [Item]
}

struct BrainSpaceMediaRow: Decodable, Identifiable, Hashable {
    let id: String
    var title: String?
    var ext: String?
    var capturedAt: String?
    var mediaKind: String?
    var summary: String?
    var thumbnailUrl: String?

    var isVideo: Bool { mediaKind == "video" || [".mov", ".mp4", ".m4v"].contains((ext ?? "").lowercased()) }
    var thumbPath: String { thumbnailUrl ?? "/api/media/\(id)/thumbnail" }
    var month: String { String((capturedAt ?? "").prefix(7)) }
}

struct BrainSpaceMediaPage: Decodable {
    var items: [BrainSpaceMediaRow]
    var total: Int?
}

struct BrainOnThisDay: Decodable {
    struct Year: Decodable, Identifiable {
        var id: String { year }
        let year: String
        let ago: Int
        let items: [BrainSpaceMediaRow]
    }
    var years: [Year]
}

struct BrainMediaDetail: Decodable {
    struct AI: Decodable { var description: String? }
    struct PlaceGuess: Decodable { var place: String? }
    struct Who: Decodable, Hashable { var id: String?; var name: String }
    let id: String
    var title: String?
    var mediaKind: String?
    var capturedAt: String?
    var place: String?
    var placeGuess: PlaceGuess?
    var ai: AI?
    var who: [Who]?
    var width: Double?
    var height: Double?
    var duration: Double?
    var caption: String?
    var backupStatus: String?

    var isVideo: Bool { mediaKind == "video" }
}

struct BrainFamilyMember: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    var aliases: String?
    var body: String?
    var avatar: String?
    var photos: Int?
    var videos: Int?
    var first: String?
    var last: String?
}

struct BrainFamilyList: Decodable { var items: [BrainFamilyMember] }

struct BrainFamilyReport: Decodable {
    struct Pick: Decodable, Hashable, Identifiable { let id: String; var thumbnailUrl: String?; var capturedAt: String? }
    struct Person: Decodable, Identifiable {
        let id: String
        let name: String
        var avatar: String?
        var photos: Int?
        var videos: Int?
        var days: Int?
        var picks: [Pick]?
        var story: String?
    }
    var month: String?
    var people: [Person]?
}

struct BrainFamilyProfile: Decodable {
    struct Year: Decodable, Identifiable { var id: String { year }; let year: String; var photos: Int?; var videos: Int?; var picks: [BrainFamilyReport.Pick]? }
    struct Companion: Decodable, Identifiable { let id: String; let name: String; var photos: Int?; var avatar: String? }
    struct Place: Decodable, Hashable { let name: String; let count: Int }
    let id: String
    let name: String
    var aliases: String?
    var body: String?
    var avatar: String?
    var photos: Int?
    var videos: Int?
    var first: String?
    var last: String?
    var years: [Year]?
    var companions: [Companion]?
    var places: [Place]?
}

struct BrainButler: Decodable {
    struct Today: Decodable, Hashable { var title: String; var text: String?; var tone: String? }
    struct Log: Decodable, Hashable { var title: String; var state: String?; var tone: String?; var sub: String? }
    struct Brief: Decodable { var text: String? }
    var tone: String?
    var title: String?
    var sub: String?
    var today: [Today]?
    var log: [Log]?
    var brief: Brief?
}

struct BrainSteward: Decodable {
    struct Item: Decodable, Hashable { var glyph: String?; var title: String; var detail: String? }
    struct Proposal: Decodable, Identifiable, Hashable {
        let id: String
        let version: String
        var title: String
        var level: String?
        var detail: String?
        var impact: String?
        var undo: String?
        var how: String?
    }
    var brief: [Item]?
    var proposals: [Proposal]?
}

struct BrainContinuations: Decodable {
    struct Item: Decodable, Identifiable, Hashable {
        let id: String
        var kind: String?
        var title: String
        var detail: String?
        var label: String?
        var href: String?
    }
    var items: [Item]
}

struct BrainAnswerList: Decodable {
    struct Item: Decodable, Identifiable, Hashable {
        let id: String
        var question: String
        var status: String?
        var createdAt: String?
        var snippet: String?
    }
    var items: [Item]
}

struct BrainArchiveAnswer: Decodable {
    struct Source: Decodable, Hashable { var number: Int?; var fileId: String?; var title: String?; var locator: String? }
    struct Result: Decodable { var answer: String?; var sources: [Source]?; var warning: String?; var modelUsed: Bool? }
    let id: String
    var question: String?
    var status: String
    var result: Result?
    var error: String?
}

struct BrainAskReceiptBody: Decodable { let id: String }

struct BrainSearchPage: Decodable {
    struct Match: Decodable, Hashable { var locator: String?; var excerpt: String? }
    struct Item: Decodable, Identifiable, Hashable {
        let id: String
        var title: String?
        var kind: String?
        var ext: String?
        var category: String?
        var summary: String?
        var source: String?
        var match: Match?
        var storedKind: String?
        var mediaKind: String?
        var thumbnailUrl: String?
    }
    var items: [Item]
    var total: Int?
}

struct BrainFileInfo: Decodable {
    let id: String
    var title: String?
    var ext: String?
    var size: Double?
    var category: String?
    var summary: String?
    var sha256: String?
    var privacy: String?
    var originalAvailable: Bool?
    var backupAvailable: Bool?
}

struct BrainOCRStatus: Decodable {
    var sha256: String?
    var requiredPages: [Int]?
    var completedPages: [Int]?
    var failedPages: [Int]?
    var pendingPages: [Int]?
    var applied: Bool?
    var available: Bool?
    var error: String?
}

struct BrainProvenance: Decodable {
    struct Location: Decodable, Identifiable, Hashable {
        let id: String
        var role: String?
        var sourceName: String?
        var relativePath: String?
        var available: Bool?
        var contentVerifiedAt: String?
    }
    var locations: [Location]?
}

struct BrainShareResult: Decodable, Identifiable {
    var id: String { token }
    let token: String
    let path: String
    var expiresAt: String?
    var count: Int?
}

struct BrainUploadState: Decodable {
    struct Receipt: Decodable { var name: String?; var fileId: String?; var restricted: Bool? }
    let id: String
    var name: String?
    var size: Double?
    var received: Double?
    var chunk: Int?
    var state: String?
    var receipt: Receipt?
}

struct BrainUploadList: Decodable { var items: [BrainUploadState] }

// MARK: - Formatting

enum BrainFormat {
    static func day(_ iso: String?) -> String {
        guard let s = iso, s.count >= 10 else { return "" }
        return String(s.prefix(10))
    }

    static func monthTitle(_ ym: String) -> String {
        let p = ym.split(separator: "-")
        guard p.count == 2, let m = Int(p[1]) else { return ym.isEmpty ? "日期不详" : ym }
        return "\(p[0]) 年 \(m) 月"
    }

    static func bytes(_ n: Double?) -> String {
        guard let n else { return "" }
        return ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file)
    }

    /// Photo-library code names (DFAAC949-…-….heic) read as 一张照片 / 一段视频, like the web UI.
    static func niceName(_ s: String) -> String {
        guard let re = try? NSRegularExpression(pattern: "[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\\.(\\w+)", options: [.caseInsensitive]) else { return s }
        var out = s
        for m in re.matches(in: s, range: NSRange(s.startIndex..., in: s)).reversed() {
            guard let r = Range(m.range, in: out), let er = Range(m.range(at: 1), in: s) else { continue }
            let video = ["mov", "mp4", "m4v"].contains(s[er].lowercased())
            out.replaceSubrange(r, with: video ? "一段视频" : "一张照片")
        }
        return out
    }

    /// Model drafts sometimes carry a boilerplate prefix; keep the readable part.
    static func plain(_ s: String?) -> String {
        var t = s ?? ""
        for prefix in ["第二大脑 画面描述（模型看图识别，可能有误）：", "第二大脑 视频理解（模型看片识别，可能有误）："] where t.hasPrefix(prefix) {
            t = String(t.dropFirst(prefix.count))
        }
        return t.replacingOccurrences(of: "\n", with: " ")
    }
}

extension BrainUploadState {
    struct Chunk: Decodable { let received: Double }
}

struct BrainPipelinePage: Decodable {
    struct Stage: Decodable { let key: String; let state: String }
    struct Item: Decodable { let id: String; var stages: [Stage]? }
    var items: [Item]
}

// MARK: - Library search lifecycle

/// 资料页搜索的生命周期(只在内存,不落盘)。输入(防抖)、提交、重试共用一个可取消任务;
/// 每次启动、清空、隐藏、换连接都让 generation 前进,旧请求的成功、失败和 loading 一律不回写。
/// 结果属于 (关键词, 连接 revision):revision 一变(包括隐藏期间错过的变化,在 appear 时核对)立即清空;
/// 重新出现时只在关键词没有结果或上次出错时补搜一次。
/// 网络由 View 注入 `load`,这里不引用 BrainStore / BrainSpaceAPI,纯逻辑测试 target 也能编译。
@MainActor
final class BrainSearchModel: ObservableObject {
    typealias Loader = @MainActor (String) async throws -> BrainSearchPage
    typealias Pause = @MainActor () async throws -> Void
    nonisolated static let debounceNanoseconds: UInt64 = 400_000_000

    @Published var query = "" { didSet { queryChanged(from: oldValue) } }
    @Published private(set) var results: [BrainSearchPage.Item] = []
    @Published private(set) var total = 0
    @Published private(set) var searching = false
    @Published private(set) var error: String?

    private let load: Loader
    private let pause: Pause
    private var task: Task<Void, Never>?
    private var generation = 0
    private var visible = false
    private var revision: Int?
    private var resultsQuery = ""   // keyword the current results belong to; results always belong to `revision`

    init(load: @escaping Loader,
         pause: @escaping Pause = { try await Task.sleep(nanoseconds: BrainSearchModel.debounceNanoseconds) }) {
        self.load = load
        self.pause = pause
    }

    // MARK: Inputs from the view

    func appear(revision newRevision: Int) {
        // Catch a connection change that happened while hidden (onChange is not delivered then).
        if newRevision != revision { invalidateConnection(newRevision) }
        visible = true
        refreshIfNeeded()
    }

    func disappear() {
        visible = false
        cancel()
    }

    func connectionChanged(to newRevision: Int) {
        guard newRevision != revision else { return }
        invalidateConnection(newRevision)
        refreshIfNeeded()
    }

    /// Return key and the error row's retry: immediate, replaces any pending or in-flight search.
    func submit() { start(debounce: false) }

    // MARK: Lifecycle

    private static func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespaces) }

    private func queryChanged(from old: String) {
        guard Self.trimmed(query) != Self.trimmed(old) else { return }
        if visible {
            start(debounce: true)
        } else {
            cancel()
            if Self.trimmed(query).isEmpty { clearResults(); error = nil }
        }
    }

    private func invalidateConnection(_ newRevision: Int) {
        revision = newRevision
        cancel()
        clearResults()
        error = nil
    }

    private func refreshIfNeeded() {
        let q = Self.trimmed(query)
        guard visible, task == nil, !q.isEmpty else { return }
        if resultsQuery != q || error != nil { start(debounce: false) }
    }

    private func start(debounce: Bool) {
        cancel()
        let q = Self.trimmed(query)
        guard !q.isEmpty else { clearResults(); error = nil; return }
        guard visible, let r = revision else { return }
        let g = generation
        error = nil
        searching = true
        // Another keyword's results never show under this one; a same-keyword retry keeps them.
        // (Another connection's results were already cleared by invalidateConnection.)
        if resultsQuery != q { clearResults() }
        task = Task { [weak self] in await self?.run(g, r, q, debounce: debounce) }
    }

    private func run(_ g: Int, _ r: Int, _ q: String, debounce: Bool) async {
        // Every exit closes loading, but only if this is still the newest request.
        defer { finish(g) }
        if debounce {
            do { try await pause() } catch { return }
        }
        guard isCurrent(g, r, q) else { return }
        do {
            let page = try await load(q)
            guard isCurrent(g, r, q) else { return }
            results = page.items
            total = page.total ?? page.items.count
            resultsQuery = q
        } catch {
            // Cancellation is not a network failure.
            guard isCurrent(g, r, q), !(error is CancellationError) else { return }
            clearResults()
            self.error = error.localizedDescription
        }
    }

    private func isCurrent(_ g: Int, _ r: Int, _ q: String) -> Bool {
        !Task.isCancelled && visible && g == generation && r == revision && q == Self.trimmed(query)
    }

    private func finish(_ g: Int) {
        guard g == generation else { return }
        searching = false
        task = nil
    }

    private func cancel() {
        task?.cancel()
        task = nil
        generation &+= 1
        searching = false
    }

    private func clearResults() {
        results = []
        total = 0
        resultsQuery = ""
    }
}

// MARK: - Reader lifecycle

/// 阅读页的读取周期(只在内存,不落盘)。概要、出处、OCR、首批正文在一个结构化任务组里并发,各自到达即发布:
/// 正文先到就能读,不等慢的出处 / OCR;元数据失败不吞掉已到的正文。
/// 周期身份 = (文档, 连接 revision, generation);离开、换文档、换连接都会作废整个周期和进行中的分页。
/// 隐藏时不发请求;重新出现只补还没拿到的部分。网络由 View 注入,这里不引用 BrainStore / BrainSpaceAPI。
@MainActor
final class BrainReaderModel: ObservableObject {
    struct Loaders: Sendable {
        var info: @MainActor @Sendable (String) async throws -> BrainFileInfo
        var provenance: @MainActor @Sendable (String) async throws -> BrainProvenance
        var ocr: @MainActor @Sendable (String) async throws -> BrainOCRStatus
        /// (file id, offset) → one page. The view keeps one BrainClient per reading cycle behind this.
        var chunks: @MainActor @Sendable (String, Int) async throws -> BrainChunkPage
    }
    /// Called once per reading cycle; throws when there is no usable connection.
    typealias Factory = @MainActor () throws -> Loaders

    private enum Part: CaseIterable { case info, provenance, ocr, body }

    @Published private(set) var info: BrainFileInfo?
    @Published private(set) var provenance: BrainProvenance?
    @Published private(set) var ocr: BrainOCRStatus?
    @Published private(set) var chunks: [BrainChunk] = []
    @Published private(set) var chunkTotal = 0
    @Published private(set) var bodyLoading = false
    @Published private(set) var bodyLoaded = false
    @Published private(set) var bodyError: String?
    @Published private(set) var infoError: String?
    @Published private(set) var moreLoading = false
    @Published private(set) var moreError: String?
    @Published var pickedPages: Set<Int> = []

    private let makeLoaders: Factory
    private var loaders: Loaders?
    private var docId: String?
    private var revision: Int?
    private var visible = false
    private var generation = 0
    private var cycle: Task<Void, Never>?
    private var more: Task<Void, Never>?
    private var loaded = Set<Part>()
    /// Server position of the next page: advances by what an accepted page actually covered.
    private var nextOffset = 0

    init(makeLoaders: @escaping Factory) { self.makeLoaders = makeLoaders }

    var hasMore: Bool { bodyLoaded && nextOffset < chunkTotal }

    // MARK: Inputs from the view

    func appear(docId newDoc: String, revision newRevision: Int) {
        if newDoc != docId || newRevision != revision {
            invalidate()
            docId = newDoc
            revision = newRevision
        }
        visible = true
        fillMissing()
    }

    func disappear() {
        visible = false
        cancelAll()
    }

    func connectionChanged(to newRevision: Int) {
        guard newRevision != revision else { return }
        invalidate()
        revision = newRevision
        fillMissing()
    }

    /// Error rows' retry: re-read whatever is still missing (never re-fetches parts already shown).
    func retry() {
        guard visible else { return }
        cancelAll()
        fillMissing()
    }

    /// 「再读 12 段」. Coalesces repeated taps; never runs before the first page or past the last.
    func loadMore() {
        guard visible, more == nil, !bodyLoading, hasMore, let loaders, let id = docId, let r = revision else { return }
        let g = generation
        let offset = nextOffset
        moreLoading = true
        moreError = nil
        more = Task { [weak self] in
            guard let self else { return }
            defer { self.finishMore(g) }
            do {
                let page = try await loaders.chunks(id, offset)
                guard self.isCurrent(g, id, r), offset == self.nextOffset else { return }
                self.chunkTotal = page.total
                guard !page.chunks.isEmpty else {
                    if offset < page.total { self.moreError = "这一批没有读到新段落,可以再试一次" }
                    return
                }
                // Drop ids already shown and ids repeated inside this page; the offset still advances by the raw page size.
                var seen = Set(self.chunks.map(\.id))
                self.chunks += page.chunks.filter { seen.insert($0.id).inserted }
                self.nextOffset = offset + page.chunks.count
            } catch {
                guard self.isCurrent(g, id, r), !(error is CancellationError) else { return }
                self.moreError = error.localizedDescription
            }
        }
    }

    /// Identity of the reading cycle on screen. A write started in one cycle (OCR retry) acts only while it is still current.
    struct Cycle: Equatable, Sendable {
        let docId: String
        let revision: Int
        let generation: Int
    }

    var currentCycle: Cycle? {
        guard visible, let docId, let revision else { return nil }
        return Cycle(docId: docId, revision: revision, generation: generation)
    }

    func isCurrent(_ c: Cycle) -> Bool { c == currentCycle }

    /// After the existing OCR retry POST: refresh the OCR status, only for the cycle that started the retry.
    func reloadOCR(for c: Cycle) async {
        guard isCurrent(c), let loaders else { return }
        guard let o = try? await loaders.ocr(c.docId), isCurrent(c) else { return }
        ocr = o
    }

    // MARK: Cycle

    private func fillMissing() {
        guard visible, cycle == nil, let id = docId, let r = revision else { return }
        let missing = Part.allCases.filter { !loaded.contains($0) }
        guard !missing.isEmpty else { return }
        let l: Loaders
        do {
            l = try makeLoaders()
        } catch {
            bodyError = error.localizedDescription
            return
        }
        loaders = l
        let g = generation
        if missing.contains(.body) { bodyLoading = true; bodyError = nil }
        if missing.contains(.info) { infoError = nil }
        cycle = Task { [weak self] in
            guard let self else { return }
            defer { self.finishCycle(g) }
            await withTaskGroup(of: Void.self) { group in
                for part in missing {
                    group.addTask { await self.load(part, g, id, r, l) }
                }
            }
        }
    }

    private func load(_ part: Part, _ g: Int, _ id: String, _ r: Int, _ l: Loaders) async {
        do {
            switch part {
            case .body:
                let page = try await l.chunks(id, 0)
                guard isCurrent(g, id, r) else { return }
                var seen = Set<String>()
                chunks = page.chunks.filter { seen.insert($0.id).inserted }
                chunkTotal = page.total
                nextOffset = page.chunks.count
                bodyLoaded = true
                bodyLoading = false
            case .info:
                let v = try await l.info(id)
                guard isCurrent(g, id, r) else { return }
                info = v
            case .provenance:
                let v = try await l.provenance(id)
                guard isCurrent(g, id, r) else { return }
                provenance = v
            case .ocr:
                let v = try await l.ocr(id)
                guard isCurrent(g, id, r) else { return }
                ocr = v
                pickedPages = Set(((v.pendingPages ?? []) + (v.failedPages ?? [])).prefix(20))
            }
            loaded.insert(part)
        } catch {
            guard isCurrent(g, id, r) else { return }
            if part == .body { bodyLoading = false }
            guard !(error is CancellationError) else { return }
            switch part {
            case .body: bodyError = error.localizedDescription
            case .info: infoError = error.localizedDescription
            case .provenance, .ocr: break   // optional sections; refilled on the next appear / retry
            }
        }
    }

    private func isCurrent(_ g: Int, _ id: String, _ r: Int) -> Bool {
        !Task.isCancelled && visible && g == generation && id == docId && r == revision
    }

    private func finishCycle(_ g: Int) {
        guard g == generation else { return }
        cycle = nil
        bodyLoading = false
    }

    private func finishMore(_ g: Int) {
        guard g == generation else { return }
        more = nil
        moreLoading = false
    }

    private func cancelAll() {
        cycle?.cancel(); cycle = nil
        more?.cancel(); more = nil
        generation &+= 1
        bodyLoading = false
        moreLoading = false
    }

    /// New document or new connection: nothing from the old one may stay on screen or be written later.
    private func invalidate() {
        cancelAll()
        loaders = nil
        loaded = []
        info = nil; provenance = nil; ocr = nil
        chunks = []; chunkTotal = 0; nextOffset = 0
        bodyLoaded = false; bodyError = nil; infoError = nil; moreError = nil
        pickedPages = []
    }
}
