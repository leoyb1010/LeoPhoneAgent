import Foundation

/// Pure decisions behind the CloudKit recent-window poll and inbound apply
/// order. No CloudKit / UIKit here so the logic test target can drive it.
enum SyncPollPlan {

    /// (recordType, date field) polled by `fetchRecentV2`, newest first.
    ///
    /// SessionV2 is polled by `updatedAt`: its createdAt never moves, so a
    /// title / preview edit on an old session was invisible to the poll and
    /// only reached a peer if the CKSyncEngine token fetch happened to carry it.
    /// Messages/markers stay on createdAt (immutable by id, numerous).
    ///
    /// MCPServersV2 is deliberately absent: no build ever uploaded it, so the
    /// type does not exist in the CloudKit schema and every query only
    /// returned `.unknownItem`. Its merger and zone mapping stay for the
    /// legacy delete.
    static let recentQueries: [(type: String, dateKey: String)] = [
        ("SessionV2", "updatedAt"),
        ("MessageV2", "createdAt"),
        ("CompactMarkerV2", "createdAt"),
        ("SessionFileV2", "updatedAt"),
        ("ArtifactV2", "updatedAt"),
        ("ArtifactVersionV2", "createdAt"),
        ("SkillV2", "updatedAt"),
        ("ProviderConfigV2", "updatedAt"),
        ("ProviderInstanceV3", "updatedAt"),
        ("ProviderModelEntryV3", "updatedAt"),
        ("ProviderModelGroupV3", "updatedAt"),
        ("MCPServerItem", "updatedAt"),
        ("EnvVarItem", "updatedAt"),
        ("SoulV2", "updatedAt"),
        ("MemoryGlobalV2", "updatedAt"),
        ("MemoryDailyV2", "updatedAt"),
    ]

    /// Date field to retry with when the primary sort key is rejected by a
    /// CloudKit environment whose schema has not been given the index yet
    /// (CKError.invalidArguments, "field not queryable/sortable"). Keeps
    /// SessionV2 polling alive on an un-migrated Production schema.
    static func fallbackDateKey(for type: String, primary: String) -> String? {
        (type == "SessionV2" && primary == "updatedAt") ? "createdAt" : nil
    }

    /// Low-volume, long-lived secrets-zone types that pull their full history
    /// until anchored (a fresh device would never see a months-old provider
    /// through the 24 h window).
    static let fullHistoryConfigTypes: Set<String> = [
        "ProviderInstanceV3", "ProviderModelEntryV3", "ProviderModelGroupV3",
        "ProviderConfigV2", "MCPServerItem", "EnvVarItem",
    ]

    /// Types re-pulled in full by the Providers force-sync button.
    static let providerAnchorTypes: [String] = [
        "ProviderInstanceV3", "ProviderModelEntryV3", "ProviderModelGroupV3", "ProviderConfigV2",
    ]

    static let recentWindow: TimeInterval = 24 * 60 * 60
    /// Anchored config types keep a 7-day overlap: they are tiny, and the
    /// wide window absorbs clock skew, delayed pushes and CK index lag that a
    /// 24 h / 5 min window turned into permanently-missed records.
    static let configOverlap: TimeInterval = 7 * 24 * 60 * 60

    /// Query floor for one type. `lastSuccess` is the per-type cursor (0 =
    /// never). Un-anchored full-history types pull everything.
    static func cutoff(type: String, now: Date, lastSuccess: TimeInterval, anchored: Bool) -> Date {
        let isConfig = fullHistoryConfigTypes.contains(type)
        if isConfig && !anchored { return .distantPast }
        let windowStart = now.addingTimeInterval(-recentWindow)
        let normal = lastSuccess > 0 ? max(Date(timeIntervalSince1970: lastSuccess - 300), windowStart) : windowStart
        guard isConfig else { return normal }
        return min(normal, now.addingTimeInterval(-configOverlap))
    }

    /// Anchoring requires TWO consecutive clean full-history pulls with the
    /// same count. CK queries are eventually consistent: one clean pull can
    /// return a subset, and anchoring on it hid the rest behind the
    /// incremental window forever.
    static func anchorDecision(previousPendingCount: Int?, fetched: Int) -> (anchor: Bool, pendingCount: Int?) {
        if let previousPendingCount, previousPendingCount == fetched { return (true, nil) }
        return (false, fetched)
    }

    /// CKError.Code.unknownItem raw value. A per-type query failing with it
    /// means the record type is not in the schema yet (no record of that type
    /// was ever saved): semantically zero records, not a fetch failure.
    static let ckUnknownItemCode = 11
    /// CKError.Code.invalidArguments raw value (unindexed / unsortable field).
    static let ckInvalidArgumentsCode = 12

    static func isEmptySchemaType(ckCode: Int?) -> Bool { ckCode == ckUnknownItemCode }

