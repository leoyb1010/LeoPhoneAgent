import Foundation

/// Replica wire types. Dates deliberately use JSONEncoder's default Apple epoch,
/// matching the Mac replica's portable field/date contract.
struct TailnetAsset: Codable {
    let key: String
    let sha256: String
    let size: Int
    let mimeType: String?
}

struct TailnetRecord: Codable {
    let id: SyncRecordID
    let fields: [String: PortableFieldValue]
    let assets: [String: TailnetAsset]
    let schemaVersion: Int
    let minimumCompatibleVersion: Int?
    let unknownFields: [String: PortableFieldValue]
    let updatedAt: Date
}

struct TailnetChange: Codable {
    let changeId: String
    let revision: Int64
    let id: SyncRecordID
    let operation: String
    let updatedAt: Date
    let record: TailnetRecord?
}

struct TailnetPage: Codable {
    let replicaId: String
    let changes: [Entry]
    let nextCursor: Int64
    let hasMore: Bool
    struct Entry: Codable {
        let cursor: Int64
        let senderDeviceId: String
        let change: TailnetChange
    }
}

/// Decodes one change-feed page without letting a single bad entry stall the
/// cursor. Structural problems (cursor order, foreign replica) still throw;
/// an entry whose payload cannot be decoded or is not well-formed is skipped
/// — reported for quarantine — while the page (and cursor) advance past it.
/// A page over the byte cap is refetched one change at a time, and a single
/// change over the cap is skipped by cursor, never by range.
enum TailnetPageDecoder {
    static let maxPageBytes = 5 * 1024 * 1024
    static let pageLimit = 100

    struct Skipped: Equatable {
        let cursor: Int64
        let id: SyncRecordID?
        let reason: String
    }

    /// Thrown when a multi-change page is over the byte cap: ask again with limit 1.
    struct PageTooLarge: Error {}
    /// The replica was rebuilt (new id): its cursors restart, refetch from 0.
    struct ReplicaChanged: Error {}

    /// Same bounds the downloader enforces; a descriptor outside them can
    /// never download, so the entry is skipped instead of failing forever.
    static func isValidAsset(_ asset: TailnetAsset) -> Bool {
        asset.size >= 0 && asset.size <= 256 * 1024 * 1024
            && asset.sha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
    }

    static func decode(_ data: Data, after: Int64, limit: Int,
                       knownReplicaId: String? = nil) throws -> (page: TailnetPage, skipped: [Skipped]) {
        if data.count > maxPageBytes {
            guard limit <= 1 else { throw PageTooLarge() }
            return try skipOversizeEntry(data, after: after, knownReplicaId: knownReplicaId)
        }
        let wire = try JSONDecoder().decode(WirePage.self, from: data)
        if let knownReplicaId, after > 0, wire.replicaId != knownReplicaId { throw ReplicaChanged() }
        guard UUID(uuidString: wire.replicaId) != nil, wire.nextCursor >= after,
              wire.changes.count <= max(limit, 1) else { throw URLError(.cannotParseResponse) }
        var previous = after
        var kept: [TailnetPage.Entry] = []
        var skipped: [Skipped] = []
        for item in wire.changes {
            guard item.cursor > previous, item.cursor <= wire.nextCursor else { throw URLError(.cannotParseResponse) }
            previous = item.cursor
            guard let entry = item.entry else {
                skipped.append(.init(cursor: item.cursor, id: item.id, reason: "undecodableTailnetEntry"))
                continue
            }
            let change = entry.change
            let wellFormed = !change.id.id.isEmpty && !change.id.type.isEmpty
                && (change.operation == "upsert" || change.operation == "delete")
                && (change.operation == "delete" || change.record?.id == change.id)
                && (change.record?.assets.values.allSatisfy(isValidAsset) ?? true)
            guard wellFormed else {
                skipped.append(.init(cursor: item.cursor, id: change.id, reason: "malformedTailnetEntry"))
                continue
            }
            kept.append(entry)
        }
        guard wire.nextCursor == previous, !wire.hasMore || !wire.changes.isEmpty else {
            throw URLError(.cannotParseResponse)
        }
        return (TailnetPage(replicaId: wire.replicaId, changes: kept,
                            nextCursor: wire.nextCursor, hasMore: wire.hasMore), skipped)
    }

    /// One change larger than a whole page: read only its envelope and step
    /// over it. The bytes are already in memory; nothing else is decoded.
    private static func skipOversizeEntry(_ data: Data, after: Int64,
                                          knownReplicaId: String?) throws -> (page: TailnetPage, skipped: [Skipped]) {
        let skeleton = try JSONDecoder().decode(SkeletonPage.self, from: data)
        if let knownReplicaId, after > 0, skeleton.replicaId != knownReplicaId { throw ReplicaChanged() }
        guard UUID(uuidString: skeleton.replicaId) != nil, skeleton.changes.count == 1,
              let only = skeleton.changes.first, only.cursor > after,
              skeleton.nextCursor == only.cursor else { throw URLError(.cannotParseResponse) }
        return (TailnetPage(replicaId: skeleton.replicaId, changes: [],
                            nextCursor: only.cursor, hasMore: skeleton.hasMore),
                [Skipped(cursor: only.cursor, id: only.change?.id, reason: "oversizeTailnetEntry")])
    }

    private struct WirePage: Decodable {
        let replicaId: String
        let changes: [LenientEntry]
        let nextCursor: Int64
        let hasMore: Bool
    }

    /// The full entry when it decodes; otherwise just enough to step past it.
    private struct LenientEntry: Decodable {
        let cursor: Int64
        let entry: TailnetPage.Entry?
        let id: SyncRecordID?

        init(from decoder: Decoder) throws {
            if let full = try? TailnetPage.Entry(from: decoder) {
                entry = full
                cursor = full.cursor
                id = full.change.id
            } else {
                let skeleton = try SkeletonEntry(from: decoder)
                entry = nil
                cursor = skeleton.cursor
                id = skeleton.change?.id
            }
        }
    }

    private struct SkeletonPage: Decodable {
        let replicaId: String
        let changes: [SkeletonEntry]
        let nextCursor: Int64
        let hasMore: Bool
    }

    private struct SkeletonEntry: Decodable {
        let cursor: Int64
        let change: SkeletonChange?

        private enum CodingKeys: String, CodingKey { case cursor, change }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            cursor = try c.decode(Int64.self, forKey: .cursor)
            change = try? c.decodeIfPresent(SkeletonChange.self, forKey: .change)
        }
    }

    private struct SkeletonChange: Decodable {
        let id: SyncRecordID?
        private enum CodingKeys: String, CodingKey { case id }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try? c.decodeIfPresent(SyncRecordID.self, forKey: .id)
        }
    }
}
