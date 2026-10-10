import CryptoKit
import Foundation
import Darwin

// Replica wire types and the page decoder live in TailnetSyncWire.swift.
private struct TailnetReceipts: Decodable {
    let replicaId: String
    let receipts: [Receipt]
    struct Receipt: Decodable {
        let changeId: String
        let revision: Int64
        let status: String
        let cursor: Int64
    }
}

private struct TailnetCheckpoint: Codable {
    let cursor: Int64
    let replicaId: String?
    let pendingPage: TailnetPage?
}

private struct TailnetAssetReceipt: Decodable {
    let size: Int
    let offset: Int
    let complete: Bool
}

@available(iOS 17.0, *)
@MainActor
final class TailnetSyncTransport: SyncTransport {
    let name: String
    let capabilities: TransportCapabilities = [.deltaFetch, .assets, .persistence, .conflictDetect]
    private(set) var health = SyncTransportHealth()
    private let client: LeoAgentClient
    private let targetDeviceId: String
    private let stateURL: URL
    private let assetDirectory: URL
    private var cursor: Int64 = 0
    private var replicaId: String?
    private var pendingPage: TailnetPage?
    private var fetchInFlight = false
    private var fullFetchInFlight = false
    private var checkpointInFlight = false
    private var issuedBatch: SyncInboundBatch?
    private var stopped = false
    private let acknowledgementTimeout: TimeInterval
    private var fullFetchTimeoutTask: Task<Void, Never>?
    private var observer: ((SyncInboundBatch) -> Void)?
    private var fullFetchWaiter: CheckedContinuation<Void, Error>?
    /// Changes this phone stored on the replica; their echo in the change feed is
    /// skipped so our own writes (and uploaded assets) are not downloaded back.
    private var sentChangeIds = Set<String>()

