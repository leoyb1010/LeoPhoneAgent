#!/usr/bin/env python3
"""Real CKRecord conversion + production inbox progression, without CloudKit I/O."""
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SYNC = ROOT / 'src/ios/Agent/Sync/V2'


def method(source, name):
    start = source.index('func ' + name + '(')
    start = source.rfind('\n', 0, start) + 1
    end = source.index('\n    }', start) + 6
    return source[start:end]


transport = (SYNC / 'ICloudSharedZoneTransport.swift').read_text()
converter = method(transport, 'toPortable').replace('nonisolated private func', 'func', 1)
ticket_source = (SYNC / 'SyncDeliveryLedger.swift').read_text()
ticket = ticket_source[ticket_source.index('struct SyncDeliveryTicket'):ticket_source.index('\n}', ticket_source.index('struct SyncDeliveryTicket')) + 2]
main = r'''
}
struct KnownFixture: Syncable {
    var id: String
    var title: String
    var updatedAt: Date
    static var syncMetadata: SyncTypeMetadata<KnownFixture> {
        SyncTypeMetadata(recordType: "KnownFixtureV1", idKeyPath: \.id, scope: .perObject(\.id),
            fields: [.string("title", \.title)], conflictPolicy: .lastWriteWinsByField(\.updatedAt))
    }
}
struct UpgradedFutureFixture: Syncable {
    var id: String
    var futureText: String
    var updatedAt: Date
    static var syncMetadata: SyncTypeMetadata<UpgradedFutureFixture> {
        SyncTypeMetadata(recordType: "FutureTypeV7", idKeyPath: \.id, scope: .perObject(\.id),
            fields: [.string("futureText", \.futureText)], conflictPolicy: .lastWriteWinsByField(\.updatedAt), version: 7)
    }
}
@main enum UnknownRecordSmoke {
    static func main() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? fm.removeItem(at: root) }
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        let assetURL = root.appendingPathComponent("asset")
        try Data("future asset".utf8).write(to: assetURL)
        let record = CKRecord(recordType: "FutureTypeV7", recordID: CKRecord.ID(recordName: "FutureTypeV7:future"))
        record["futureText"] = "retain me" as CKRecordValue
        record["futureCount"] = 42 as CKRecordValue
        record["futureData"] = Data([1,2,3]) as CKRecordValue
        record["updatedAt"] = Date(timeIntervalSince1970: 100) as CKRecordValue
        record["syncSchemaVersion"] = 7 as CKRecordValue
        record["syncMinimumCompatibleVersion"] = 6 as CKRecordValue
        record["futureAsset"] = CKAsset(fileURL: assetURL)
        guard let converted = ConverterProbe().toPortable(record, registry: .shared) else {
            fatalError("unknown type rejected before its durable inbox can retain it")
        }
        precondition(converted.fields.isEmpty)
        precondition(converted.id == SyncRecordID(type: "FutureTypeV7", id: "future"))
        precondition(converted.unknownFields["futureText"] == .string("retain me"))
        precondition(converted.unknownFields["futureCount"] == .int(42))
        precondition(converted.unknownFields["futureData"] == .data(Data([1,2,3])))
        precondition(converted.schemaVersion == 7 && converted.minimumCompatibleVersion == 6)
        precondition(converted.assets["futureAsset"]?.size == "future asset".utf8.count)
        let invalid = CKRecord(recordType: "FutureTypeV7", recordID: CKRecord.ID(recordName: "missing-separator"))
        precondition(ConverterProbe().toPortable(invalid, registry: .shared) == nil, "invalid identity must still block checkpointing")
        let directory = root.appendingPathComponent("inbox")
        var journal = try CloudKitInboundJournal(directory: directory)
        SyncableTypeRegistry.shared.register(KnownFixture.self)
        let knownRecord = CKRecord(recordType: "KnownFixtureV1", recordID: CKRecord.ID(recordName: "KnownFixtureV1:known"))
        knownRecord["title"] = "known title" as CKRecordValue
        knownRecord["futureText"] = "extra field" as CKRecordValue
        let known = ConverterProbe().toPortable(knownRecord, registry: .shared)!
        precondition(known.fields["title"] == .string("known title"))
        precondition(known.unknownFields["futureText"] == .string("extra field"))
        try journal.append(records: [converted, known], deletes: [])
        try fm.removeItem(at: assetURL)
        var pass = CloudKitInboundJournal.DeliveryPass()
        pass.begin()
        let future = try pass.claim(from: journal)!
        precondition(future.records[0].unknownFields == converted.unknownFields)
        // SyncCore intentionally withholds ACK for this unsupported type.
        journal.release(future.id)
        let next = try pass.claim(from: journal)!
        precondition(next.records.first?.id == known.id, "unknown entry must not stop known records")
        try journal.acknowledge(next.batch)
        journal = try CloudKitInboundJournal(directory: directory)
        let retained = try journal.peek()!.records[0]
        precondition(retained.id == converted.id && retained.unknownFields == converted.unknownFields)
        precondition(retained.schemaVersion == 7 && retained.minimumCompatibleVersion == 6)
        let bytes = try Data(contentsOf: retained.assets["futureAsset"]!.fileURL)
        precondition(bytes == Data("future asset".utf8), "asset must survive source deletion and inbox restart")
        // After upgrade, the exact persisted delivery must become consumable by
        // a merger that reads required values from fields, while preserving the
        // original batch for journal ACK equality.
        SyncableTypeRegistry.shared.register(UpgradedFutureFixture.self)
        let upgraded = retained.reclassifyingKnownFields(SyncableTypeRegistry.shared.metadata(for: retained.id.type)!.knownCloudKeys)
        precondition(upgraded.fields["futureText"] == .string("retain me"))
        precondition(upgraded.unknownFields["futureText"] == nil)
        precondition(upgraded.unknownFields["futureCount"] == .int(42))
        precondition(upgraded.assets == retained.assets && upgraded.schemaVersion == retained.schemaVersion)
        let conflict = PortableRecord(id: retained.id, fields: ["futureText": .string("current")],
            unknownFields: ["futureText": .string("old")], updatedAt: retained.updatedAt)
        precondition(conflict.reclassifyingKnownFields(["futureText"]).fields["futureText"] == .string("current"))
        let replay = try journal.claimFirst()!
        try journal.acknowledge(replay.batch)
        let empty = try journal.peek()
        precondition(empty == nil)
        print("Unknown CKRecord retention PASS: fields/version/asset durable, known entry progresses, malformed identity rejected, upgraded replay fields recovered")
    }
}
'''

with tempfile.TemporaryDirectory(prefix='cloudkit-unknown-') as temporary:
    work = Path(temporary)
    probe = work / 'Probe.swift'
    probe.write_text('import Foundation\nimport CloudKit\n' + ticket + '\nstruct ConverterProbe {\n' + converter + main)
    binary = work / 'probe'
    swiftc = shutil.which('swiftc')
    if not swiftc:
        raise SystemExit('swiftc with CloudKit SDK required')
    subprocess.run([swiftc, '-parse-as-library', '-module-cache-path', str(work / 'cache'),
                    *[str(SYNC / name) for name in ['PortableRecord.swift', 'Syncable.swift',
                       'SyncableTypeRegistry.swift', 'CloudKitInboundJournal.swift']],
                    str(probe), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)

core = (SYNC / 'SyncCore.swift').read_text()
inbound = method(core, 'processInbound')
assert 'record = record.reclassifyingKnownFields(metadata.knownCloudKeys)' in inbound
assert inbound.index('reclassifyingKnownFields') < inbound.index('SyncCoreHydrators.shared.mergeRemote(record)')
