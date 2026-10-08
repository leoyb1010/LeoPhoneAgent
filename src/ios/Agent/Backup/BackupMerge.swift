import Foundation

/// Pure MERGE rules for restore (never replace, never delete local data).
///
/// Everything here is free of store dependencies so the exact decision the
/// live restore makes is the one the logic tests exercise.
enum BackupMerge {

    // MARK: - Records (LWW on updated_at)

    enum Decision: Equatable, Sendable {
        case insert
        case update
        /// Local copy is newer or the same age — Merge keeps it.
        case keepLocal
    }

    /// Strictly-newer wins. Timestamps are compared at whole-second precision
    /// because packages carry ISO-8601 seconds: restoring a backup onto the
    /// device that made it must be a no-op, not a rewrite of every row.
    static func decide(local: Date?, incoming: Date) -> Decision {
        guard let local else { return .insert }
        return incoming.timeIntervalSince1970.rounded(.down) > local.timeIntervalSince1970.rounded(.down)
            ? .update : .keepLocal
    }

    // MARK: - Files

    enum FileDecision: Equatable, Sendable {
        case write          // absent locally
        case replace        // package copy is newer
        case identical      // same bytes
        case keepLocal      // local differs and is newer (or age unknown)
    }

    /// `localSha` is only computed by the caller when the file exists.
    static func decideFile(localExists: Bool, localSha: String?, localMtime: Date?,
                           packageSha: String, packageMtime: Double?) -> FileDecision {
        guard localExists else { return .write }
        if localSha == packageSha { return .identical }
        // Foreign packages carry no mtime: an existing, different local file
        // is the user's current data and is kept.
        guard let packageMtime, let localMtime else { return .keepLocal }
        return packageMtime.rounded(.down) > localMtime.timeIntervalSince1970.rounded(.down) ? .replace : .keepLocal
    }

    // MARK: - Providers (JSON-level, union by id, local wins)

    struct ProviderStats: Equatable, Sendable {
        var instancesAdded = 0
        var instancesKept = 0
        var instancesSkippedDeleted = 0
        var entriesAdded = 0
        var groupsAdded = 0
        var groupsRenamed = 0
        var groupsKept = 0
        var changed: Bool {
            instancesAdded + entriesAdded + groupsAdded > 0
        }
    }

