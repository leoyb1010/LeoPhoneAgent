// Terminal receipts belong to the originating phone chat and stay outside model context.
import Foundation

struct MacResultEntry: Codable, Equatable, Identifiable {
    var phoneSessionId: String
    var machine: String
    var harnessSessionId: String
    var failed: Bool
    var output: String
    var receivedAt: Date
    var hostId: String?
    var runId: String?
    var eventSequence: Int?
    var noticed: Bool?

    var turnKey: String {
        if let eventSequence { return "seq-\(eventSequence)" }
        if let runId { return "run-" + runId }
        return "at-\(receivedAt.timeIntervalSince1970.bitPattern)"
    }

    var id: String {
        // Keep the relay machine alias stable across pairing and display-name changes.
        [machine, harnessSessionId, turnKey].map { "\($0.utf8.count):\($0)" }.joined()
    }

    var noticeText: String {
        let head = failed ? "\(machine) 上的 Mac 任务失败了" : "\(machine) 上的 Mac 任务已完成"
        let body = output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return head + "。完整过程在首页的 Mac 任务里。" }
        return head + ":\n" + String(body.prefix(800))
    }
}

enum MacResultInbox {
    static let storageKey = "leo.macResultInbox.v1"
    static let changed = Notification.Name("leo.macResultInbox.changed")
    static let capacity = 20
    static let maxAge: TimeInterval = 7 * 24 * 3600

    // The production archive can contain complete relay output. Keep it in a protected file
    // rather than growing the standard preferences domain. Test suites use their own defaults.
    private static var archiveURL: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("MacResultInbox.json")
    }

    static func load(_ defaults: UserDefaults = .standard) -> [MacResultEntry] {
        let archive = defaults === UserDefaults.standard ? archiveURL.flatMap { try? Data(contentsOf: $0) } : nil
        guard let data = archive ?? defaults.data(forKey: storageKey),
              let entries = try? JSONDecoder().decode([MacResultEntry].self, from: data) else { return [] }
        return entries
    }

    static func history(phoneSessionId: String, defaults: UserDefaults = .standard, now: Date = Date()) -> [MacResultEntry] {
        load(defaults).filter { $0.phoneSessionId == phoneSessionId && now.timeIntervalSince($0.receivedAt) < maxAge }
            .sorted { $0.receivedAt > $1.receivedAt }
    }

    private static func save(_ entries: [MacResultEntry], _ defaults: UserDefaults) -> Bool {
        guard let data = try? JSONEncoder().encode(entries) else { return false }
        if defaults === UserDefaults.standard, var url = archiveURL {
            do {
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                var flags = URLResourceValues()
                flags.isExcludedFromBackup = true
                try? url.setResourceValues(flags)
                defaults.removeObject(forKey: storageKey)
                return true
            } catch { return false }
        }
        defaults.set(data, forKey: storageKey)
        return true
    }

    @discardableResult
    static func record(_ entry: MacResultEntry, defaults: UserDefaults = .standard, now: Date = Date()) -> Bool {
        var entries = load(defaults).filter { now.timeIntervalSince($0.receivedAt) < maxAge }
        guard now.timeIntervalSince(entry.receivedAt) < maxAge else { return true }
        if entries.contains(where: { $0.id == entry.id }) { return true }
        entries.append(entry)
        entries.sort { $0.receivedAt < $1.receivedAt }
        return save(Array(entries.suffix(capacity)), defaults)
    }

    /// Show each arrival once in the chat. The receipt itself remains available in the tray.
    static func take(phoneSessionId: String, defaults: UserDefaults = .standard, now: Date = Date()) -> [MacResultEntry] {
        var entries = load(defaults).filter { now.timeIntervalSince($0.receivedAt) < maxAge }
        let matching = entries.indices.filter { entries[$0].phoneSessionId == phoneSessionId && entries[$0].noticed != true }
        let mine = matching.map { entries[$0] }.sorted { $0.receivedAt < $1.receivedAt }
        guard !mine.isEmpty else { return [] }
        for index in matching { entries[index].noticed = true }
        return save(entries, defaults) ? mine : []
    }

    static func entry(event: [String: Any], machine: String, receivedAt: Date, hostId: String? = nil) -> MacResultEntry? {
        let name = event["event"] as? String
        guard name == "run.completed" || name == "run.failed",
              let harness = event["session_id"] as? String, !harness.isEmpty else { return nil }
        let phone = (event["phone_session_id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let failed = name == "run.failed"
        let output = (failed ? event["error"] as? String : event["output"] as? String) ?? ""
        let runId = (event["run_id"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return MacResultEntry(phoneSessionId: String(phone.prefix(200)), machine: machine,
                              harnessSessionId: harness, failed: failed, output: output, receivedAt: receivedAt,
                              hostId: hostId, runId: runId, eventSequence: event["seq"] as? Int)
    }
}

struct MacReceiptTarget: Identifiable, Equatable {
    let phoneSessionId: String
    let machine: String
    let hostId: String?
    let harnessSessionId: String
    let eventSequence: Int?
    let runId: String?
    let receivedAt: Double?
    let id = UUID()

    var identifiesTurn: Bool { eventSequence != nil || runId != nil || receivedAt != nil }

    func matches(_ entry: MacResultEntry) -> Bool {
        guard entry.phoneSessionId == phoneSessionId, entry.harnessSessionId == harnessSessionId else { return false }
        if let hostId, let entryHost = entry.hostId {
            guard hostId == entryHost else { return false }
        } else if machine.caseInsensitiveCompare(entry.machine) != .orderedSame { return false }
        if let eventSequence { return eventSequence == entry.eventSequence }
        if let runId { return runId == entry.runId }
        if let receivedAt { return abs(receivedAt - entry.receivedAt.timeIntervalSince1970) < 0.000_001 }
        return true
    }
}


extension MacReceiptTarget {
    init?(remoteNotification info: [String: String]) {
        guard info["completionReceipt"] == "1", let sid = info["macSessionId"], !sid.isEmpty,
              let machine = info["machine"], !machine.isEmpty else { return nil }
        self.init(phoneSessionId: "", machine: machine, hostId: info["hostId"].flatMap { $0.isEmpty ? nil : $0 },
                  harnessSessionId: sid, eventSequence: info["eventSequence"].flatMap(Int.init),
                  runId: info["runId"], receivedAt: info["receivedAt"].flatMap(Double.init))
    }
}
