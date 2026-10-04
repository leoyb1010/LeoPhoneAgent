#!/usr/bin/env python3
"""Run extracted production recovery methods on disposable files and fake persistence.
No simulator, user Keychain, live MCP endpoint or remote command is accessed.
"""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]

def method(path, name):
    source = (ROOT / path).read_text()
    start = source.index('func ' + name + '(')
    start = source.rfind('\n', 0, start) + 1
    return source[start:source.index('\n    }', start) + 6]

file_method = method('src/ios/Views/Settings/MountedFolderCoordinator.swift', 'importKeepingBoth')
env_path = 'src/ios/Shared/EnvVarStore.swift'
mcp_path = 'src/ios/Agent/Session/MCPStore.swift'
gateway_path = 'src/ios/Agent/Gateway/GatewayRunDriver.swift'
source = r'''
import Foundation
import Security
// Shadow the Security boundary; the actual production read-status handling runs.
func SecItemCopyMatching(_ query: CFDictionary, _ result: UnsafeMutablePointer<AnyObject?>?) -> OSStatus {
 let attributes = query as NSDictionary
 let key = attributes[kSecAttrAccount as String] as! String
 let synced = attributes[kSecAttrSynchronizable as String] as? Bool ?? false
 if synced && EnvVarStore.failRead { return errSecInteractionNotAllowed }
 let value = synced ? EnvVarStore.values[key] : EnvVarStore.legacyValues[key]
 guard let value else { return errSecItemNotFound }
 result?.pointee = Data(value.utf8) as NSData
 return errSecSuccess
}
struct Logger { func info(_ s: String) {}; func error(_ s: String) {}; func warning(_ s: String) {} }
let logger = Logger()
enum MountedFolderCoordinator {
 static var failCopy = false
 static func copy(from: URL, to: URL) throws {
  if failCopy { throw CocoaError(.fileReadUnknown) }
  try FileManager.default.copyItem(at: from, to: to)
 }
''' + file_method + r'''
}
struct EnvVarEntry { var id = UUID().uuidString; var key: String; var note: String }
final class EnvVarStore {
 enum MutationError: Error { case invalidKey, duplicateKey, missingEntry, keychainWriteFailed, metadataWriteFailed, keychainReadFailed, valueChangedMetadataWriteFailed }
 var entries: [EnvVarEntry] = []
 var durable: [EnvVarEntry] = []
 var metadataFails = false
 var dirties = 0
 static let keychainService = "fixture.only"
 static var values: [String: String] = [:]
 static var legacyValues: [String: String] = [:]
 static var failWrite = false
 static var failRead = false
 static var failDelete = false
 static var rejectedValue: String?
 static func isValidKey(_ key: String) -> Bool { !key.isEmpty }
 static func sanitizeValue(_ value: String) -> String { value }
 static func saveValue(_ value: String, forKey key: String) -> Bool {
  if failWrite || value == rejectedValue { return false }; values[key] = value; return true
 }
 static func deleteValue(forKey key: String) -> Bool { if failDelete { return false }; values[key] = nil; return true }
 func saveEntries() -> Bool { if metadataFails { return false }; durable = entries; return true }
 func markEntryDirty(entryId: String, operation: String) { dirties += 1 }
''' + method(env_path, 'readValueForMutation') + '\n' + method(env_path, 'add') + '\n' + method(env_path, 'update') + r'''
}
struct MCPServerConfig { var id: String; var url: String; var createdAt: Double?; var updatedAt: Double? }
final class MCPStore {
 var servers: [MCPServerConfig] = []
 var durable: [MCPServerConfig] = []
 var saveFails = false
 var dirties = 0
 func save() -> Bool { if saveFails { return false }; durable = servers; return true }
 func noteSyncedLocalChange(names: [String]) { dirties += names.count }
''' + method(mcp_path, 'commitImport') + r'''
}
enum GatewayError: Error { case unauthorized, harnessNotConfigured, notConfigured, badURL, http(status: Int, message: String?) }
struct GatewayTranscriptItem {
 enum Kind { case notice, failure }
 var kind: Kind; var text: String
}
@MainActor final class LeoAgentClient {
 var failure: Error?
 func submitRun(input: String) async throws -> String {
  if let failure { throw failure }; return "run-1"
 }
}
@MainActor final class GatewayHostStore {
 static let shared = GatewayHostStore()
 func markSeen(id: String) {}
}
@MainActor final class GatewayRunDriver {
 var isRunning = false
 var lastError: String?
 var unsentPrompt: String?
 var usage: String?
 var pendingApproval: String?
 var reconnectCount = 0
 var status = "idle"
 var items: [GatewayTranscriptItem] = []
 var streamTask: Task<Void, Never>?
 var runId: String?
 let hostId = "fixture"
 let client = LeoAgentClient()
 func consume(runId: String) async {}
''' + method(gateway_path, 'submissionDefinitelyRejected') + '\n' + method(gateway_path, 'send') + '\n' + method(gateway_path, 'fail') + r'''
}
func check(_ value: @autoclosure () -> Bool, _ message: String) {
 if !value() { fatalError(message) }
}
@main struct Run {
 @MainActor static func main() async throws {
  let fm = FileManager.default
  let root = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try fm.createDirectory(at: root, withIntermediateDirectories: true)
  defer { try? fm.removeItem(at: root) }
  let srcDir = root.appendingPathComponent("source"), dstDir = root.appendingPathComponent("destination")
  try fm.createDirectory(at: srcDir, withIntermediateDirectories: true)
  try fm.createDirectory(at: dstDir, withIntermediateDirectories: true)
  let src = srcDir.appendingPathComponent("report.txt"), original = dstDir.appendingPathComponent("report.txt")
  try Data("incoming".utf8).write(to: src); try Data("original".utf8).write(to: original)
  let imported = try MountedFolderCoordinator.importKeepingBoth(from: src, to: dstDir)
  check(imported.lastPathComponent == "report (2).txt", "same-name import keeps both")
  check(try! String(contentsOf: original, encoding: .utf8) == "original", "original survives")
  check(try! String(contentsOf: imported, encoding: .utf8) == "incoming", "new data copied")
  let selfCopy = try MountedFolderCoordinator.importKeepingBoth(from: original, to: dstDir)
  check(try! String(contentsOf: selfCopy, encoding: .utf8) == "original", "importing itself keeps original")
  MountedFolderCoordinator.failCopy = true
  do { _ = try MountedFolderCoordinator.importKeepingBoth(from: src, to: dstDir); fatalError("copy failure hidden") } catch {}
  check(try! String(contentsOf: original, encoding: .utf8) == "original", "failed copy preserves original")
  print("PASS file collision, self-import and failed-copy preservation")

  let env = EnvVarStore()
  try env.add(key: "ONE", value: "old", note: "old note").get()
  do { try env.add(key: "ONE", value: "new").get(); fatalError("duplicate accepted") } catch EnvVarStore.MutationError.duplicateKey {}
  check(EnvVarStore.values["ONE"] == "old" && env.entries.count == 1, "duplicate preserves prior value")
  let id = env.entries[0].id
  EnvVarStore.failWrite = true
  do { try env.update(id: id, key: "TWO", value: "new").get(); fatalError("keychain failure hidden") } catch EnvVarStore.MutationError.keychainWriteFailed {}
  check(EnvVarStore.values["ONE"] == "old" && env.entries[0].key == "ONE", "failed rename preserves old secret and metadata")
  EnvVarStore.failWrite = false
  env.metadataFails = true
  do { try env.update(id: id, key: "TWO", value: "new").get(); fatalError("metadata failure hidden") } catch EnvVarStore.MutationError.metadataWriteFailed {}
  check(EnvVarStore.values["ONE"] == "old" && env.entries[0].key == "ONE", "metadata failure preserves old key")
  env.metadataFails = false
  try env.update(id: id, key: "TWO", value: "new").get()
  check(EnvVarStore.values["ONE"] == nil && EnvVarStore.values["TWO"] == "new", "successful rename commits new key")
  check(env.durable[0].key == "TWO" && env.dirties == 2, "only successful saves emit dirty records")
  // Sync can retain two metadata identities with the same key. Renaming one
  // must not erase the secret still referenced by the other identity.
  env.entries.append(EnvVarEntry(key: "TWO", note: "synced duplicate"))
  try env.update(id: id, key: "THREE", value: "third").get()
  check(EnvVarStore.values["TWO"] == "new", "rename preserves secret referenced by another entry")
  print("PASS duplicate, Keychain failure, metadata failure and successful rename")
  let same = EnvVarStore()
  try same.add(key: "SAME", value: "original", note: "old note").get()
  let sameID = same.entries[0].id
  same.metadataFails = true
  do { try same.update(id: sameID, key: "SAME", value: "replacement", note: "new note").get(); fatalError("same-key metadata failure hidden") } catch EnvVarStore.MutationError.metadataWriteFailed {}
  check(EnvVarStore.values["SAME"] == "original" && same.entries[0].note == "old note" && same.dirties == 1, "same-key metadata failure restores original secret and note")
  EnvVarStore.rejectedValue = "original"
  do { try same.update(id: sameID, key: "SAME", value: "replacement", note: "new note").get(); fatalError("compensation failure hidden") } catch EnvVarStore.MutationError.valueChangedMetadataWriteFailed {}
  check(EnvVarStore.values["SAME"] == "replacement" && same.entries[0].note == "old note" && same.dirties == 2, "failed compensation reports changed value and marks it dirty")
  EnvVarStore.rejectedValue = nil
  EnvVarStore.failRead = true
  EnvVarStore.legacyValues["SAME"] = "stale legacy value"
  do { try same.update(id: sameID, key: "SAME", value: "must not write").get(); fatalError("unreadable original accepted") } catch EnvVarStore.MutationError.keychainReadFailed {}
  check(EnvVarStore.values["SAME"] == "replacement" && same.dirties == 2, "unreadable original is not treated as missing/empty")
  EnvVarStore.failRead = false
  EnvVarStore.values["SAME"] = nil
  do { try same.update(id: sameID, key: "SAME", value: "replacement").get(); fatalError("legacy-original metadata failure hidden") } catch EnvVarStore.MutationError.metadataWriteFailed {}
  check(EnvVarStore.values["SAME"] == "stale legacy value", "missing synchronized item falls back to the readable legacy value")
  EnvVarStore.legacyValues["SAME"] = nil
  EnvVarStore.values["SAME"] = ""
  do { try same.update(id: sameID, key: "SAME", value: "replacement").get(); fatalError("empty-original metadata failure hidden") } catch EnvVarStore.MutationError.metadataWriteFailed {}
  check(EnvVarStore.values["SAME"] == "", "empty original remains an empty item rather than missing")
  EnvVarStore.values["SAME"] = nil
  do { try same.update(id: sameID, key: "SAME", value: "new").get(); fatalError("missing-original metadata failure hidden") } catch EnvVarStore.MutationError.metadataWriteFailed {}
  check(EnvVarStore.values["SAME"] == nil, "missing original rolls back by removing only the new value")
  EnvVarStore.failDelete = true
  do { try same.update(id: sameID, key: "SAME", value: "new").get(); fatalError("delete compensation failure hidden") } catch EnvVarStore.MutationError.valueChangedMetadataWriteFailed {}
  check(EnvVarStore.values["SAME"] == "new" && same.dirties == 3, "failed removal reports partial success and marks dirty")
  EnvVarStore.failDelete = false
  same.metadataFails = false
  try same.update(id: sameID, key: "SAME", value: "new", note: "new note").get()
  check(same.entries[0].note == "new note" && same.dirties == 4, "partial failure remains retryable")
  print("PASS same-key metadata rollback, failed compensation, missing/unreadable original, retry")


  let mcp = MCPStore()
  mcp.servers = [MCPServerConfig(id: "one", url: "old", createdAt: 1, updatedAt: 1)]
  mcp.durable = mcp.servers
  mcp.saveFails = true
  do { try mcp.commitImport([MCPServerConfig(id: "one", url: "new", createdAt: nil, updatedAt: nil)]); fatalError("MCP save failure hidden") } catch {}
  check(mcp.servers[0].url == "old" && mcp.dirties == 0, "MCP failure rolls back visible state")
  mcp.saveFails = false
  try mcp.commitImport([MCPServerConfig(id: "one", url: "new", createdAt: nil, updatedAt: nil)])
  check(mcp.durable[0].url == "new" && mcp.durable[0].createdAt == 1 && mcp.dirties == 1, "MCP overwrite commits and retains creation time")
  print("PASS MCP failed-write rollback and successful replacement")

  check(GatewayRunDriver.submissionDefinitelyRejected(URLError(.notConnectedToInternet)), "offline restores draft")
  check(GatewayRunDriver.submissionDefinitelyRejected(GatewayError.http(status: 401, message: nil)), "rejected auth restores draft")
  check(!GatewayRunDriver.submissionDefinitelyRejected(URLError(.timedOut)), "timeout must not invite duplicate submission")
  check(!GatewayRunDriver.submissionDefinitelyRejected(GatewayError.http(status: 500, message: nil)), "server failure may have admitted work")
  check(!GatewayRunDriver.submissionDefinitelyRejected(GatewayError.http(status: 409, message: nil)), "conflict is uncertain")
  let offline = GatewayRunDriver()
  offline.client.failure = URLError(.notConnectedToInternet)
  offline.send("preserve this draft")
  await offline.streamTask?.value
  check(offline.unsentPrompt == "preserve this draft", "definitive rejection restores exact draft")
  check(!offline.isRunning && offline.status == "failed", "rejected submission leaves running state")
  check(offline.items.first?.text == "→ preserve this draft", "submitted text stays in transcript")
  let uncertain = GatewayRunDriver()
  uncertain.client.failure = URLError(.timedOut)
  uncertain.send("do not blindly retry")
  await uncertain.streamTask?.value
  check(uncertain.unsentPrompt == nil, "uncertain admission does not restore ready-to-send draft")
  check(uncertain.items.first?.text == "→ do not blindly retry", "uncertain text remains accessible")
  check(uncertain.lastError?.contains("Check the Mac") == true, "uncertain admission shows recovery action")
  let accepted = GatewayRunDriver()
  accepted.send("accepted")
  await accepted.streamTask?.value
  check(accepted.runId == "run-1" && accepted.unsentPrompt == nil, "accepted request follows run without restoring draft")
  print("PASS actual send lifecycle: definitive draft recovery, uncertain transcript, accepted run")
 }
}
'''
with tempfile.TemporaryDirectory(prefix='leo-support-recovery-') as work:
    work = Path(work)
    swift = work / 'Recovery.swift'
    swift.write_text(source)
    binary = work / 'recovery'
    subprocess.run(['swiftc', '-parse-as-library', '-module-cache-path', str(work / 'cache'), str(swift), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
