import Foundation

/// Media is private even when a server omits its privacy field. This contract
/// deliberately has no cloud-tool formatter or response-provided URL fields.
struct BrainMediaItem: Decodable, Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let privacy: BrainPrivacy
    let kind: String
    let capturedAt: String?
    let place: String?
    let description: String?
    let ocr: String?
    let duration: Double?
    let segments: [Segment]
    struct Segment: Decodable, Equatable, Sendable {
        let start: Double
        let end: Double?
        let text: String
        let method: String?
    }
    var isVideo: Bool { kind == "video" }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: BrainAnyKey.self)
        id = c.loose("id") ?? ""
        guard !id.isEmpty else { throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Missing media id")) }
        title = c.loose("caption") ?? c.loose("title") ?? "影像"
        privacy = BrainPrivacy(raw: c.loose("privacy"))
        kind = c.loose("media_kind") ?? "photo"
        capturedAt = c.loose("captured_at"); place = c.loose("place")
        description = c.nested("ai")?.loose("description") ?? c.loose("semantic_description")
        ocr = c.loose("ocr"); duration = c.double("duration")
        segments = (try? c.decode([Segment].self, forKey: BrainAnyKey("segments"))) ?? []
    }
}
struct BrainMediaPage: Decodable, Sendable {
    let items: [BrainMediaItem]
    let total: Int
    let warning: String?
    let hiddenSensitive: Int
    let nextOffset: Int?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: BrainAnyKey.self)
        items = try c.decode([BrainMediaItem].self, forKey: BrainAnyKey("items"))
        total = c.int("total") ?? 0
        warning = c.loose("warning")
        hiddenSensitive = max(0, c.int("hidden_sensitive") ?? 0)
        nextOffset = c.int("next_offset")
    }
    func resumeOffset(after offset: Int) -> Int {
        max(offset, nextOffset ?? (offset + items.count + hiddenSensitive))
    }
}

enum BrainWorkspaceScope: String, CaseIterable, Identifiable {
    case all, files, photos, videos, cards
    var id: String { rawValue }
    var title: String {
        switch self { case .all: "全库"; case .files: "文件"; case .photos: "图片"; case .videos: "视频"; case .cards: "知识卡" }
    }
    var symbol: String {
        switch self { case .all: "square.grid.2x2"; case .files: "doc.text"; case .photos: "photo"; case .videos: "video"; case .cards: "rectangle.on.rectangle" }
    }
    var isMedia: Bool { self == .photos || self == .videos }
    var mediaKind: String { self == .videos ? "video" : self == .photos ? "photo" : "all" }
}

extension BrainEndpoint {
    func mediaSearch(query: String, kind: String, offset: Int = 0, limit: Int = 24) -> URL {
        url("/v1/media/search", query: [("q", query), ("kind", ["photo", "video"].contains(kind) ? kind : "all"),
            ("offset", String(max(0, offset))), ("limit", String(min(50, max(1, limit))))])
    }
    func media(_ id: String, variant: String? = nil) -> URL {
        let suffix = variant.flatMap { ["thumbnail", "preview", "video"].contains($0) ? "/" + $0 : nil } ?? ""
        return url("/v1/media/\(Self.pathComponent(id))" + suffix)
    }
}