    // MARK: - Inbound order

    private static let applyRank: [String: Int] = [
        "FolderV2": 0, "SessionV2": 1,
        "MessageV2": 2, "CompactMarkerV2": 2, "SessionFileV2": 2,
    ]

    /// Stable sort: containers before their children, everything else after
    /// in arrival order. A message that precedes its session in one fetch
    /// would otherwise fail the session-exists guard and wait for a retry.
    static func parentsFirst<T>(_ items: [T], type: (T) -> String) -> [T] {
        guard items.count > 1, items.contains(where: { applyRank[type($0)] != nil }) else { return items }
        return items.enumerated().sorted { a, b in
            let ra = applyRank[type(a.element)] ?? 3, rb = applyRank[type(b.element)] ?? 3
            return ra != rb ? ra < rb : a.offset < b.offset
        }.map(\.element)
    }

    // MARK: - Record names

    /// CloudKit's 255 limit is in UTF-8 BYTES. `String.count` counts grapheme
    /// clusters: a 204-character Chinese file name is 612 bytes, and a family
    /// emoji is one Character but 25 bytes. SessionFileV2 names embed
    /// user-controlled paths, so this is reachable.
    static func isValidRecordName(_ name: String) -> Bool {
        guard !name.isEmpty, name.utf8.count <= 255 else { return false }
        if name.hasPrefix("_") { return false }
        if name.hasSuffix(":") { return false }
        if name.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }) { return false }
        return true
    }

    // MARK: - v1 zone delete gate

    enum V1DeleteGate: Equatable {
        /// Local store verifiably empty: a zero threshold cannot reject
        /// anything, so skip the throttle-prone cloud count.
        case proceedWithoutCount
        /// Local store unreadable or inconsistent: never delete the cloud copy
        /// on that reading; suspend until next launch.
        case deferUnreadable
        case requiresCloudCount(localSessions: Int)
    }

    /// `localSessions` / `localMessages` are nil when the store could not be read.
    static func v1DeleteGate(localSessions: Int?, localMessages: Int?) -> V1DeleteGate {
        guard let localSessions else { return .deferUnreadable }
        if localSessions > 0 { return .requiresCloudCount(localSessions: localSessions) }
        guard let localMessages else { return .deferUnreadable }
        return localMessages == 0 ? .proceedWithoutCount : .deferUnreadable
    }

    enum V1DeleteVerdict: Equatable {
        case proceed
        /// Count unavailable (throttle/network): a deferral, not a failure, so
        /// it does not burn the 5-attempt cap inside one throttle window.
        case deferUntilNextLaunch
        case abortSafeguard(minimum: Int)
    }

    static func v1DeleteVerdict(localSessions: Int, cloudCount: Int?) -> V1DeleteVerdict {
        guard let cloudCount else { return .deferUntilNextLaunch }
        let minimum = max(0, localSessions / 2)
        return cloudCount < minimum ? .abortSafeguard(minimum: minimum) : .proceed
    }

    // MARK: - Outbound batch cut

    /// CloudKit's per-request record cap.
    static let maxBatchRecords = 250
    static let smallBatchBytes = 1 * 1024 * 1024
    static let assetBatchBytes = 8 * 1024 * 1024

    /// Choose which pending records go in the next CKSyncEngine batch.
    ///
    /// Bounded by BYTES, not a flat 20 records: memory tracks payload size,
    /// and a flat count throttled thousands of small text records to a crawl.
    /// Records without assets go first (≤1 MB); asset-bearing records only
    /// when no small record waits (≤8 MB), so a finished turn is not queued
    /// behind megabytes of files. The first record is always admitted so one
    /// oversized record cannot stall the queue. Returns the selected indices
    /// and the overflow in resend order (small before assets).
    static func batchCut(hasAsset: [Bool], bytes: [Int], deleteCount: Int)
        -> (selected: [Int], overflow: [Int], assets: Bool) {
        let room = max(0, maxBatchRecords - min(deleteCount, maxBatchRecords))
        let small = hasAsset.indices.filter { !hasAsset[$0] }
        let large = hasAsset.indices.filter { hasAsset[$0] }
        let useAssets = small.isEmpty
        let source = useAssets ? large : small
        var budget = useAssets ? assetBatchBytes : smallBatchBytes
        var selected: [Int] = []
        for i in source {
            if selected.count >= room { break }
            if !selected.isEmpty && budget <= 0 { break }
            selected.append(i)
            budget -= bytes[i]
        }
        let chosen = Set(selected)
        return (selected, (small + large).filter { !chosen.contains($0) }, useAssets)
    }

    /// CKError codes that heal on their own (rate limit, zone busy, service
    /// unavailable, network unavailable/failure, internal error).
    static let transientCKCodes: Set<Int> = [7, 23, 6, 3, 4, 1]
}