    /// Merge a package's `provider_config.json` into the local config.
    ///
    /// * Instances / groups: union by id. An id present locally keeps the
    ///   LOCAL content (instances carry no per-row timestamp, so local wins).
    ///   The package decides POSITION for the items it carries; local-only
    ///   items follow in their local order.
    /// * An id the user deleted locally AFTER the backup was taken stays
    ///   deleted (tombstone newer than the snapshot); an older tombstone is
    ///   dropped so sync doesn't immediately re-delete the restored item.
    /// * Model entries: added when their (instance, model id) key is absent
    ///   and their instance survives the merge.
    /// * A restored group whose NAME collides with a different local group is
    ///   renamed "<name>（备份）" instead of silently shadowing it.
    /// * Per-device pointers (default groups, voice groups) are adopted only
    ///   when the local value is unset; session bindings are unioned with
    ///   local winning.
    static func mergeProviderConfig(local: [String: Any], backup: [String: Any],
                                    backupSnapshotAt: Date?) -> (merged: [String: Any], stats: ProviderStats) {
        var stats = ProviderStats()
        var out = local
        let snapshot = backupSnapshotAt ?? .distantPast

        func array(_ d: [String: Any], _ k: String) -> [[String: Any]] { (d[k] as? [[String: Any]]) ?? [] }
        func id(_ d: [String: Any]) -> String? { d["id"] as? String }
        func tombstones(_ k: String) -> [String: Date] {
            var m: [String: Date] = [:]
            for t in array(local, k) {
                guard let tid = t["id"] as? String else { continue }
                m[tid] = date(t["deletedAt"]) ?? .distantFuture
            }
            return m
        }
        var droppedTombstones: [String: Set<String>] = [:]
        func deletedAfterBackup(_ tid: String, _ k: String, _ tombs: [String: Date]) -> Bool {
            guard let at = tombs[tid] else { return false }
            if at > snapshot { return true }
            droppedTombstones[k, default: []].insert(tid)
            return false
        }

        // Instances
        let localInstances = array(local, "instances")
        let localInstanceIds = Set(localInstances.compactMap(id))
        let instanceTombs = tombstones("deletedInstances")
        var mergedInstances: [[String: Any]] = []
        var placed = Set<String>()
        for bi in array(backup, "instances") {
            guard let bid = id(bi), !placed.contains(bid) else { continue }
            if let li = localInstances.first(where: { id($0) == bid }) {
                mergedInstances.append(li); stats.instancesKept += 1
            } else if deletedAfterBackup(bid, "deletedInstances", instanceTombs) {
                stats.instancesSkippedDeleted += 1
                continue
            } else {
                mergedInstances.append(bi); stats.instancesAdded += 1
            }
            placed.insert(bid)
        }
        for li in localInstances where !placed.contains(id(li) ?? "") { mergedInstances.append(li) }
        out["instances"] = mergedInstances
        let survivingInstances = Set(mergedInstances.compactMap(id))

        // Model entries
        func entryKey(_ e: [String: Any]) -> String? {
            guard let inst = e["providerInstanceId"] as? String,
                  let model = (e["model"] as? [String: Any])?["id"] as? String else { return nil }
            return "\(inst)/\(model)"
        }
        var entries = array(local, "modelEntries")
        var entryKeys = Set(entries.compactMap(entryKey))
        let entryUUIDs = Set(entries.compactMap { $0["uuid"] as? String })
        let entryTombs = tombstones("deletedModelEntries")
        for be in array(backup, "modelEntries") {
            guard let key = entryKey(be), let inst = be["providerInstanceId"] as? String,
                  survivingInstances.contains(inst), !entryKeys.contains(key) else { continue }
            if let uuid = be["uuid"] as? String, entryUUIDs.contains(uuid) { continue }
            let uuid = be["uuid"] as? String ?? ""
            if deletedAfterBackup(key, "deletedModelEntries", entryTombs)
                || deletedAfterBackup(uuid, "deletedModelEntries", entryTombs) { continue }
            // Entries of a locally existing instance only come back if the
            // user had customised them — API-truth lists belong to this
            // device's own refresh.
            if localInstanceIds.contains(inst) {
                let custom = (be["isCustom"] as? Bool) == true || be["userModifiedAt"] != nil
                guard custom else { continue }
            }
            entries.append(be)
            entryKeys.insert(key)
            stats.entriesAdded += 1
        }
        out["modelEntries"] = entries

        // Groups
        let localGroups = array(local, "modelGroups")
        let groupTombs = tombstones("deletedModelGroups")
        var takenNames = Set(localGroups.compactMap { $0["name"] as? String })
        var mergedGroups: [[String: Any]] = []
        var placedGroups = Set<String>()
        for bg in array(backup, "modelGroups") {
            guard let gid = id(bg), !placedGroups.contains(gid) else { continue }
            if let lg = localGroups.first(where: { id($0) == gid }) {
                mergedGroups.append(lg); stats.groupsKept += 1
            } else if deletedAfterBackup(gid, "deletedModelGroups", groupTombs) {
                continue
            } else {
                var g = bg
                if let name = g["name"] as? String, takenNames.contains(name) {
                    let base = "\(name)（备份）"
                    var candidate = base
                    var n = 2
                    while takenNames.contains(candidate) { candidate = "\(base) \(n)"; n += 1 }
                    g["name"] = candidate
                    stats.groupsRenamed += 1
                }
                if let name = g["name"] as? String { takenNames.insert(name) }
                mergedGroups.append(g); stats.groupsAdded += 1
            }
            placedGroups.insert(gid)
        }
        for lg in localGroups where !placedGroups.contains(id(lg) ?? "") { mergedGroups.append(lg) }
        out["modelGroups"] = mergedGroups
        let survivingGroups = Set(mergedGroups.compactMap(id))

        // Additive id lists
        for key in ["agentLoopModelEntryIds", "agentLoopGroupIds"] {
            var list = (local[key] as? [String]) ?? []
            var seen = Set(list)
            for v in (backup[key] as? [String]) ?? [] where !seen.contains(v) {
                list.append(v); seen.insert(v)
            }
            out[key] = list
        }

        // Pointers: adopt only when unset locally and the target exists.
        for key in ["defaultPrimaryGroupId", "defaultSubGroupId", "voiceInputGroupId", "voiceOutputGroupId"] {
            if local[key] == nil || local[key] is NSNull,
               let v = backup[key] as? String, survivingGroups.contains(v) {
                out[key] = v
            }
        }
        // Session-keyed maps: union, local wins.
        for key in ["sessionBindings", "sessionInferenceConfigs"] {
            var m = (local[key] as? [String: Any]) ?? [:]
            for (k, v) in (backup[key] as? [String: Any]) ?? [:] where m[k] == nil { m[k] = v }
            out[key] = m
        }

        // Drop tombstones older than the backup for ids we just restored.
        for (key, ids) in droppedTombstones {
            out[key] = array(local, key).filter { !ids.contains(($0["id"] as? String) ?? "") }
        }
        return (out, stats)
    }

    /// Dates inside provider JSON may be ISO strings (package) or numbers.
    private static func date(_ v: Any?) -> Date? {
        if let s = v as? String { return BackupDates.parse(s) }
        if let n = v as? Double { return Date(timeIntervalSince1970: n) }
        return nil
    }

    // MARK: - MCP servers

    struct MCPPlan: Equatable, Sendable {
        var added: [String] = []
        var replaced: [String] = []
        var kept: [String] = []
        /// Added entries whose secrets were redacted at export.
        var needsSecrets: [String] = []
    }

