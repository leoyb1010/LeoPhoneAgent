import Foundation

// The production record file references outbound tickets; unrelated to inbox tests.
struct SyncDeliveryTicket: Codable, Equatable, Sendable {
    let destination: String; let recordType: String; let recordId: String; let revision: Int64
    let changeId: String; let operation: String; let updatedAt: Date
}

@main struct CloudKitInboundDurabilitySmoke {
    static func check(_ condition: Bool, _ message: String = "inbox assertion failed") { precondition(condition, message) }
    static func main() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("cloud-inbox-" + UUID().uuidString)
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        let source = root.appendingPathComponent("temporary-ckasset")
        try Data("durable asset".utf8).write(to: source)
        let record = PortableRecord(id: .init(type: "SessionFileV2", id: "session:workspace/note.txt"),
            fields: ["body": .string("v1")],
            assets: ["body": .init(key: "body", fileURL: source, size: 13, mimeType: "text/plain")],
            unknownFields: ["future": .int(2)], updatedAt: Date(timeIntervalSince1970: 123))
        let journalURL = root.appendingPathComponent("account-a")
        let journal = try CloudKitInboundJournal(directory: journalURL)
        let first = try journal.append(records: [record], deletes: [])!
        let ownedAsset = first.records[0].assets["body"]!.fileURL
        check(ownedAsset != source)
        try fm.removeItem(at: source)
        // Process died after the cloud token advanced, before business merge.
        let restarted = try CloudKitInboundJournal(directory: journalURL)
        check(restarted.first == first)
        check(try Data(contentsOf: ownedAsset) == Data("durable asset".utf8))
        check(restarted.first!.records[0].unknownFields == ["future": .int(2)])
        // No ACK means replay, including a business error/deferred DB open.
        let replay = try CloudKitInboundJournal(directory: journalURL)
        check(replay.first?.batch.inboundDeliveryID == first.id)
        let second = try replay.append(records: [], deletes: [record.id])!
        do { _ = try replay.acknowledge(second.batch); preconditionFailure("out-of-order ACK accepted") }
        catch CloudKitInboundJournal.JournalError.unexpectedAcknowledgement {}
        let forged = SyncInboundBatch(records: [], deletes: [], sourceDeviceId: nil, inboundDeliveryID: first.id)
        do { _ = try replay.acknowledge(forged); preconditionFailure("wrong content ACK accepted") }
        catch CloudKitInboundJournal.JournalError.unexpectedAcknowledgement {}
        check(try replay.acknowledge(first.batch))
        check(!fm.fileExists(atPath: ownedAsset.path))
        check(!(try replay.acknowledge(first.batch)), "stale ACK must not delete next page")
        check(replay.first == second)
        check(try replay.acknowledge(second.batch))
        check(try CloudKitInboundJournal(directory: journalURL).first == nil)

        // A manifest write failure preserves memory and the previous disk page.
        let failureURL = root.appendingPathComponent("failure")
        let plain = PortableRecord(id: .init(type: "MessageV2", id: "m"), updatedAt: Date(timeIntervalSince1970: 1))
        let before = try CloudKitInboundJournal(directory: failureURL)
        let keep = try before.append(records: [plain], deletes: [])!
        let failing = try CloudKitInboundJournal(directory: failureURL) { _, _ in throw CocoaError(.fileWriteOutOfSpace) }
        do { _ = try failing.acknowledge(keep.batch); preconditionFailure("failed ACK write accepted") }
        catch is CocoaError {}
        check(failing.first == keep)
        check(try CloudKitInboundJournal(directory: failureURL).first == keep)
        do { _ = try failing.append(records: [plain], deletes: []); preconditionFailure("failed append accepted") }
        catch is CocoaError {}
        check(failing.pendingCount == 1)

        // Simulate rename succeeded but fsync/reporting failed. Never remove
        // copied assets that the durable manifest might already reference.
        try Data("durable asset".utf8).write(to: source)
        let ambiguousURL = root.appendingPathComponent("ambiguous")
        let ambiguous = try CloudKitInboundJournal(directory: ambiguousURL) { data, url in
            try CloudKitInboundJournal.writeDurably(data, to: url)
            if url.lastPathComponent == "pending.json" { throw CocoaError(.fileWriteUnknown) }
        }
        do { _ = try ambiguous.append(records: [record], deletes: []); preconditionFailure("ambiguous write accepted") }
        catch is CocoaError {}
        let recovered = try CloudKitInboundJournal(directory: ambiguousURL)
        check(recovered.first?.records.count == 1)
        check(try Data(contentsOf: recovered.first!.records[0].assets["body"]!.fileURL) == Data("durable asset".utf8))

        // Two transport instances overlap during reconfiguration. Only one
        // can own a head, and an old ACK must retain a newer instance's append.
        let overlapURL = root.appendingPathComponent("overlap")
        let old = try CloudKitInboundJournal(directory: overlapURL)
        let oldPage = try old.append(records: [plain], deletes: [])!
        let replacement = try CloudKitInboundJournal(directory: overlapURL)
        check(try old.claimFirst() == oldPage)
        check(try replacement.claimFirst() == nil)
        let later = try replacement.append(records: [plain], deletes: [])!
        check(later.id != oldPage.id, "identical payload needs a different delivery identity")
        check(try old.acknowledge(oldPage.batch))
        check(try replacement.peek() == later, "old ACK dropped replacement append")
        check(try replacement.claimFirst() == later)
        check(!(try old.acknowledge(oldPage.batch)), "stale ACK consumed identical later payload")
        replacement.release(later.id) // business merge failed/deferred
        check(try old.claimFirst() == later, "negative completion must permit replay")
        old.release(later.id)
        // An incomplete asset cannot be published by a successful page append.
        let wrongSize = PortableRecord(id: plain.id, assets: ["body":
            .init(key: "body", fileURL: source, size: 999, mimeType: nil)], updatedAt: plain.updatedAt)
        do { _ = try old.append(records: [wrongSize], deletes: []); preconditionFailure("truncated asset accepted") }
        catch CloudKitInboundJournal.JournalError.missingAsset {}
        check(try old.peek() == later)

        // Moving the container does not retain absolute asset paths.
        let movedURL = root.appendingPathComponent("moved")
        try fm.moveItem(at: ambiguousURL, to: movedURL)
        let moved = try CloudKitInboundJournal(directory: movedURL)
        check(moved.first!.records[0].assets["body"]!.fileURL.path.hasPrefix(movedURL.path + "/"))
        // Missing bytes/corrupt manifests are fatal, never an empty successful inbox.
        try fm.removeItem(at: moved.first!.records[0].assets["body"]!.fileURL)
        do { _ = try CloudKitInboundJournal(directory: movedURL); preconditionFailure("missing asset ignored") }
        catch {}
        try Data("broken JSON".utf8).write(to: failureURL.appendingPathComponent("pending.json"))
        do { _ = try CloudKitInboundJournal(directory: failureURL); preconditionFailure("corrupt inbox ignored") }
        catch {}
        // Account roots do not replay another account's retained pages.
        check(try CloudKitInboundJournal(directory: root.appendingPathComponent("account-b")).first == nil)
        print("CloudKit inbox smoke passed: owned assets, crash replay, FIFO/exact ACK, stale ACK, write failure, ambiguous commit, restore rebase, corruption, replacement-transport leases and account isolation")
    }
}
