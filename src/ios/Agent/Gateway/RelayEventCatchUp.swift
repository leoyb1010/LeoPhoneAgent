//
//  RelayEventCatchUp.swift
//  MinisApp
//
//  [T-leophone-push] 回到前台时补齐"我不在的时候 Mac 上发生了什么"。
//
//  为什么需要它:harness 的 SSE 是拉取式的——手机没连着的时候,那条流
//  根本不存在,事件只躺在 Mac 本地的 NDJSON 里。所以 app 被杀掉/切走
//  期间,Mac 上的审批请求对用户完全不可见,任务就那么挂着。
//
//  leocodebox 现在把关键事件(审批请求、任务终态)主动外推给中继,中继
//  留一份最近事件。这里在 app 回到前台时拉一次:有待审批就发本地通知
//  (复用现有可交互按钮),有任务结束就提示一声。
//
//  与推送(APNs)的关系:这是不依赖推送资格的第一层。PushRegistrar
//  在主机出现时会重登记 token;app 没运行时审批走 APNs(只带
//  machine + approval_id)。这条路继续负责回到前台时对账,两者互补
//  且都按 seq 幂等。
//

import Foundation
import CryptoKit
import UIKit
import UserNotifications

@MainActor
final class RelayEventCatchUp: ObservableObject {
    static let shared = RelayEventCatchUp()

    private var lastSeenAt: Double {
        get { UserDefaults.standard.double(forKey: "leo.relay.events.lastSeenAt") }
        set { UserDefaults.standard.set(newValue, forKey: "leo.relay.events.lastSeenAt") }
    }

    /// 已经提示过的事件指纹,防止同一条重复打扰(中继可能重发)。
    /// 用数组保序,超限淘汰最旧的(全清会瞬间失去去重记忆)。
    private var notified: [String] = []
    private var notifiedSet = Set<String>()
    private var inFlight = false

    /// [T-catchup-surface] 前台时错过的待审批。app 在最前时发系统通知是
    /// 无效动作(用户正看着 app),所以前台走这个已发布属性,由界面显示
    /// 横幅;后台/非活跃才发通知。
    @Published private(set) var missedApprovals: [RelayEventItem] = []

    func clearMissedApprovals() { missedApprovals = [] }

    private init() {
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.catchUp() }
        }
    }

    /// 启动时调一次:观察者已在 init 装好,这里补一轮冷启动对账。
    func activate() {
        Task { await catchUp() }
    }

    func catchUp() async {
        guard !inFlight else { return }
        // 首台可能是直连 Mac(没有中继地址),不能只看它 —— 取第一台
        // 真正能解析出中继地址的主机。
        let client = GatewayHostStore.shared.activeHosts
            .compactMap { GatewayHostStore.shared.client(for: $0) }
            .first { $0.relayEventsURL != nil }
        guard let client else { return }
        inFlight = true
        defer { inFlight = false }

        guard let payload = try? await client.relayEvents(after: lastSeenAt) else { return }
        guard !payload.items.isEmpty else {
            // 空结果也推进水位,但只推进到"本批已看到的最大时间",
            // 不用服务端的 now —— 查询快照与读 now 之间写入的事件
            // 会被永久跳过。
            return
        }

        var approvals: [RelayEventItem] = []
        var highWater = lastSeenAt
        for item in payload.items {
            highWater = max(highWater, item.receivedAt)
            let fingerprint = item.fingerprint
            guard !notifiedSet.contains(fingerprint) else { continue }
            remember(fingerprint)
            switch item.eventName {
            case "approval.request":
                approvals.append(item)
                postApproval(item, hostName: item.machine)
            case "run.failed":
                postSimple(title: "🖥 \(item.machine) 任务失败", body: item.text ?? "")
            case "run.completed":
                postSimple(title: "✅ \(item.machine) 任务完成", body: item.text ?? "")
            default:
                break
            }
        }
        // 前台时通知发不出去(系统会压掉),改由界面显示这批待审批。
        if !approvals.isEmpty {
            missedApprovals = approvals
        }
        lastSeenAt = highWater
    }

    private func remember(_ fingerprint: String) {
        notified.append(fingerprint)
        notifiedSet.insert(fingerprint)
        while notified.count > 400 {
            notifiedSet.remove(notified.removeFirst())
        }
    }

    private func postApproval(_ item: RelayEventItem, hostName: String) {
        guard let sessionId = item.sessionId, let approvalId = item.approvalId else { return }
        // [T-catchup-hostid] 中继报的 machine 名与用户在「我的 Mac」里自取的
        // 名字未必一致;精确匹配失败就退到"唯一一台中继主机",再退到首台。
        // 匹配不上会导致通知按钮回调找不到 host,批准静默失败。
        let hostId = GatewayHostStore.shared.hostMatching(machine: hostName)?.id
        let approval = GatewayApprovalRequest(
            approvalId: approvalId, runId: sessionId,
            choices: ["once", "deny"], command: item.command,
            tool: nil, reason: nil, extras: [:])
        HarnessApprovalNotifier.post(hostId: hostId, hostName: hostName,
                                     sessionId: sessionId, approval: approval)
    }

    private func postSimple(title: String, body: String) {
        // 前台不发终态提示(用户正看着 app),审批则不受此限——它要人拍板。
        guard UIApplication.shared.applicationState != .active else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = String(body.prefix(120))
        content.sound = .default
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: "relay-\(UUID().uuidString)",
                                  content: content, trigger: nil))
    }
}