    init(client: LeoAgentClient, targetDeviceId: String, stateDirectory: URL? = nil, acknowledgementTimeout: TimeInterval = 30) throws {
        guard let uuid = UUID(uuidString: targetDeviceId) else { throw SyncTransportError.notStarted }
        self.acknowledgementTimeout = max(0.01, acknowledgementTimeout)
        self.client = client
        self.targetDeviceId = uuid.uuidString
        name = "tailnet:\(uuid.uuidString)"
        let root = stateDirectory ?? FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("MinisChat/tailnet-replica/\(uuid.uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        stateURL = root.appendingPathComponent("checkpoint.json")
        assetDirectory = root.appendingPathComponent("assets", isDirectory: true)
        try FileManager.default.createDirectory(at: assetDirectory, withIntermediateDirectories: true)
        if FileManager.default.fileExists(atPath: stateURL.path) {
            // Corrupt durable state must surface; silently resetting risks replay
            // without the pending page that Core has not acknowledged.
            let checkpoint = try JSONDecoder().decode(TailnetCheckpoint.self, from: Data(contentsOf: stateURL))
            guard checkpoint.cursor >= 0 else { throw URLError(.cannotParseResponse) }
            cursor = checkpoint.cursor
            replicaId = checkpoint.replicaId
            pendingPage = checkpoint.pendingPage
        }
    }

    func start() async throws {
        stopped = false
        let remoteId = await client.replicaDeviceId()
        guard await client.replicaReady(),
              remoteId.flatMap({ UUID(uuidString: $0) })?.uuidString == targetDeviceId else {
            throw SyncTransportError.notStarted
        }
        try await checkConnection()
    }

    func stop() async {
        stopped = true
        observer = nil
        fullFetchTimeoutTask?.cancel()
        fullFetchTimeoutTask = nil
        if let waiter = fullFetchWaiter {
            fullFetchWaiter = nil
            waiter.resume(throwing: CancellationError())
        }
    }

    func observe(handler: @escaping (SyncInboundBatch) -> Void) { observer = handler }

    func checkConnection() async throws {
        let (_, response) = try await client.replicaData(path: "/sync/v1/changes?after=0&limit=1")
        guard response.statusCode == 200 else { throw httpError(response) }
        health.succeeded("probe")
    }

    func send(_ batch: SyncOutboundBatch, trigger: SyncSendTrigger) async throws -> [SyncOutcome] {
        var outcomes: [SyncOutcome] = []
        var seen = Set<SyncRecordID>()
        for id in batch.records.map(\.id) + batch.deletes where seen.insert(id).inserted {
            guard UploadPolicy.allowsRecordType(id.type) else { continue }
            guard let ticket = batch.deliveryTickets[id.description] else {
                outcomes.append(.permanentFailure(id, reason: "Missing durable delivery ticket"))
                continue
            }
            do {
                let record = batch.records.first { $0.id == id }
                let change = try await wireChange(ticket: ticket, record: record)
                let payload = try JSONEncoder().encode(["changes": [change]])
                try UploadPolicy.requireUpload(id.type)
                let (data, response) = try await client.replicaData(
                    path: "/sync/v1/changes", method: "POST", body: payload, requestId: ticket.changeId,
                    headers: ["Content-Type": "application/json"])
                if response.statusCode == 409,
                   let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   body["error"] as? String == "changeId reused with different content" {
                    outcomes.append(.permanentFailure(id, reason: "Replica receipt payload mismatch; retain local data and resolve the queued revision"))
                    continue
                }
                guard response.statusCode == 200 else { throw httpError(response) }
                let result = try JSONDecoder().decode(TailnetReceipts.self, from: data)
                guard result.receipts.count == 1,
                      result.receipts[0].changeId == ticket.changeId,
                      result.receipts[0].revision == ticket.revision else {
                    throw URLError(.cannotParseResponse)
                }
                if result.receipts[0].status == "stored" {
                    sentChangeIds.insert(ticket.changeId)
                    outcomes.append(.success(id))
                    health.succeeded("send")
                } else if result.receipts[0].status == "superseded" {
                    // 远端已保存较新版本，但这次修改没有成为有效内容；保留本机
                    // 票据和用户数据，由冲突处理/拉取远端胜者后显式解决。
                    outcomes.append(.permanentFailure(id, reason: "Replica has a newer edit; resolve conflict"))
                } else { throw URLError(.cannotParseResponse) }
            } catch is UploadPolicy.UploadPaused {
                // Preference changed while hashing/uploading. No ACK or error:
                // retain the same durable ticket until the category is enabled.
                continue
            } catch {
                health.failed("send", error: error as NSError)
                outcomes.append(.transientFailure(id, retryAfter: nil))
            }
        }
        return outcomes
    }

    func fetchChanges(trigger: SyncFetchTrigger) async throws -> SyncInboundBatch {
        guard !fullFetchInFlight else { throw SyncTransportError.fetchInFlight }
        return try await loadBatch()
    }

    private func loadBatch() async throws -> SyncInboundBatch {
        guard !fetchInFlight, !checkpointInFlight else { throw SyncTransportError.fetchInFlight }
        guard !stopped else { throw SyncTransportError.notStarted }
        fetchInFlight = true
        defer { fetchInFlight = false }
        do {
            let page: TailnetPage
            if let pendingPage { page = pendingPage }
            else {
                page = try await requestPage(after: cursor)
                try await checkpoint(cursor: cursor, replicaId: replicaId, pending: page)
                pendingPage = page
            }
            // Preserve the final operation for each ID within the page. Core's
            // separate record/delete arrays otherwise reorder delete→recreate.
            var latest: [SyncRecordID: TailnetPage.Entry] = [:]
            for entry in page.changes { latest[entry.change.id] = entry }
            var records: [PortableRecord] = []
            var deletes: [SyncRecordID] = []
            var deletionDates: [SyncRecordID: Date] = [:]
            for entry in latest.values.sorted(by: { $0.cursor < $1.cursor })
            where !sentChangeIds.contains(entry.change.changeId) {
                try Task.checkCancellation()
                guard !stopped else { throw CancellationError() }
                if entry.change.operation == "delete" {
                    deletes.append(entry.change.id)
                    deletionDates[entry.change.id] = entry.change.updatedAt
                }
                else if let record = entry.change.record { records.append(try await portable(record)) }
                else { throw URLError(.cannotParseResponse) }
            }
            let batch = SyncInboundBatch(records: records, deletes: deletes, sourceDeviceId: nil, deletionUpdatedAt: deletionDates)
            issuedBatch = batch
            health.succeeded("fetch")
            return batch
        } catch {
            health.failed("fetch", error: error as NSError)
            throw error
        }
    }

    func acknowledgeInbound(_ batch: SyncInboundBatch) async throws {
        guard let page = pendingPage else { return }
        guard !checkpointInFlight, !fetchInFlight, let issuedBatch,
              issuedBatch.records == batch.records, issuedBatch.deletes == batch.deletes else {
            throw SyncTransportError.fetchInFlight
        }
        do {
            // Commit cursor and consumed inbox together, then mutate memory.
            // If the process dies before this write, the exact page is replayed.
            let next = replicaId == page.replicaId ? max(cursor, page.nextCursor) : page.nextCursor
            // [T-replica-seed] A rebuilt Mac replica lost what the old one had acknowledged.
            let rebuilt = replicaId != nil && replicaId != page.replicaId
            try await checkpoint(cursor: next, replicaId: page.replicaId, pending: nil)
            cursor = next
            replicaId = page.replicaId
            for entry in page.changes { sentChangeIds.remove(entry.change.changeId) }
            pendingPage = nil
            self.issuedBatch = nil
            finishFullFetchPage()
            if rebuilt { SyncV2Bootstrap.startReplicaSeed(name, restart: true) }
        } catch {
            finishFullFetchPage(error: error)
            throw error
        }
    }

    func fullFetch(trigger: SyncFetchTrigger) async throws -> SyncInboundBatch {
        guard !fullFetchInFlight, !fetchInFlight, !checkpointInFlight else { throw SyncTransportError.fetchInFlight }
        guard let observer, !stopped else { throw SyncTransportError.notStarted }
        fullFetchInFlight = true
        defer { fullFetchInFlight = false }
        // Drain a crash-recovered inbox before resetting; never let an old page
        // jump the fresh full-fetch cursor over earlier history.
        if pendingPage != nil { try await deliverPage(observer: observer) }
        try await checkpoint(cursor: 0, replicaId: replicaId, pending: nil)
        cursor = 0
        while true {
            try Task.checkCancellation()
            try await deliverPage(observer: observer)
            if !lastDeliveredHasMore { break }
        }
        return SyncInboundBatch(records: [], deletes: [], sourceDeviceId: nil)
    }

    private var lastDeliveredHasMore = false
    private func deliverPage(observer: (SyncInboundBatch) -> Void) async throws {
        let batch = try await loadBatch()
        lastDeliveredHasMore = pendingPage?.hasMore == true
        if batch.records.isEmpty && batch.deletes.isEmpty { try await acknowledgeInbound(batch); return }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                fullFetchWaiter = continuation
                fullFetchTimeoutTask = Task { [weak self] in
                    guard let self else { return }
                    do { try await Task.sleep(nanoseconds: UInt64(self.acknowledgementTimeout * 1_000_000_000)) }
                    catch { return }
                    self.finishFullFetchPage(error: URLError(.timedOut))
                }
                observer(batch)
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.finishFullFetchPage(error: CancellationError()) }
        }
    }

    private func finishFullFetchPage(error: Error? = nil) {
        fullFetchTimeoutTask?.cancel()
        fullFetchTimeoutTask = nil
        guard let waiter = fullFetchWaiter else { return }
        fullFetchWaiter = nil
        if let error { waiter.resume(throwing: error) } else { waiter.resume() }
    }

    func delete(_ ids: [SyncRecordID]) async throws -> [SyncOutcome] {
        ids.map { .permanentFailure($0, reason: "Delete requires a durable ticket") }
    }

    private func requestPage(after: Int64, limit: Int = TailnetPageDecoder.pageLimit) async throws -> TailnetPage {
        let (data, response) = try await client.replicaData(path: "/sync/v1/changes?after=\(after)&limit=\(limit)")
        if response.statusCode == 409, after > 0 {
            let reset = try await requestPage(after: 0, limit: limit)
            guard let replicaId, reset.replicaId != replicaId else { throw httpError(response) }
            return reset
        }
        guard response.statusCode == 200 else { throw httpError(response) }
        let decoded: (page: TailnetPage, skipped: [TailnetPageDecoder.Skipped])
        do {
            decoded = try TailnetPageDecoder.decode(data, after: after, limit: limit, knownReplicaId: replicaId)
        } catch is TailnetPageDecoder.ReplicaChanged {
            // A rebuilt replica restarts its cursors.
            return try await requestPage(after: 0, limit: limit)
        } catch is TailnetPageDecoder.PageTooLarge {
            // One oversized change must cost one change, not the page forever.
            return try await requestPage(after: after, limit: 1)
        }
        let page = decoded.page
        if !decoded.skipped.isEmpty {
            for skip in decoded.skipped {
                SyncInboundQuarantine.shared.add(
                    recordId: skip.id ?? SyncRecordID(type: "TailnetEntry", id: "\(page.replicaId)#\(skip.cursor)"),
                    record: nil, reason: skip.reason, replayable: false)
            }
            SyncInboundQuarantine.shared.flush()
        }
        return page
    }

    private func checkpoint(cursor: Int64, replicaId: String?, pending: TailnetPage?) async throws {
        guard !checkpointInFlight else { throw SyncTransportError.fetchInFlight }
        checkpointInFlight = true
        defer { checkpointInFlight = false }
        let data = try JSONEncoder().encode(TailnetCheckpoint(cursor: cursor, replicaId: replicaId, pendingPage: pending))
        let url = stateURL
        try await Task.detached(priority: .utility) {
            try data.write(to: url, options: .atomic)
            let file = try FileHandle(forWritingTo: url)
            defer { try? file.close() }
            try file.synchronize()
            let directory = open(url.deletingLastPathComponent().path, O_RDONLY)
            guard directory >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
            defer { close(directory) }
            guard fsync(directory) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        }.value
    }

    private func wireChange(ticket: SyncDeliveryTicket, record: PortableRecord?) async throws -> TailnetChange {
        guard ticket.destination == name, ticket.operation == "delete" || ticket.operation == "upsert",
              ticket.operation == "delete" || record?.id == SyncRecordID(type: ticket.recordType, id: ticket.recordId)
        else { throw URLError(.cannotParseResponse) }
        var wireAssets: [String: TailnetAsset] = [:]
        for (key, asset) in record?.assets ?? [:] {
            let hash = try await sha256(file: asset.fileURL)
            try await upload(asset: asset, hash: hash, recordType: ticket.recordType)
            wireAssets[key] = TailnetAsset(key: key, sha256: hash, size: asset.size, mimeType: asset.mimeType)
        }
        let wire = record.map {
            TailnetRecord(id: $0.id, fields: $0.fields, assets: wireAssets,
                          schemaVersion: $0.schemaVersion, minimumCompatibleVersion: $0.minimumCompatibleVersion,
                          unknownFields: $0.unknownFields, updatedAt: $0.updatedAt)
        }
        return TailnetChange(changeId: ticket.changeId, revision: ticket.revision,
                             id: SyncRecordID(type: ticket.recordType, id: ticket.recordId),
                             operation: ticket.operation,
                             updatedAt: record?.updatedAt ?? ticket.updatedAt, record: wire)
    }

    private func portable(_ record: TailnetRecord) async throws -> PortableRecord {
        var assets: [String: PortableAsset] = [:]
        for (key, asset) in record.assets {
            let url = try await download(asset)
            assets[key] = PortableAsset(key: key, fileURL: url, size: asset.size, mimeType: asset.mimeType)
        }
        return PortableRecord(id: record.id, fields: record.fields, assets: assets,
                              schemaVersion: record.schemaVersion,
                              minimumCompatibleVersion: record.minimumCompatibleVersion,
                              unknownFields: record.unknownFields, updatedAt: record.updatedAt)
    }

    private func upload(asset: PortableAsset, hash: String, recordType: String) async throws {
        try UploadPolicy.requireUpload(recordType)
        guard asset.size >= 0, asset.size <= 256 * 1024 * 1024,
              try asset.fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize == asset.size else { throw URLError(.cannotDecodeContentData) }
        let path = "/sync/v1/assets/\(hash)"
        let (_, head) = try await client.replicaData(path: path, method: "HEAD")
        guard head.statusCode == 200 || head.statusCode == 404 else { throw httpError(head) }
        var offset = 0
        var reset = false
        if head.statusCode == 200 {
            guard let length = Int(head.value(forHTTPHeaderField: "Upload-Length") ?? ""),
                  let uploaded = Int(head.value(forHTTPHeaderField: "Upload-Offset") ?? ""),
                  uploaded >= 0, uploaded <= length else { throw URLError(.cannotParseResponse) }
            if head.value(forHTTPHeaderField: "X-Asset-Complete") == "true" {
                guard length == asset.size, uploaded == asset.size else { throw URLError(.cannotParseResponse) }
                return
            }
            reset = length != asset.size || uploaded == asset.size
            offset = reset ? 0 : uploaded
        }
        let file = try FileHandle(forReadingFrom: asset.fileURL)
        defer { try? file.close() }
        var restartedAfterHashFailure = false
        repeat {
            try Task.checkCancellation()
            guard !stopped else { throw CancellationError() }
            try file.seek(toOffset: UInt64(offset))
            let remaining = asset.size - offset
            let chunk = remaining == 0 ? Data() : try file.read(upToCount: min(1_048_576, remaining)) ?? Data()
            guard chunk.count == min(1_048_576, remaining) else { throw URLError(.cannotDecodeContentData) }
            let end = offset + chunk.count - 1
            let range = asset.size == 0 ? "bytes */0" : "bytes \(offset)-\(end)/\(asset.size)"
            var headers = ["Content-Range": range, "Content-Type": "application/octet-stream"]
            if reset { headers["Upload-Reset"] = "true" }
            try UploadPolicy.requireUpload(recordType)
            let (data, response) = try await client.replicaData(path: path, method: "PUT", body: chunk, headers: headers)
            if response.statusCode == 422, !restartedAfterHashFailure {
                // An interrupted/corrupt earlier partial must not poison every retry.
                restartedAfterHashFailure = true; reset = true; offset = 0
                continue
            }
            guard response.statusCode == 200 else { throw httpError(response) }
            let receipt = try JSONDecoder().decode(TailnetAssetReceipt.self, from: data)
            guard receipt.size == asset.size, receipt.offset == offset + chunk.count,
                  receipt.complete == (receipt.offset == asset.size) else { throw URLError(.cannotParseResponse) }
            offset = receipt.offset
            reset = false
        } while offset < asset.size || reset
    }

    private func download(_ asset: TailnetAsset) async throws -> URL {
        guard asset.size >= 0, asset.size <= 256 * 1024 * 1024,
              asset.sha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
            throw URLError(.cannotParseResponse)
        }
        let final = assetDirectory.appendingPathComponent(asset.sha256)
        if FileManager.default.fileExists(atPath: final.path),
           (try? await sha256(file: final)) == asset.sha256 { return final }
        let partial = assetDirectory.appendingPathComponent(asset.sha256 + ".partial")
        if !FileManager.default.fileExists(atPath: partial.path) {
            guard FileManager.default.createFile(atPath: partial.path, contents: nil) else {
                throw URLError(.cannotCreateFile)
            }
        }
        let file = try FileHandle(forWritingTo: partial)
        defer { try? file.close() }
        var offset = Int(try file.seekToEnd())
        if offset > asset.size { try file.truncate(atOffset: 0); try file.seek(toOffset: 0); offset = 0 }
        while offset < asset.size {
            let end = min(asset.size - 1, offset + 1_048_575)
            let (chunk, response) = try await client.replicaData(path: "/sync/v1/assets/\(asset.sha256)",
                headers: ["Range": "bytes=\(offset)-\(end)"])
            guard response.statusCode == 206 else { throw httpError(response) }
            guard chunk.count == end - offset + 1,
                  response.value(forHTTPHeaderField: "Content-Range") == "bytes \(offset)-\(end)/\(asset.size)",
                  response.value(forHTTPHeaderField: "ETag") == "\"\(asset.sha256)\"" else { throw URLError(.cannotParseResponse) }
            try file.write(contentsOf: chunk)
            offset += chunk.count
        }
        try file.synchronize()
        guard try await sha256(file: partial) == asset.sha256 else {
            try file.truncate(atOffset: 0)
            try file.synchronize()
            throw URLError(.cannotDecodeContentData)
        }
        if FileManager.default.fileExists(atPath: final.path) { try FileManager.default.removeItem(at: final) }
        try FileManager.default.moveItem(at: partial, to: final)
        return final
    }

    private func sha256(file: URL) async throws -> String {
        try await Task.detached(priority: .utility) {
            let handle = try FileHandle(forReadingFrom: file)
            defer { try? handle.close() }
            var digest = SHA256()
            while let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty { digest.update(data: chunk) }
            return digest.finalize().map { String(format: "%02x", $0) }.joined()
        }.value
    }

    private func httpError(_ response: HTTPURLResponse) -> NSError {
        NSError(domain: "TailnetReplicaHTTP", code: response.statusCode)
    }
}
