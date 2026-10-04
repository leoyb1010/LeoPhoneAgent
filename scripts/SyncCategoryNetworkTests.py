#!/usr/bin/env python3
"""Execute both CloudKit dequeue delegates and the complete Tailnet transport.
The request adapter records bytes only; no sockets or live credentials are used.
"""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SYNC = ROOT / 'src/ios/Agent/Sync/V2'

def method(source, name):
    start = source.index('func ' + name + '(')
    start = source.rfind('\n', 0, start) + 1
    return source[start:source.index('\n    }', start) + 6]

v1 = (ROOT / 'src/ios/Agent/Sync/CloudSyncEngine.swift').read_text()
v2 = (SYNC / 'ICloudSharedZoneTransport.swift').read_text()
pending = v1[v1.index('final class PendingRecordChanges:'):v1.index('// MARK: - CloudSyncEngine')]
source = r'''
import Foundation
import CryptoKit
let fixtureDefaults = UserDefaults(suiteName: "leo.sync.network.test." + UUID().uuidString)!
struct CKRecord {
 struct ID: Hashable { let recordName: String }
 let recordType: String
 let recordID: ID
 init(_ type: String, _ id: String) { recordType = type; recordID = ID(recordName: type + ":" + id) }
}
final class CKSyncEngine {
 struct SendChangesContext {}
 enum PendingRecordZoneChange { case saveRecord(CKRecord.ID), deleteRecord(CKRecord.ID) }
 final class State {
  var removed: [PendingRecordZoneChange] = []
  func remove(pendingRecordZoneChanges: [PendingRecordZoneChange]) { removed += pendingRecordZoneChanges }
 }
 struct RecordZoneChangeBatch { let recordsToSave: [CKRecord]; let recordIDsToDelete: [CKRecord.ID]; let atomicByZone: Bool }
 let state = State()
}
''' + pending + r'''
@MainActor final class V1Probe {
 nonisolated let pendingChanges = PendingRecordChanges()
''' + method(v1, 'nextRecordZoneChangeBatch') + r'''
}
@MainActor final class V2Probe {
 var pendingRecords: [CKRecord] = []
 var pendingDeletes: [CKRecord.ID] = []
''' + method(v2, 'nextRecordZoneChangeBatch') + r'''
}
struct SyncTransportHealth {
 mutating func succeeded(_ operation: String) {}
 mutating func failed(_ operation: String, error: NSError) { fatalError("paused upload must not become a transport failure") }
}
enum SyncTransportError: Error { case notStarted, fetchInFlight }
@MainActor enum SyncV2Bootstrap {
 static func startReplicaSeed(_ destination: String, restart: Bool = false) {}
}
@MainActor final class LeoAgentClient {
 enum Mode { case enabled, pauseOnHead, pauseOnFirstChunk, pauseOnCompletedAsset }
 var mode = Mode.enabled
 var requests: [String] = []
 var uploadedBytes = 0
 var offset = 0
 func replicaDeviceId() async -> String? { "6e412b31-4e87-414b-98d3-a293073b42da" }
 func replicaReady() async -> Bool { true }
 func replicaData(path: String, method: String = "GET", body: Data? = nil, requestId: String? = nil,
                  headers: [String: String] = [:]) async throws -> (Data, HTTPURLResponse) {
  requests.append(method)
  // Model the real suspension after a request is handed off. Settings may
  // change before the suspended transport resumes with this response.
  await Task.yield()
  var data = Data()
  var status = 200
  if method == "HEAD" {
   status = 404
   if mode == .pauseOnHead { UploadPolicy.setEnabled(.sessionFiles, false) }
  } else if method == "PUT" {
   uploadedBytes += body?.count ?? 0
   offset += body?.count ?? 0
   let size = Int(headers["Content-Range"]!.split(separator: "/").last!)!
   data = try JSONSerialization.data(withJSONObject: ["size": size, "offset": offset, "complete": offset == size])
   if mode == .pauseOnFirstChunk || (mode == .pauseOnCompletedAsset && offset == size) {
    UploadPolicy.setEnabled(.sessionFiles, false)
   }
  } else if method == "POST" {
   let payload = try JSONSerialization.jsonObject(with: body!) as! [String: Any]
   let change = (payload["changes"] as! [[String: Any]])[0]
   data = try JSONSerialization.data(withJSONObject: ["replicaId": "fixture", "receipts": [[
     "changeId": change["changeId"]!, "revision": change["revision"]!, "status": "stored", "cursor": 1
   ]]])
  } else { fatalError("unexpected test request: " + method) }
  return (data, HTTPURLResponse(url: URL(string: "https://fixture.invalid" + path)!, statusCode: status, httpVersion: nil, headerFields: [:])!)
 }
}
@main enum NetworkPolicySmoke {
 @MainActor static func main() async throws {
  let engine = CKSyncEngine(), context = CKSyncEngine.SendChangesContext()
  let old = V1Probe(), current = V2Probe()
  // Queue private records while enabled, then pause before the actual SDK
  // callback. Paused records must be excluded before the batch-size limit.
  UploadPolicy.setEnabled(.envVars, true)
  old.pendingChanges.append(records: (0..<450).map { CKRecord("EnvVar", "private-\($0)") } + [CKRecord("Skill", "public")],
                            deleteIDs: [.init(recordName: "EnvVar:deleted-private")])
  current.pendingRecords = (0..<30).map { CKRecord("EnvVarItem", "private-\($0)") } + [CKRecord("SkillV2", "public")]
  current.pendingDeletes = [.init(recordName: "EnvVarItem:deleted-private")]
  UploadPolicy.setEnabled(.envVars, false)
  let oldBatch = await old.nextRecordZoneChangeBatch(context, syncEngine: engine)
  let newBatch = await current.nextRecordZoneChangeBatch(context, syncEngine: engine)
  precondition(oldBatch?.recordsToSave.map(\.recordType) == ["Skill"] && oldBatch?.recordIDsToDelete.isEmpty == true)
  precondition(newBatch?.recordsToSave.map(\.recordType) == ["SkillV2"] && newBatch?.recordIDsToDelete.isEmpty == true)
  precondition(engine.state.removed.count == 482, "remove only volatile SDK intent; durable SQL remains owned by Core")
  precondition(current.pendingRecords.isEmpty && current.pendingDeletes.isEmpty)
  fixtureDefaults.set(false, forKey: "cloudSync.syncSkills")
  old.pendingChanges.append(records: [CKRecord("Skill", "legacy-opt-out")])
  let legacyOff = await old.nextRecordZoneChangeBatch(context, syncEngine: engine)
  precondition(legacyOff == nil, "fallback must also respect its legacy opt-out")
  print("PASS real V1/V2 delegate methods: pause after queueing, before batch limit")

  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: root) }
  for mode in [LeoAgentClient.Mode.pauseOnHead, .pauseOnFirstChunk, .pauseOnCompletedAsset, .enabled] {
   UploadPolicy.setEnabled(.sessionFiles, true)
   let client = LeoAgentClient(); client.mode = mode
   let transport = try TailnetSyncTransport(client: client, targetDeviceId: "6e412b31-4e87-414b-98d3-a293073b42da", stateDirectory: root.appendingPathComponent(UUID().uuidString))
   let size = mode == .pauseOnFirstChunk ? 2_097_152 : 8
   let url = root.appendingPathComponent(UUID().uuidString)
   try Data(repeating: 42, count: size).write(to: url)
   let record = PortableRecord(id: .init(type: "SessionFileV2", id: "fixture"),
     assets: ["body": .init(key: "body", fileURL: url, size: size, mimeType: nil)], updatedAt: Date())
   let ticket = SyncDeliveryTicket(destination: transport.name, recordType: record.id.type, recordId: record.id.id,
     revision: 1, changeId: UUID().uuidString, operation: "upsert", updatedAt: record.updatedAt)
   let result = try await transport.send(.init(records: [record], deletes: [], deliveryTickets: [record.id.description: ticket]), trigger: .manual)
   switch mode {
   case .pauseOnHead:
    precondition(client.requests == ["HEAD"] && client.uploadedBytes == 0 && result.isEmpty,
       "pause during HEAD must prevent first private body and change POST")
   case .pauseOnFirstChunk:
    precondition(client.requests == ["HEAD", "PUT"] && client.uploadedBytes == 1_048_576 && result.isEmpty,
       "pause during first chunk must prevent remaining chunks and change POST")
   case .pauseOnCompletedAsset:
    precondition(client.requests == ["HEAD", "PUT"] && result.isEmpty,
       "pause after asset completion must prevent metadata POST and ACK")
   case .enabled:
    precondition(client.requests == ["HEAD", "PUT", "POST"] && result == [.success(record.id)])
   }
   // Even deletes and frozen batches offered directly to the transport must
   // produce no request while the category is paused.
   UploadPolicy.setEnabled(.sessionFiles, false)
   let before = client.requests
   let paused = try await transport.send(.init(records: [record], deletes: [record.id], deliveryTickets: [record.id.description: ticket]), trigger: .manual)
   precondition(paused.isEmpty && client.requests == before)
  }
  print("PASS complete Tailnet transport: no private bytes after each awaited pause boundary; normal upload succeeds")
 }
}
'''
with tempfile.TemporaryDirectory(prefix='leo-sync-network-') as temp:
    work = Path(temp)
    policy = work / 'UploadPolicy.swift'
    policy.write_text((SYNC / 'UploadPolicy.swift').read_text().replace('UserDefaults.standard', 'fixtureDefaults'))
    probe = work / 'Network.swift'
    probe.write_text(source)
    binary = work / 'network'
    subprocess.run(['swiftc', '-parse-as-library', '-module-cache-path', str(work / 'cache'), str(policy),
                    str(SYNC / 'PortableRecord.swift'), str(SYNC / 'SyncTransport.swift'),
                    str(SYNC / 'SyncDeliveryLedger.swift'), str(SYNC / 'TailnetSyncTransport.swift'),
                    str(probe), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
