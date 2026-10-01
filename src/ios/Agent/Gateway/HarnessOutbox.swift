import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// 手机拥有未确认输入；relay 的 202 只是易失缓存，不能删除本地意图。
/// 每条记录独立原子保存、同步落盘，原始 payload 与请求编号不可改写。
/// 不确定的操作只查询回执，不自动重新执行，避免把丢 ACK 变成重复副作用。
final class HarnessOutbox: Sendable {
    enum State: String, Codable, Sendable { case uncertain, queued, rejected }
    struct Entry: Codable, Equatable, Sendable {
        let id: String
        let scope: String
        let sessionId: String
        let text: String
        let fullAuto: Bool?
        let createdAt: Date
        var state: State

        func hasSameIntent(as other: Entry) -> Bool {
            id == other.id && scope == other.scope && sessionId == other.sessionId
                && text == other.text && fullAuto == other.fullAuto
        }
    }
    enum Failure: Error { case invalidIdentifier, conflictingIntent }
    enum Resolution: Equatable, Sendable { case pending, needsReceipt, completed(Int) }

    static func relayResolution(_ result: [String: Any]) -> Resolution {
        if result["status"] as? String == "queued" { return .pending }
        guard result["status"] as? String == "delivered",
              let status = result["http_status"] as? Int,
              isDefinitive(status) else { return .needsReceipt }
        return .completed(status)
    }

    static func receiptResolution(_ result: [String: Any], requestId: String) -> Resolution {
        guard result["requestId"] as? String == requestId,
              result["state"] as? String == "completed",
              let response = result["response"] as? [String: Any],
              let status = response["status"] as? Int,
              isDefinitive(status) else { return .needsReceipt }
        return .completed(status)
    }

    private static func isDefinitive(_ status: Int) -> Bool {
        (200..<500).contains(status) && status != 408 && status != 409
    }

    private static let logger = AppLogger(category: "HarnessOutbox")
    static let shared = HarnessOutbox(directory: FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("HarnessOutbox", isDirectory: true))
    private let directory: URL
    private let lock = NSLock()
    private let directorySync: @Sendable (URL) throws -> Void

    init(directory: URL, directorySync: @escaping @Sendable (URL) throws -> Void = HarnessOutbox.synchronizeDirectory) {
        self.directory = directory
        self.directorySync = directorySync
    }

    @discardableResult
    func record(id: String, scope: String, sessionId: String, text: String, fullAuto: Bool?) throws -> Entry {
        lock.lock(); defer { lock.unlock() }
        let entry = Entry(id: id, scope: scope, sessionId: sessionId, text: text, fullAuto: fullAuto,
                          createdAt: Date(), state: .uncertain)
        let url = try file(id)
        if FileManager.default.fileExists(atPath: url.path) {
            let existing = try JSONDecoder().decode(Entry.self, from: Data(contentsOf: url))
            guard existing.hasSameIntent(as: entry) else { throw Failure.conflictingIntent }
            return existing
        }
        try persist(entry, at: url)
        return entry
    }

    func markQueued(_ entry: Entry) throws {
        lock.lock(); defer { lock.unlock() }
        let url = try file(entry.id)
        let existing = try JSONDecoder().decode(Entry.self, from: Data(contentsOf: url))
        guard existing.hasSameIntent(as: entry) else { throw Failure.conflictingIntent }
        var queued = existing
        queued.state = .queued
        try persist(queued, at: url)
    }

    /// A definitive refusal is saved before cleanup under the same claim lock.
    /// If cleanup fails, restart recovers the text without automatically replaying.
    @discardableResult
    func remove(_ entry: Entry, rejected: Bool = false) throws -> Bool {
        lock.lock(); defer { lock.unlock() }
        let url = try file(entry.id)
        guard FileManager.default.fileExists(atPath: url.path) else { return false }
        var existing = try JSONDecoder().decode(Entry.self, from: Data(contentsOf: url))
        guard existing.hasSameIntent(as: entry) else { throw Failure.conflictingIntent }
        if rejected {
            existing.state = .rejected
            try persist(existing, at: url)
        }
        try FileManager.default.removeItem(at: url)
        do { try directorySync(directory) }
        catch {
            // unlink already happened. Restore the exact persisted intent
            // before reporting failed cleanup; do not pretend it still exists.
            try? persist(existing, at: url)
            throw error
        }
        return true
    }

    func entries(scope: String, sessionId: String) throws -> [Entry] {
        lock.lock(); defer { lock.unlock() }
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        // One unreadable file (older/newer build, truncated write) must not hide
        // every other pending input; it is left on disk for a build that can read it.
        return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .compactMap { url -> Entry? in
                do { return try JSONDecoder().decode(Entry.self, from: Data(contentsOf: url)) }
                catch {
                    Self.logger.warning("outbox entry \(url.lastPathComponent) unreadable, left on disk: \(error.localizedDescription)")
                    return nil
                }
            }
            .filter { $0.scope == scope && $0.sessionId == sessionId }
            .sorted { $0.createdAt < $1.createdAt }
    }

    private func file(_ id: String) throws -> URL {
        guard UUID(uuidString: id) != nil else { throw Failure.invalidIdentifier }
        return directory.appendingPathComponent(id.lowercased() + ".json")
    }

    private func persist(_ entry: Entry, at url: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(entry).write(to: url, options: .atomic)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.synchronize()
        try directorySync(directory)
    }

    private static func synchronizeDirectory(_ directory: URL) throws {
        let descriptor = open(directory.path, O_RDONLY)
        guard descriptor >= 0 else { throw POSIXError(.EIO) }
        defer { _ = close(descriptor) }
        guard fsync(descriptor) == 0 else { throw POSIXError(.EIO) }
    }
}

/// Config ownership is stable while a legacy host learns its device UUID.
/// Explicit destination changes create a new owner; pending inputs are never
/// silently moved to a newly configured target.
enum HarnessOutboxIdentity {
    static func newOwner() -> String { UUID().uuidString.lowercased() }

    static func initial(hostId: String, endpoint: String?) -> String {
        // Deterministic legacy seed also survives a crash before UserDefaults
        // flushes the additive identity field. JSON prevents delimiter aliases.
        let data = try! JSONEncoder().encode([hostId, endpoint ?? ""])
        return "legacy:" + data.base64EncodedString()
    }

    static func next(existing: String?, hostId: String,
                     previousEndpoint: String?, previousDeviceId: String?,
                     endpoint: String?, deviceId: String?, authenticatedDiscovery: Bool = false) -> String {
        let inherited = existing ?? initial(hostId: hostId, endpoint: previousEndpoint)
        let changedDevice = previousDeviceId != nil && deviceId != nil && previousDeviceId != deviceId
        let sameVerifiedDevice = previousDeviceId != nil && previousDeviceId == deviceId
        if changedDevice || (previousEndpoint != endpoint && !(authenticatedDiscovery && sameVerifiedDevice)) {
            return newOwner()
        }
        return inherited
    }
}
