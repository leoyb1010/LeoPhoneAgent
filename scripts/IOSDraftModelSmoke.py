#!/usr/bin/env python3
"""Execute production draft resolution/cache/initial binding with synthetic providers.
Keychain, database and network adapters stay entirely in memory.
"""
from pathlib import Path
import importlib.util
import subprocess
import tempfile
root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('audit_generator', root / 'scripts/native-model-audit/generate.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
factory = (root / 'src/ios/Agent/Chat/AIChatViewModel+ProviderFactory.swift').read_text()
persistence = (root / 'src/ios/Agent/Chat/AIChatViewModel+Persistence.swift').read_text()
resolver = factory[factory.index('    private struct ResolveCacheKey:'):factory.index('    /// Resolve a sub-model entry')]
initial = module.extract_swift_method(persistence, 'createInitialBinding').replace('private func', 'func')
vm = (root / 'src/ios/Agent/Chat/AIChatViewModel.swift').read_text()
# Execute the unchanged admission prefix; the sentinel represents entering the
# destructive/send work after admission, not a fake network implementation.
send_start = vm.index('    func send() {')
send_gate = vm[send_start:vm.index('        // [T-ios-photo-pick-placeholder]', send_start)] + '        admittedSends += 1\n    }\n'
swift = r'''
import Foundation
struct Model { let id: String; var displayName: String { id } }
struct ModelEntry { let id: String; let model: Model; let providerInstanceId: String; var isHidden = false; var compositeKey: String { id } }
struct Instance { var isEnabled = true; var hasAnyCredential = true; var isRetiredSignIn = false }
struct ModelGroup { let id: String; let memberEntryIds: [String] }
enum SessionModelSource {
 case directEntry(modelEntryId: String, modelCompositeKey: String? = nil)
 case group(groupId: String, resolvedEntryId: String)
}
struct SessionModelBinding { let sessionId: String; let primarySource: SessionModelSource; let subModelSource: SessionModelSource? }
final class ProviderConfigStore {
 static let shared = ProviderConfigStore()
 var configRevision: UInt = 0; var authRevision: UInt = 0
 var modelEntries: [ModelEntry] = []; var instances: [String: Instance] = [:]; var groups: [String: ModelGroup] = [:]
 var defaultPrimaryGroupId: String?; var defaultSubGroupId: String?
 var bindings: [String: SessionModelBinding] = [:]
 func entry(for key: String) -> ModelEntry? { modelEntries.first { $0.id == key } }
 func group(for key: String) -> ModelGroup? { groups[key] }
 func instance(for key: String) -> Instance? { instances[key] }
 func binding(for key: String) -> SessionModelBinding? { bindings[key] }
 func setBinding(_ value: SessionModelBinding, for key: String) { bindings[key] = value; configRevision += 1 }
}
enum ModelSwitcher {
 static func isAvailable(_ entry: ModelEntry, store: ProviderConfigStore) -> Bool {
  guard !entry.isHidden, let i = store.instance(for: entry.providerInstanceId) else { return false }
  return i.isEnabled && i.hasAnyCredential && !i.isRetiredSignIn
 }
 static func remember(_ key: String) {}
}
enum ModelGroupRouter {
 static func resolve(group: ModelGroup, sessionId: String, store: ProviderConfigStore, verbose: Bool = true) -> String? {
  group.memberEntryIds.first { key in store.entry(for: key).map { ModelSwitcher.isAvailable($0, store: store) } ?? false }
 }
}
struct Logger { func info(_ text: String) {}; func warning(_ text: String) {} }
let logger = Logger()
final class ChatStore { static let shared = ChatStore(); func updateSessionModelId(_ sid: String, modelId: String) async {} }
final class Harness {
 var sessionId: String?; var draftId: String? = "draft-A"
 var initialEntryKey: String?; var initialGroupId: String?
 var cachedSessionModelId = ""; var selectedModel = Model(id: "default")
 var errorMessage: String?
 var remoteDeviceId: String?; var hasLoadingAttachments = false; var admittedSends = 0
 func applyGroupSessionDefaults(group: ModelGroup, sessionId: String, preserveThinkingLevel: Bool = false) {}
 static func resolveLastUsedEntry(excludingSessionId: String, store: ProviderConfigStore) async -> ModelEntry? { store.entry(for: "text") }
 static func resolveLatestProviderTextEntry(store: ProviderConfigStore) -> ModelEntry? { store.entry(for: "text") }
''' + resolver + initial + '\n' + send_gate + r'''
}
func expect(_ condition: Bool, _ message: String) { if !condition { print("FAIL: " + message); exit(1) } }
@main struct Runner {
 static func main() async {
  let store = ProviderConfigStore.shared
  store.instances["p"] = Instance()
  store.modelEntries = [ModelEntry(id:"text", model: Model(id:"text"), providerInstanceId:"p"), ModelEntry(id:"vision", model:Model(id:"vision"), providerInstanceId:"p")]
  store.groups["default"] = ModelGroup(id:"default", memberEntryIds:["text"])
  store.groups["empty"] = ModelGroup(id:"empty", memberEntryIds:[])
  store.groups["images"] = ModelGroup(id:"images", memberEntryIds:["vision"])
  store.defaultPrimaryGroupId = "default"
  let draft = Harness(); draft.initialEntryKey = "vision"
  expect(draft.resolveCurrentEntry()?.id == "vision", "first-send capability check used default instead of Home choice")
  draft.initialEntryKey = "text"
  expect(draft.resolveCurrentEntry()?.id == "text", "draft choice cache did not invalidate")
  draft.initialEntryKey = nil; draft.initialGroupId = "images"
  expect(draft.resolveCurrentEntry()?.id == "vision", "draft group ignored before first send")
  draft.initialGroupId = "empty"
  expect(draft.resolveCurrentEntry() == nil, "empty explicit group silently resolved global default")
  draft.send()
  expect(draft.admittedSends == 0 && draft.errorMessage != nil, "send admitted unavailable explicit choice")
  draft.sessionId = "created"
  await draft.createInitialBinding(for:"created")
  expect(store.binding(for:"created") == nil, "initial binding silently used last-used model for unavailable explicit group")
  expect(draft.resolveCurrentEntry() == nil, "new session without explicit binding silently resolved global default")
  let direct = Harness(); direct.initialEntryKey = "vision"
  direct.hasLoadingAttachments = true; direct.send()
  expect(direct.admittedSends == 0, "direct send consumed loading attachments")
  direct.hasLoadingAttachments = false; direct.send()
  expect(direct.admittedSends == 1, "valid direct choice did not pass admission")
  store.groups = [:]; store.defaultPrimaryGroupId = nil; store.configRevision += 1
  await direct.createInitialBinding(for:"direct")
  if case .directEntry(let id, _)? = store.binding(for:"direct")?.primarySource { expect(id == "vision", "wrong direct model") }
  else { expect(false, "group-free direct choice cannot bind") }
  store.instances["p"]?.hasAnyCredential = false; store.authRevision += 1
  expect(direct.resolveCurrentEntry() == nil, "credential removal did not invalidate draft resolution")
  print("PASS production draft resolver/cache/binding: explicit entry/group, unavailable selection, no groups, credential change")
 }
}
'''
with tempfile.TemporaryDirectory(prefix='leo-draft-model-') as folder:
    code = Path(folder) / 'Smoke.swift'; code.write_text(swift)
    binary = Path(folder) / 'smoke'
    subprocess.run(['swiftc', '-parse-as-library', str(code), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