// MARK: - 中继事件模型

struct RelayEventItem {
    let machine: String
    let receivedAt: Double
    let raw: [String: Any]

    var eventName: String { raw["event"] as? String ?? "" }
    var sessionId: String? { raw["session_id"] as? String }
    var approvalId: String? { raw["approval_id"] as? String ?? raw["request_id"] as? String }
    var command: String? { raw["command"] as? String }
    var text: String? { raw["error"] as? String ?? raw["output"] as? String }
    var seq: Int { raw["seq"] as? Int ?? 0 }

    /// 幂等指纹:同一台机器同一会话同一 seq 只提示一次。
    var fingerprint: String { "\(machine)|\(sessionId ?? "")|\(eventName)|\(seq)" }
}

struct RelayEventPayload {
    let items: [RelayEventItem]
    let now: Double
}

extension LeoAgentClient {
    /// Phase 4 cursor sync. The wire item is metadata-only; body/file bytes are
    /// never included in this automatic pass.
    func syncTreasuryChanges() async {
        if treasurySyncRunning {
            treasurySyncPending = true
            return
        }
        treasurySyncRunning = true
        defer { treasurySyncRunning = false }

        var succeeded = true
        repeat {
            treasurySyncPending = false
            succeeded = await performTreasurySync()
        } while succeeded && treasurySyncPending
    }

    private func performTreasurySync() async -> Bool {
        guard let directory = CollectionStore.directory,
              let root = treasuryRelayRoot else { return false }
        do {
            let store = try TreasurySQLiteStore(directory: directory)
            try await uploadTreasuryChanges(store: store, root: root)
            try await pullTreasuryChanges(store: store, root: root)
            try await serveTreasuryAssetRequests(store: store, root: root)
            return true
        } catch {
            return false
        }
    }

    private nonisolated var treasuryRelayRoot: URL? {
        guard let eventsURL = relayEventsURL,
              let range = eventsURL.absoluteString.range(of: "/relay/api/") else { return nil }
        return URL(string: String(eventsURL.absoluteString[..<range.upperBound]) + "treasury/")
    }

    private nonisolated func treasuryCursorKey(_ root: URL, direction: String) -> String {
        let digest = SHA256.hash(data: Data(root.absoluteString.utf8))
            .map { String(format: "%02x", $0) }.joined()
        return "leo.treasury.sync.\(direction).\(digest)"
    }

