import Foundation
import XCTest

@MainActor
final class BackupHistoryTests: XCTestCase {

    private func store() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("history-\(UUID().uuidString)/history.json")
    }

    func testRecordsPersistAndTransientLinesCollapse() {
        let url = store()
        let h = BackupHistory(storeURL: url)
        let id = h.begin(kind: .export, backupId: "", categories: ["chats"], encrypted: true)
        h.log(id, "开始")
        h.log(id, "1/10", isTransient: true)
        h.log(id, "2/10", isTransient: true)
        h.log(id, "2/10", isTransient: true)
        h.finish(id, totalBytes: 42, packageName: "p.minisbak", destinations: ["Files"])
        let reloaded = BackupHistory(storeURL: url)
        let r = reloaded.record(id)
        XCTAssertEqual(r?.status, .succeeded)
        XCTAssertEqual(r?.log.map(\.message), ["开始"], "progress lines are replaced, and dropped at finish")
        XCTAssertEqual(r?.totalBytes, 42)
        try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
    }

    func testThirtyDayRetentionAndInterruptedRuns() {
        let url = store()
        let h = BackupHistory(storeURL: url)
        let old = h.begin(kind: .export, backupId: "old", categories: [], encrypted: false)
        h.finish(old)
        let running = h.begin(kind: .restore, backupId: "r", categories: [], encrypted: false)
        h.pruneExpired(now: Date().addingTimeInterval(31 * 24 * 3600))
        XCTAssertNil(h.record(old))
        let fresh = BackupHistory(storeURL: url)
        XCTAssertNil(fresh.record(running), "pruned on disk as well")

        let h2 = BackupHistory(storeURL: store())
        let id = h2.begin(kind: .restore, backupId: "r", categories: [], encrypted: false)
        h2.reconcileInterrupted()
        XCTAssertEqual(h2.record(id)?.status, .failed)
        XCTAssertNotNil(h2.record(id)?.errorMessage)
    }

    func testOlderHistoryFileStillDecodes() throws {
        let url = store()
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let yesterday = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-86_400))
        try Data(#"[{"startedAt":"\#(yesterday)","status":"succeeded","future":1}]"#.utf8).write(to: url)
        let h = BackupHistory(storeURL: url)
        XCTAssertEqual(h.records.count, 1)
        XCTAssertEqual(h.records.first?.kind, .export)
    }

    func testExportSweepRemovesLeftovers() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("sweep-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("minisbak-x"), withIntermediateDirectories: true)
        for name in ["a.minisbak.partial", "b.minisbak", "restore-work-1", "keep.txt"] {
            try Data().write(to: root.appendingPathComponent(name))
        }
        BackupExportJournal.begin(.init(backupId: "x", startedAt: Date(), categories: [], encrypted: false), in: root)
        XCTAssertNotNil(BackupExportJournal.interrupted(in: root))
        XCTAssertEqual(BackupExportJournal.sweepAbandoned(workRoot: root), 4)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), ["keep.txt"])
        try? FileManager.default.removeItem(at: root)
    }

    func testPackageNameShape() {
        let date = ISO8601DateFormatter().date(from: "2026-10-08T10:00:00Z")!
        let name = BackupExporter.packageFileName(backupId: "ID", at: date, deviceName: "Leo's iPhone · AB12", encrypted: true)
        XCTAssertTrue(name.hasPrefix("Leos-iPhone-AB12-20261008-"), name)
        XCTAssertTrue(name.hasSuffix("-encrypted.minisbak"), name)
        XCTAssertEqual(BackupExporter.filenameDeviceToken("小李的手机"), "LeoBot")
        let earlier = BackupExporter.sortableID(backupId: "b", at: date)
        let later = BackupExporter.sortableID(backupId: "a", at: date.addingTimeInterval(1))
        XCTAssertLessThan(earlier, later, "lexical order is chronological")
    }
}
