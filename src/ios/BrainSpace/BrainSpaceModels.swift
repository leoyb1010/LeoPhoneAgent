//
//  BrainSpaceModels.swift
//  LeoPhoneAgent
//
//  [brain-space] 资料库 /api 的数据形状与显示格式。只依赖 Foundation,测试目标也编译这份(合同测试)。
//

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

struct BrainMediaRow: Decodable, Identifiable, Hashable {
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

struct BrainMediaPage: Decodable {
    var items: [BrainMediaRow]
    var total: Int?
}

struct BrainOnThisDay: Decodable {
    struct Year: Decodable, Identifiable {
        var id: String { year }
        let year: String
        let ago: Int
        let items: [BrainMediaRow]
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
