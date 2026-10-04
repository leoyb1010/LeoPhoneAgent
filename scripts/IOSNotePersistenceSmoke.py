#!/usr/bin/env python3
"""Actual note body IO + editor save methods with disposable filesystem failures.
No app group, live Treasury data, model execution or simulator is used.
"""
from pathlib import Path
import importlib.util
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('audit_generator', ROOT / 'scripts/native-model-audit/generate.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
view = (ROOT / 'src/ios/Views/NoteEditorView.swift').read_text()
static_source = view[view.index('    private static func persist(body:'):]
persist = module.extract_swift_method(static_source, 'persist').replace('private static func', 'static func', 1)
instance_persist = module.extract_swift_method(view, 'persist').replace('private func', 'func', 1)
checkpoint = module.extract_swift_method(view, 'checkpointRecovery').replace('private func', 'func', 1)
schedule = module.extract_swift_method(view, 'scheduleSave').replace('private func', 'func', 1)
def property_source(name):
    start = view.index('    private var ' + name + ':')
    end = view.index('\n    }', start) + 6
    return view[start:end].replace('private var', 'var', 1)
save_result_start = view.index('    enum SaveResult:')
save_result_end = view.index('\n    }', save_result_start) + 6
save_result = view[save_result_start:save_result_end]
body_source = (ROOT / 'src/ios/Shared/NoteBodyStore.swift').read_text()
recovery_root = 'FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]\n            .appendingPathComponent("NoteRecoveryDrafts", isDirectory: true)'
assert recovery_root in body_source
body_source = body_source.replace(recovery_root, 'fixtureRecoveryDirectory')
support = r'''
import Foundation
var fixtureRecoveryDirectory: URL!
struct CollectedItem { let id: String; var bodyFile: String?; var title: String?; var value = "old preview"; var updatedAt = Date(timeIntervalSince1970: 1) }
enum SharedContainerStore {
 static func isSafeFileName(_ name: String) -> Bool { !name.isEmpty && !name.contains("/") && name != "." && name != ".." }
}
enum CollectionStore {
 static let noteIOQueue = DispatchQueue(label: "fixture.note.io")
 static var notesDirectory: URL?
 static var versionsDirectory: URL?
 static var items: [CollectedItem] = []
 static func load() -> [CollectedItem] { items }
}
actor CollectionSearchIndex {
 static let shared = CollectionSearchIndex()
 var bodies: [String] = []
 func index(itemId: String, title: String, body: String) { bodies.append(body) }
}
@MainActor final class EditorProbe {
 let item: CollectedItem
 var onSaved: (CollectedItem) -> Bool
 var body_ = "old body"
 var title = "Original title"
 var loaded = true
 var lastPersistedBody = "old body"
 var lastPersistedTitle = "Original title"
 var isSaving = false
 var editedBeforeLoad = false
 var bodyEditedBeforeLoad = false
 var saveError: String?
 var saveTask: Task<Void, Never>?
 init(item: CollectedItem, onSaved: @escaping (CollectedItem) -> Bool) { self.item = item; self.onSaved = onSaved }
''' + save_result + '\n' + persist + '\n' + instance_persist + '\n' + checkpoint + '\n' + schedule + '\n' + property_source('hasUnsavedChanges') + '\n' + property_source('recoverySnapshot') + r'''
}
func expect(_ value: Bool, _ message: String) { if !value { print("FAIL: " + message); exit(1) } }
@main struct Runner {
 @MainActor static func main() async throws {
  let fm = FileManager.default
  let root = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try fm.createDirectory(at: root, withIntermediateDirectories: true)
  defer { try? fm.removeItem(at: root) }
  fixtureRecoveryDirectory = root.appendingPathComponent("recovery")
  let blocked = root.appendingPathComponent("notes")
  try Data("block the directory".utf8).write(to: blocked)
  CollectionStore.notesDirectory = blocked
  CollectionStore.versionsDirectory = root.appendingPathComponent("versions")
  let item = CollectedItem(id: "fixture", bodyFile: "note-fixture.md", title: "Original title")
  CollectionStore.items = [item]
  var callbacks: [CollectedItem] = []
  let draft = NoteBodyStore.RecoveryDraft(body: "new unsaved body", title: "New title", bodyFile: item.bodyFile)
  expect(NoteBodyStore.saveRecoveryDraft(draft, noteID: item.id), "separate recovery draft should save while note folder is blocked")
  let failed = await EditorProbe.persist(body: "new unsaved body", title: "New title", item: item, onSaved: { callbacks.append($0); return true })
  expect(failed == .bodyFailed, "body failure must return an explicit failure")
  let indexed = await CollectionSearchIndex.shared.bodies
  expect(callbacks.isEmpty, "body write failure must not publish metadata success")
  expect(indexed.isEmpty, "body write failure must not index unpersisted content")

  let editor = EditorProbe(item: item, onSaved: { callbacks.append($0); return true })
  editor.body_ = "new unsaved body"; editor.title = "New title"
  let editorFailed = await editor.persist()
  expect(!editorFailed && editor.lastPersistedBody == "old body" && editor.lastPersistedTitle == "Original title",
      "failed editor save must not advance the successful baseline")
  expect(editor.saveError != nil && editor.hasUnsavedChanges && !editor.isSaving,
      "failed editor save must remain visible, dirty and retryable")
  print("PASS body failure leaves metadata and search index unchanged")

  expect(NoteBodyStore.loadRecoveryDraft(noteID: item.id) == draft, "failed save must retain recoverable title and body")
  let newer = NoteBodyStore.RecoveryDraft(body: "newer typing", title: "Newer title", bodyFile: item.bodyFile)
  expect(NoteBodyStore.saveRecoveryDraft(newer, noteID: item.id), "newer recovery write")
  try fm.removeItem(at: blocked)
  try fm.createDirectory(at: blocked, withIntermediateDirectories: true)
  try fm.createDirectory(at: CollectionStore.versionsDirectory!, withIntermediateDirectories: true)
  let succeeded = await EditorProbe.persist(body: "new unsaved body", title: "New title", item: item, onSaved: { callbacks.append($0); return true })
  expect(succeeded == .saved && callbacks.count == 1, "retry should publish metadata only after body commit")
  expect(try String(contentsOf: blocked.appendingPathComponent(item.bodyFile!), encoding: .utf8) == "new unsaved body", "normal body save semantics")
  expect(NoteBodyStore.loadRecoveryDraft(noteID: item.id) == newer, "older save completion must not delete a newer recovery draft")
  let finalSave = await EditorProbe.persist(body: "newer typing", title: "Newer title", item: item, onSaved: { callbacks.append($0); return true })
  expect(finalSave == .saved && !NoteBodyStore.hasRecoveryDraft(noteID: item.id), "matching successful save clears recovery")
  expect(callbacks.last?.value == "newer typing" && callbacks.last?.title == "Newer title", "metadata reflects committed body")
  let finalIndex = await CollectionSearchIndex.shared.bodies
  expect(finalIndex == ["new unsaved body", "newer typing"], "failed text must never enter index")
  print("PASS actual retry commit, newer-draft protection and matching draft cleanup")

  expect(NoteBodyStore.saveRecoveryDraft(draft, noteID: item.id), "deletion recovery fixture")
  NoteBodyStore.delete(item.bodyFile!)
  _ = await NoteBodyStore.load(item.bodyFile!) // serial-queue barrier after delete
  expect(!NoteBodyStore.hasRecoveryDraft(noteID: item.id), "explicit note deletion must remove recovery data")
  let titleOnly = NoteBodyStore.RecoveryDraft(body: nil, title: "Changed before loading", bodyFile: item.bodyFile)
  expect(NoteBodyStore.saveRecoveryDraft(titleOnly, noteID: item.id), "pre-load title recovery")
  expect(NoteBodyStore.loadRecoveryDraft(noteID: item.id)?.body == nil, "title-only draft must not masquerade as an empty body")
  try fm.removeItem(at: fixtureRecoveryDirectory)
  try Data("block recovery directory".utf8).write(to: fixtureRecoveryDirectory)
  expect(!NoteBodyStore.saveRecoveryDraft(draft, noteID: item.id), "recovery disk failure must report false")
  try fm.removeItem(at: blocked)
  try Data("blocked note directory again".utf8).write(to: blocked)
  let bothFailed = await editor.persist()
  expect(!bothFailed && editor.saveError?.contains("正文和恢复草稿都未能保存") == true,
      "dual disk failure must not claim recovery or permit successful close")
  expect(editor.body_ == "new unsaved body" && editor.hasUnsavedChanges, "dual failure retains live editable content")
  print("PASS explicit-delete cleanup, pre-load title safety and honest recovery-write failure")
 }
}
'''
with tempfile.TemporaryDirectory(prefix='leo-note-recovery-') as temp:
    folder = Path(temp)
    body = folder / 'NoteBodyStore.swift'; body.write_text(body_source)
    code = folder / 'Probe.swift'; code.write_text(support)
    binary = folder / 'probe'
    subprocess.run(['swiftc', '-parse-as-library', '-module-cache-path', str(folder / 'cache'), str(body), str(code), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
    # Actual SwiftUI typecheck, with only Treasury/model execution boundaries
    # replaced. This does not boot a simulator or build the complete app.
    sdk = subprocess.check_output(['xcrun', '--sdk', 'iphonesimulator', '--show-sdk-path'], text=True).strip()
    stubs = folder / 'UIStubs.swift'
    stubs.write_text(r'''
import Foundation
import SwiftUI
struct CollectedItem { let id: String; var bodyFile: String?; var title: String?; var value: String; var updatedAt: Date; var summary: String?; var tags: [String] }
enum SharedContainerStore { static func isSafeFileName(_ name: String) -> Bool { false } }
enum CollectionStore {
 static let noteIOQueue = DispatchQueue(label: "compile-only")
 static var notesDirectory: URL? { nil }; static var versionsDirectory: URL? { nil }
 static func load() -> [CollectedItem] { [] }
}
actor CollectionSearchIndex {
 static let shared = CollectionSearchIndex()
 func index(itemId: String, title: String, body: String) {}
}
@MainActor final class LocalBrain {
 static let shared = LocalBrain(); var isReady = false
 struct Insight { let summary: String; let tags: [String] }
 func summarizeCollection(title: String, text: String) async -> Insight? { nil }
}
''')
    subprocess.run(['swiftc', '-typecheck', '-parse-as-library', '-swift-version', '5', '-sdk', sdk,
                    '-target', 'arm64-apple-ios26.0-simulator', '-module-cache-path', str(folder / 'sdk-cache'),
                    str(ROOT / 'src/ios/Shared/NoteBodyStore.swift'), str(ROOT / 'src/ios/Views/NoteEditorView.swift'),
                    str(stubs)], check=True)
    print('PASS actual NoteEditorView + NoteBodyStore iOS SDK typecheck (not runtime UI)')