    private func treasuryRequest(root: URL, path: String, method: String = "GET",
                                 body: [String: Any]? = nil) async throws -> (Data, HTTPURLResponse) {
        guard let url = URL(string: path, relativeTo: root)?.absoluteURL else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(apiKeyForRelay)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        request.timeoutInterval = 25
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, http)
    }

    private func uploadTreasuryChanges(store: TreasurySQLiteStore, root: URL) async throws {
        let defaults = UserDefaults(suiteName: SharedContainerStore.appGroupID) ?? .standard
        let key = treasuryCursorKey(root, direction: "upload")
        var cursor = Int64(defaults.object(forKey: key) as? Int ?? 0)
        let deviceID = TreasurySQLiteStore.originDeviceID()
        for _ in 0..<20 {
            let changes = try store.changes(afterRowID: cursor, limit: 500)
            guard !changes.isEmpty else { return }
            let contracts = try store.syncContracts(ids: Set(changes.map(\.itemID)))
            var payloadChanges: [[String: Any]] = []
            for change in changes {
                var value: [String: Any] = [
                    "local_sequence": change.sequence,
                    "change_id": change.id,
                    "item_id": change.itemID,
                    "operation": change.operation,
                    "updated_at": change.updatedAt.timeIntervalSince1970,
                    "origin_device_id": deviceID,
                    "payload_digest": change.payloadDigest,
                ]
                if change.operation == "upsert" {
                    guard let contract = contracts[change.itemID] else { break }
                    value["item"] = Self.treasuryMetadata(contract, deviceID: deviceID)
                }
                payloadChanges.append(value)
            }
            guard !payloadChanges.isEmpty else { throw URLError(.cannotParseResponse) }
            let (data, response) = try await treasuryRequest(
                root: root, path: "changes", method: "POST",
                body: ["device_id": deviceID, "changes": payloadChanges]
            )
            guard response.statusCode == 200,
                  let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let ack = (json["ack_local_cursor"] as? NSNumber)?.int64Value,
                  ack > cursor else { throw URLError(.cannotParseResponse) }
            cursor = ack
            defaults.set(Int(cursor), forKey: key)
            if changes.count < 500 { return }
        }
        throw URLError(.dataLengthExceedsMaximum)
    }

    private func pullTreasuryChanges(store: TreasurySQLiteStore, root: URL) async throws {
        let defaults = UserDefaults(suiteName: SharedContainerStore.appGroupID) ?? .standard
        let key = treasuryCursorKey(root, direction: "download")
        var cursor = Int64(defaults.object(forKey: key) as? Int ?? 0)
        for _ in 0..<40 {
            let (data, response) = try await treasuryRequest(
                root: root, path: "changes?after=\(cursor)&limit=500")
            if response.statusCode == 410 {
                try await rebuildTreasurySnapshot(store: store, root: root, cursorKey: key)
                return
            }
            guard response.statusCode == 200,
                  let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let rawChanges = json["changes"] as? [[String: Any]] else {
                throw URLError(.cannotParseResponse)
            }
            var changes: [TreasurySQLiteStore.RemoteChange] = []
            var deliveredCursor = cursor
            for raw in rawChanges {
                guard let sequence = (raw["sequence"] as? NSNumber)?.int64Value,
                      sequence > deliveredCursor else { throw URLError(.cannotParseResponse) }
                deliveredCursor = sequence
                if raw["applied"] as? Bool == false { continue }
                guard let change = Self.remoteTreasuryChange(raw) else {
                    throw URLError(.cannotParseResponse)
                }
                changes.append(change)
            }
            try store.applyRemoteChanges(changes)
            let next = (json["next_cursor"] as? NSNumber)?.int64Value ?? cursor
            guard next == deliveredCursor else { throw URLError(.cannotParseResponse) }
            cursor = next
            defaults.set(Int(cursor), forKey: key)
            if (json["has_more"] as? Bool) != true { return }
        }
        throw URLError(.dataLengthExceedsMaximum)
    }

    private func serveTreasuryAssetRequests(store: TreasurySQLiteStore, root: URL) async throws {
        let deviceID = TreasurySQLiteStore.originDeviceID()
        let encoded = deviceID.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        let (data, response) = try await treasuryRequest(
            root: root, path: "assets/requests?origin_device_id=\(encoded)")
        guard response.statusCode == 200,
              let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let requests = json["requests"] as? [[String: Any]] else {
            throw URLError(.cannotParseResponse)
        }
        for requestValue in requests.prefix(10) {
            guard let requestID = requestValue["id"] as? String,
                  UUID(uuidString: requestID) != nil,
                  let itemID = requestValue["item_id"] as? String,
                  let kind = requestValue["asset_kind"] as? String,
                  requestID.count <= 200, itemID.count <= 200,
                  ["body", "attachment"].contains(kind) else { continue }
            guard let asset = try store.syncAsset(itemID: itemID, kind: kind) else {
                _ = try? await treasuryRequest(
                    root: root, path: "assets/\(requestID)/unavailable", method: "POST",
                    body: ["device_id": deviceID]
                )
                continue
            }
            defer {
                if asset.removeAfterUpload { try? FileManager.default.removeItem(at: asset.fileURL) }
            }
            guard let url = URL(string: "assets/\(requestID)", relativeTo: root)?.absoluteURL else {
                continue
            }
            var upload = URLRequest(url: url)
            upload.httpMethod = "PUT"
            upload.setValue("Bearer \(apiKeyForRelay)", forHTTPHeaderField: "Authorization")
            upload.setValue(deviceID, forHTTPHeaderField: "X-Treasury-Device-ID")
            upload.setValue(asset.digest, forHTTPHeaderField: "X-Treasury-Digest")
            upload.setValue(String(asset.byteCount), forHTTPHeaderField: "X-Treasury-Byte-Count")
            upload.setValue(asset.mimeType, forHTTPHeaderField: "Content-Type")
            upload.timeoutInterval = 120
            let (_, uploadedResponse) = try await session.upload(for: upload, fromFile: asset.fileURL)
            guard let http = uploadedResponse as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else { throw URLError(.cannotWriteToFile) }
        }
    }

    private func rebuildTreasurySnapshot(store: TreasurySQLiteStore, root: URL,
                                         cursorKey: String) async throws {
        var after: Int64 = 0
        var serverCursor: Int64 = 0
        var changes: [TreasurySQLiteStore.RemoteChange] = []
        for _ in 0..<60 {
            let (data, response) = try await treasuryRequest(
                root: root, path: "items?after_sequence=\(after)&limit=1000")
            guard response.statusCode == 200,
                  let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let items = json["items"] as? [[String: Any]] else {
                throw URLError(.cannotParseResponse)
            }
            var pageCursor = after
            for item in items {
                guard let sequence = (item["server_sequence"] as? NSNumber)?.int64Value,
                      sequence > pageCursor,
                      let contract = Self.remoteTreasuryContract(item) else {
                    throw URLError(.cannotParseResponse)
                }
                pageCursor = sequence
                let deleted = (item["deleted_at"] as? NSNumber)?.doubleValue ?? 0
                changes.append(TreasurySQLiteStore.RemoteChange(
                    sequence: sequence, id: "snapshot-\(sequence)-\(contract.id)",
                    itemID: contract.id, operation: deleted > 0 ? "delete" : "upsert",
                    updatedAt: TreasureItemContract.date(from: contract.updatedAt) ?? .distantPast,
                    originDeviceID: contract.originDeviceID,
                    payloadDigest: String(repeating: "0", count: 64), contract: contract
                ))
            }
            after = (json["next_cursor"] as? NSNumber)?.int64Value ?? after
            serverCursor = (json["server_cursor"] as? NSNumber)?.int64Value ?? serverCursor
            guard after == pageCursor, serverCursor >= after else {
                throw URLError(.cannotParseResponse)
            }
            if (json["has_more"] as? Bool) != true {
                try store.applyRemoteChanges(changes)
                let defaults = UserDefaults(suiteName: SharedContainerStore.appGroupID) ?? .standard
                defaults.set(Int(serverCursor), forKey: cursorKey)
                return
            }
        }
        throw URLError(.dataLengthExceedsMaximum)
    }

    private nonisolated static func treasuryMetadata(_ contract: TreasureItemContract,
                                                      deviceID: String) -> [String: Any] {
        let seconds: (String?) -> Any = { raw in
            raw.flatMap(TreasureItemContract.date(from:))?.timeIntervalSince1970 ?? 0
        }
        let bodyAvailable = contract.originalText != nil ||
            (["link", "note", "text"].contains(contract.kind) && contract.bodyRef != nil)
        let attachmentAvailable = ["image", "document", "audio", "video", "artifact"].contains(contract.kind) &&
            contract.bodyRef != nil
        return [
            "id": contract.id, "schema_version": 1, "kind": contract.kind,
            "title": contract.title ?? "", "source_uri": contract.sourceURI ?? "",
            "source_app": contract.sourceApp ?? "", "source_label": contract.sourceLabel,
            "summary": contract.summary ?? "", "annotation": contract.annotation ?? "",
            "tags": contract.tags, "collection_ids": contract.collectionIDs,
            "pinned": contract.pinned, "archived": contract.archived,
            "reading_state": contract.readingState, "reading_progress": contract.readingProgress,
            "created_at": seconds(contract.createdAt), "updated_at": seconds(contract.updatedAt),
            "last_opened_at": seconds(contract.lastOpenedAt),
            "processing_state": contract.processingState,
            "processing_error_code": contract.processingErrorCode ?? "",
            "content_digest": contract.contentDigest ?? "", "byte_count": contract.byteCount,
            "mime_type": contract.mimeType ?? "", "body_available": bodyAvailable,
            "attachment_available": attachmentAvailable, "origin_device_id": deviceID,
            "deleted_at": seconds(contract.deletedAt),
        ]
    }

    private nonisolated static func remoteTreasuryChange(_ raw: [String: Any]) -> TreasurySQLiteStore.RemoteChange? {
        guard let sequence = (raw["sequence"] as? NSNumber)?.int64Value,
              sequence > 0,
              let id = raw["change_id"] as? String,
              !id.isEmpty, id.count <= 200,
              let itemID = raw["item_id"] as? String,
              !itemID.isEmpty, itemID.count <= 200,
              let operation = raw["operation"] as? String,
              ["upsert", "delete"].contains(operation),
              let updated = (raw["updated_at"] as? NSNumber)?.doubleValue,
              updated > 0,
              let origin = raw["origin_device_id"] as? String,
              !origin.isEmpty, origin.count <= 200,
              let digest = raw["payload_digest"] as? String,
              digest.count == 64,
              digest.unicodeScalars.allSatisfy(
                CharacterSet(charactersIn: "0123456789abcdefABCDEF").contains
              ) else { return nil }
        let contract = (raw["item"] as? [String: Any]).flatMap(remoteTreasuryContract)
        if operation == "upsert" && (contract == nil || contract?.id != itemID ||
            contract?.originDeviceID != origin) { return nil }
        return TreasurySQLiteStore.RemoteChange(
            sequence: sequence, id: id, itemID: itemID, operation: operation,
            updatedAt: Date(timeIntervalSince1970: updated), originDeviceID: origin,
            payloadDigest: digest, contract: contract
        )
    }

    private nonisolated static func remoteTreasuryContract(_ raw: [String: Any]) -> TreasureItemContract? {
        guard let id = raw["id"] as? String,
              let kind = raw["kind"] as? String,
              let origin = raw["origin_device_id"] as? String else { return nil }
        let iso: (Any?) -> String? = { value in
            guard let seconds = (value as? NSNumber)?.doubleValue, seconds > 0 else { return nil }
            return TreasureItemContract.string(from: Date(timeIntervalSince1970: seconds))
        }
        let nullableString: (Any?) -> Any = { value in
            guard let text = value as? String, !text.isEmpty else { return NSNull() }
            return text
        }
        guard let created = iso(raw["created_at"]), let updated = iso(raw["updated_at"]) else { return nil }
        let object: [String: Any] = [
            "id": id, "schema_version": 1, "kind": kind,
            "title": raw["title"] as? String ?? "",
            "source_uri": nullableString(raw["source_uri"]),
            "source_app": nullableString(raw["source_app"]),
            "source_label": raw["source_label"] as? String ?? "",
            "original_text": NSNull(), "body_ref": NSNull(), "preview_ref": NSNull(),
            "mime_type": nullableString(raw["mime_type"]),
            "byte_count": (raw["byte_count"] as? NSNumber)?.intValue ?? 0,
            "content_digest": nullableString(raw["content_digest"]),
            "summary": nullableString(raw["summary"]),
            "annotation": nullableString(raw["annotation"]),
            "tags": raw["tags"] as? [String] ?? [],
            "collection_ids": raw["collection_ids"] as? [String] ?? [],
            "pinned": raw["pinned"] as? Bool ?? false,
            "archived": raw["archived"] as? Bool ?? false,
            "reading_state": raw["reading_state"] as? String ?? "none",
            "reading_progress": (raw["reading_progress"] as? NSNumber)?.doubleValue ?? 0,
            "created_at": created, "updated_at": updated,
            "last_opened_at": iso(raw["last_opened_at"]).map { $0 as Any } ?? NSNull(),
            "processing_state": raw["processing_state"] as? String ?? "ready",
            "processing_error_code": nullableString(raw["processing_error_code"]),
            "sync_state": "remote_only", "origin_device_id": origin,
            "deleted_at": iso(raw["deleted_at"]).map { $0 as Any } ?? NSNull(),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
        return try? JSONDecoder().decode(TreasureItemContract.self, from: data)
    }

    /// 中继事件端点的绝对地址。
    ///
    /// 主机地址形如 `https://host/leoagent-relay/relay/api/m/<机器名>`,
    /// 事件端点是同一中继下的 `/relay/api/events`。用字符串回退两级
    /// 不可靠(URL 不做 `..` 归一),所以按 "/m/" 切一刀取中继根。
    /// 不是中继模式(直连某台 Mac)时返回 nil —— 那种拓扑没有中继事件。
    nonisolated var relayEventsURL: URL? {
        guard let harnessBase = harnessBaseURLForRelay else { return nil }
        let full = harnessBase.absoluteString
        guard let range = full.range(of: "/m/", options: .backwards) else { return nil }
        return URL(string: String(full[full.startIndex..<range.lowerBound]) + "/events")
    }

    /// 取中继上暂存的关键事件。`after` 是上次看到的时间水位。
    func relayEvents(after: Double) async throws -> RelayEventPayload {
        guard let base = relayEventsURL,
              var parts = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            return RelayEventPayload(items: [], now: 0)
        }
        parts.queryItems = [URLQueryItem(name: "after", value: String(after))]
        guard let url = parts.url else { return RelayEventPayload(items: [], now: 0) }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(apiKeyForRelay)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 20
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw GatewayError.malformedResponse("not an HTTP response")
        }
        if http.statusCode == 401 || http.statusCode == 403 { throw GatewayError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
            throw GatewayError.http(status: http.statusCode, message: nil)
        }
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let rows = obj["events"] as? [[String: Any]] ?? []
        let items = rows.compactMap { row -> RelayEventItem? in
            guard let event = row["event"] as? [String: Any] else { return nil }
            return RelayEventItem(
                machine: row["machine"] as? String ?? "Mac",
                receivedAt: row["received_at"] as? Double ?? 0,
                raw: event)
        }
        return RelayEventPayload(items: items, now: obj["now"] as? Double ?? 0)
    }
}