    static let redactionMarker = "_leoRedacted"

    /// `{"mcpServers": {name: entry}}` maps → which entries to write.
    /// Same name: the newer `updatedAt` (fallback `createdAt`) wins; a
    /// redacted package entry never replaces a local one.
    static func mergeMCPServers(local: [String: Any], backup: [String: Any])
        -> (toApply: [String: Any], plan: MCPPlan) {
        let localServers = (local["mcpServers"] as? [String: Any]) ?? [:]
        let backupServers = (backup["mcpServers"] as? [String: Any]) ?? [:]
        var plan = MCPPlan()
        var toApply: [String: Any] = [:]
        for name in backupServers.keys.sorted() {
            guard let be = backupServers[name] as? [String: Any] else { continue }
            let redacted = (be[redactionMarker] as? Bool) == true
            var clean = be
            clean.removeValue(forKey: redactionMarker)
            if let le = localServers[name] as? [String: Any] {
                let l = (le["updatedAt"] as? Double) ?? (le["createdAt"] as? Double) ?? 0
                let b = (be["updatedAt"] as? Double) ?? (be["createdAt"] as? Double) ?? 0
                if !redacted, b.rounded(.down) > l.rounded(.down) {
                    toApply[name] = clean; plan.replaced.append(name)
                } else {
                    plan.kept.append(name)
                }
            } else {
                toApply[name] = clean; plan.added.append(name)
                if redacted { plan.needsSecrets.append(name) }
            }
        }
        return (toApply, plan)
    }

    /// For an unencrypted package: blank header / env values and strip URL
    /// credentials and query (keys often ride in `?key=`). Pure `$VAR` /
    /// `$$VAR` / `${VAR}` references are kept — they are names, not secrets.
    static func redactMCPServers(_ root: [String: Any]) -> (redacted: [String: Any], count: Int) {
        guard let servers = root["mcpServers"] as? [String: Any] else { return (root, 0) }
        var out: [String: Any] = [:]
        var count = 0
        for (name, raw) in servers {
            guard var e = raw as? [String: Any] else { continue }
            var touched = false
            for key in ["headers", "env"] {
                guard let m = e[key] as? [String: Any] else { continue }
                var clean: [String: Any] = [:]
                for (k, v) in m {
                    if let s = v as? String, isVariableReference(s) { clean[k] = s }
                    else { clean[k] = ""; touched = true }
                }
                e[key] = clean
            }
            if let url = e["url"] as? String, var comps = URLComponents(string: url),
               comps.query != nil || comps.user != nil || comps.password != nil || comps.fragment != nil {
                comps.query = nil; comps.user = nil; comps.password = nil; comps.fragment = nil
                e["url"] = comps.string ?? ""
                touched = true
            }
            if let args = e["args"] as? [String], args.contains(where: looksLikeSecretArgument) {
                e["args"] = args.map { looksLikeSecretArgument($0) ? "" : $0 }
                touched = true
            }
            if touched { e[redactionMarker] = true; count += 1 }
            out[name] = e
        }
        var r = root
        r["mcpServers"] = out
        return (r, count)
    }

    static func isVariableReference(_ s: String) -> Bool {
        s.range(of: #"^\$\$?(\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$"#, options: .regularExpression) != nil
    }

    /// `--api-key=…`, `token=…`, `Bearer …` style arguments.
    private static func looksLikeSecretArgument(_ s: String) -> Bool {
        s.range(of: #"(?i)(api[-_]?key|token|secret|password|bearer)\s*[=: ]\s*\S+"#,
                options: .regularExpression) != nil
    }

    // MARK: - Environment variables / thinking rules

    /// Variables whose KEY is new locally. Existing keys keep their local
    /// entry AND value; restoring twice is a no-op.
    static func envVarsToAdd(localKeys: Set<String>, backup: [BackupEnvVarRecord]) -> [BackupEnvVarRecord] {
        var seen = localKeys
        var out: [BackupEnvVarRecord] = []
        for r in backup {
            let key = r.key.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
            guard key.range(of: #"^[A-Z][A-Z0-9_]*$"#, options: .regularExpression) != nil,
                  !seen.contains(key) else { continue }
            seen.insert(key)
            var copy = r
            copy.key = key
            out.append(copy)
        }
        return out
    }

    static func mergeThinkingRules(local: [BackupLeoThinkingRuleRecord],
                                   backup: [BackupLeoThinkingRuleRecord]) -> (merged: [BackupLeoThinkingRuleRecord], added: Int) {
        var merged = local
        var ids = Set(local.map(\.id))
        var added = 0
        for r in backup where (r.ruleJSON != nil || !r.prefix.trimmingCharacters(in: .whitespaces).isEmpty) && !ids.contains(r.id) {
            merged.append(r); ids.insert(r.id); added += 1
        }
        return (merged, added)
    }
}
