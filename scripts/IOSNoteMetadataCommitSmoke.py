#!/usr/bin/env python3
"""Actual Treasury SQLite + note IO/editor commit through real transaction failures.
Only the app-group/defaults roots and search-index observer are test adapters.
"""
from pathlib import Path
import importlib.util
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('audit_generator', ROOT / 'scripts/native-model-audit/generate.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
view = (ROOT / 'src/ios/Views/NoteEditorView.swift').read_text()
store = (ROOT / 'src/ios/Shared/CollectionStore.swift').read_text()
body = (ROOT / 'src/ios/Shared/NoteBodyStore.swift').read_text()
start = store.index('    static var directory: URL? {')
end = store.index('\n    }', start) + 6
store = store[:start] + '    static var directory: URL? { fixtureDirectory }' + store[end:]
recovery_root = 'FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]\n            .appendingPathComponent("NoteRecoveryDrafts", isDirectory: true)'
assert recovery_root in body
body = body.replace(recovery_root, 'fixtureDirectory.appendingPathComponent("recovery")')
methods = '\n'.join(module.extract_swift_method(view, name).replace('private func', 'func', 1)
                    for name in ['persist', 'checkpointRecovery', 'scheduleSave'])
methods += '\n' + module.extract_swift_method(view[view.index('    private static func persist(body:'):], 'persist').replace('private static func', 'static func', 1)
for name in ['hasUnsavedChanges', 'recoverySnapshot']:
    start = view.index('    private var ' + name + ':')
    end = view.index('\n    }', start) + 6
    methods += '\n' + view[start:end].replace('private var', 'var', 1)
if '    enum SaveResult:' in view:
    start = view.index('    enum SaveResult:')
    end = view.index('\n    }', start) + 6
    methods = view[start:end] + '\n' + methods
callback_return = 'Bool' if 'var onSaved: (CollectedItem) -> Bool' in view else 'Void'
swift = r'''
import Foundation
import SQLite3
var fixtureDirectory: URL!
struct PendingShare {
 struct Item { enum Kind { case inlineText, attachment }; let kind: Kind; let value: String }
 let items: [Item]
}
enum SharedContainerStore {
 static let appGroupID = "note-metadata-fixture." + UUID().uuidString
 static var sharedFileDirectory: URL? { fixtureDirectory.appendingPathComponent("shared") }
 static func isSafeFileName(_ name: String) -> Bool { !name.isEmpty && !name.contains("/") && name != "." && name != ".." }
}
actor CollectionSearchIndex {
 static let shared = CollectionSearchIndex()
 var indexedBodies: [String] = []
 func index(itemId: String, title: String, body: String) { indexedBodies.append(body) }
}
@MainActor final class EditorProbe {
 let item: CollectedItem
 var onSaved: (CollectedItem) -> CALLBACK_RETURN
 var body_ = "new body"
 var title = "New title"
 var loaded = true
 var lastPersistedBody = "original body"
 var lastPersistedTitle = "Original title"
 var isSaving = false
 var editedBeforeLoad = false
 var bodyEditedBeforeLoad = false
 var saveError: String?
 var saveTask: Task<Void, Never>?
 init(item: CollectedItem, onSaved: @escaping (CollectedItem) -> CALLBACK_RETURN) { self.item = item; self.onSaved = onSaved }
''' .replace('CALLBACK_RETURN', callback_return) + methods + r'''
}
func expect(_ value: Bool, _ reason: String) { if !value { print("FAIL: " + reason); exit(1) } }
func sql(_ text: String) throws {
 var db: OpaquePointer?
 precondition(sqlite3_open(fixtureDirectory.appendingPathComponent("treasury.sqlite3").path, &db) == SQLITE_OK)
 defer { sqlite3_close(db) }
 let status = sqlite3_exec(db, text, nil, nil, nil)
 if status != SQLITE_OK { throw NSError(domain: "FixtureSQL", code: Int(status), userInfo: [NSLocalizedDescriptionKey: String(cString: sqlite3_errmsg(db))]) }
}
@main enum Runner {
 @MainActor static func main() async throws {
  fixtureDirectory = URL(fileURLWithPath: CommandLine.arguments[1])
  let fm = FileManager.default
  try fm.createDirectory(at: fixtureDirectory, withIntermediateDirectories: true)
  defer { UserDefaults(suiteName: SharedContainerStore.appGroupID)?.removePersistentDomain(forName: SharedContainerStore.appGroupID) }
  var original = CollectedItem.newNote(title: "Original title")
  original.value = "original body"
  let legacyURL = fixtureDirectory.appendingPathComponent("items.json")
  try JSONEncoder().encode([original]).write(to: legacyURL)
  let treasury = try TreasurySQLiteStore(directory: fixtureDirectory)
  let bodyURL = CollectionStore.notesDirectory!.appendingPathComponent(original.bodyFile!)
  try Data("original body".utf8).write(to: bodyURL)
  // The real store writes item + sync journal in a transaction. Reject the
  // metadata update, while the note body and legacy recovery file remain writable.
  try sql("CREATE TRIGGER reject_metadata BEFORE UPDATE ON treasure_items BEGIN SELECT RAISE(ABORT,'injected metadata failure'); END")
  let editor = EditorProbe(item: original, onSaved: { CollectionStore.update($0) })
  let accepted = await editor.persist()
  expect(!accepted, "body success plus failed SQLite metadata must not report complete save")
  expect(try String(contentsOf: bodyURL, encoding: .utf8) == "new body", "body may succeed before metadata failure")
  expect(try treasury.load().first?.title == "Original title", "failed SQLite transaction must retain original title")
  expect(editor.lastPersistedTitle == "Original title" && editor.lastPersistedBody == "original body", "failure must retain complete-save baseline")
  expect(editor.hasUnsavedChanges && editor.saveError?.contains("笔记信息") == true, "metadata-specific retry error must remain visible")
  expect(NoteBodyStore.loadRecoveryDraft(noteID: original.id)?.title == "New title", "metadata failure must retain recovery title")
  let indexedAfterFailure = await CollectionSearchIndex.shared.indexedBodies
  expect(indexedAfterFailure.isEmpty, "uncommitted metadata must not advance search index")
  // The fallback sink is the pending-ops queue (re-imported once SQLite works again), not the
  // frozen items.json that is never read back after migration.
  let pendingURL = fixtureDirectory.appendingPathComponent("items.pending.json")
  let pending = try JSONDecoder().decode(TreasuryPendingOps.self, from: Data(contentsOf: pendingURL))
  expect(pending.upserts.first?.title == "New title", "failed metadata write is queued for re-import, not primary commit")
  let legacy = try JSONDecoder().decode([CollectedItem].self, from: Data(contentsOf: legacyURL))
  expect(legacy.first?.title == "Original title", "frozen legacy JSON is never rewritten")
  // Recovery-queue failure must not change the same false result.
  try fm.removeItem(at: pendingURL)
  try fm.createDirectory(at: pendingURL, withIntermediateDirectories: true)
  let stillRejected = await editor.persist()
  expect(!stillRejected && NoteBodyStore.hasRecoveryDraft(noteID: original.id), "dual metadata sink failure retains recovery")
  try sql("DROP TRIGGER reject_metadata")
  let retried = await editor.persist()
  expect(retried && !editor.hasUnsavedChanges && editor.saveError == nil, "retry commits and advances baseline")
  expect(try treasury.load().first?.title == "New title", "retry writes authoritative title")
  expect(!NoteBodyStore.hasRecoveryDraft(noteID: original.id), "only full successful save clears recovery")
  let indexedAfterRetry = await CollectionSearchIndex.shared.indexedBodies
  expect(indexedAfterRetry == ["new body"], "only committed retry indexes body")
  // A failure later than upsert must roll back the updated row too.
  try sql("CREATE TRIGGER reject_journal BEFORE INSERT ON treasure_changes BEGIN SELECT RAISE(ABORT,'journal failure'); END")
  editor.title = "Third title"
  let journalRejected = await editor.persist()
  expect(!journalRejected && editor.lastPersistedTitle == "New title", "late transaction failure must not advance baseline")
  expect(try treasury.load().first?.title == "New title", "journal failure must roll back earlier metadata write")
  expect(NoteBodyStore.hasRecoveryDraft(noteID: original.id), "late failure retains retry draft")
  print("PASS actual SQLite transaction failures: body written, title rollback, pending-queue backup/failure, frozen legacy JSON, recovery retention, retry and late journal rollback")
 }
}
'''
with tempfile.TemporaryDirectory(prefix='leo-note-metadata-') as temp:
    folder = Path(temp)
    (folder / 'CollectionStore.swift').write_text(store)
    (folder / 'NoteBodyStore.swift').write_text(body)
    (folder / 'Probe.swift').write_text(swift)
    binary = folder / 'probe'
    subprocess.run(['swiftc', '-parse-as-library', '-module-cache-path', str(folder / 'cache'),
                    str(folder / 'CollectionStore.swift'), str(folder / 'NoteBodyStore.swift'), str(folder / 'Probe.swift'),
                    '-o', str(binary)], check=True)
    subprocess.run([str(binary), str(folder / 'data')], check=True)
