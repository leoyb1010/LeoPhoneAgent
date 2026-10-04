#!/usr/bin/env python3
"""Delayed service adapter exercises actual onboarding validation methods."""
from pathlib import Path
import importlib.util
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('extract', root / 'scripts/native-model-audit/generate.py')
extract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extract)
production = (root / 'src/ios/Views/Providers/AddProviderView.swift').read_text()
names = ['makeOAuthCandidate', 'startValidation', 'cancelValidation', 'finishValidation', 'validateAndSaveAPIKeyInstance',
         'validateAndSaveOAuthInstance', 'validateAndSaveManualOAuthInstance']
methods = '\n'.join(extract.extract_swift_method(production, name).replace('private func', 'func') for name in names)
source = r'''
import Foundation
struct ProviderInstance {
 enum Credential { case apiKey, oauth }
 let id: String
 init(id: String, label: String = "", providerType: String = "", credentialType: Credential = .apiKey,
      customBaseURL: String? = nil, appendV1Suffix: Bool = true) { self.id = id }
}
@MainActor final class Store {
 var saved: [String] = []
 func addInstance(_ instance: ProviderInstance) { saved.append(instance.id) }
}
@MainActor enum ProviderKeychainHelper {
 static var keys: [String: String] = [:]
 static func saveAPIKey(_ value: String, instanceId: String) { keys[instanceId] = value }
 static func deleteAPIKey(instanceId: String) { keys[instanceId] = nil }
 static func saveOAuthString(_ value: String, instanceId: String, account: String) { keys[instanceId] = value }
 static func deleteOAuthString(instanceId: String, account: String) { keys[instanceId] = nil }
}
@MainActor final class Harness {
 enum PendingSaveKind { case apiKey, oauth, manualOAuth }
 var validationTask: Task<Void, Never>?
 var validationGeneration = 0
 var isSaving = false
 var errorMessage: String?
 var pendingSaveKind: PendingSaveKind?
 var manualOAuthTokenInput = "SYNTHETIC-NOT-A-CREDENTIAL"
 var candidateID = "first"
 var pendingInstanceId = "pending-oauth"
 var selectedType: String? = "provider"
 var labelInput = "Fixture"
 var customBaseURLInput = ""
 var appendV1SuffixInput = true
 func defaultLabel(for type: String) -> String { type }
 var dismissals = 0
 var waits: [String: CheckedContinuation<Void, Error>] = [:]
 let store = Store()
 func dismiss() { dismissals += 1 }
 func makeAPIKeyCandidate() -> (instance: ProviderInstance, key: String)? {
  (ProviderInstance(id: candidateID), "SYNTHETIC-NOT-A-CREDENTIAL")
 }
 func validateConnection(for instance: ProviderInstance) async throws {
  try await withCheckedThrowingContinuation { waits[instance.id] = $0 }
 }
''' + methods + r'''
}
enum Failure: Error { case rejected }
func check(_ condition: Bool, _ message: String) { if !condition { print("FAIL: " + message); exit(1) } }
@main struct Runner {
 @MainActor static func main() async {
  for kind in [Harness.PendingSaveKind.apiKey, .oauth, .manualOAuth] {
   for fails in [false, true] {
    let h = Harness()
    h.startValidation(kind)
    let firstTask = h.validationTask!
    while h.waits.isEmpty { await Task.yield() }
    let firstID = h.waits.keys.first!
    h.cancelValidation() // Back, cancel, or view disappearance.
    h.candidateID = "second"
    if kind == .oauth { h.pendingInstanceId = "new-oauth-login" }
    h.startValidation(kind)
    let secondTask = h.validationTask!
    while h.waits.count < 2 { await Task.yield() }
    let secondID = h.waits.keys.first { $0 != firstID }!
    let first = h.waits.removeValue(forKey: firstID)!
    if fails { first.resume(throwing: Failure.rejected) } else { first.resume() }
    await firstTask.value
    check(h.store.saved.isEmpty && h.dismissals == 0, "cancelled validation committed or dismissed a new form")
    check(h.isSaving && h.errorMessage == nil && h.pendingSaveKind == nil, "stale completion changed the new attempt state")
    if kind != .oauth { check(ProviderKeychainHelper.keys[firstID] == nil, "cancelled temporary credential leaked") }
    h.waits.removeValue(forKey: secondID)!.resume()
    await secondTask.value
    if kind != .oauth { check(ProviderKeychainHelper.keys[secondID] != nil, "stale cleanup deleted the new attempt credential") }
    check(h.store.saved == [secondID] && h.dismissals == 1 && !h.isSaving, "live attempt did not commit exactly once")
   }
  }
  let candidates = Harness()
  check(candidates.makeOAuthCandidate(manual: true)!.id != candidates.makeOAuthCandidate(manual: true)!.id,
        "manual validation attempts must own distinct temporary credentials")
  check(candidates.makeOAuthCandidate(manual: false)!.id == candidates.pendingInstanceId,
        "signed-in OAuth must keep its authenticated identity")
  let h = Harness()
  h.startValidation(.apiKey)
  let task = h.validationTask!
  h.cancelValidation()
  await task.value
  check(h.waits.isEmpty && h.store.saved.isEmpty, "cancel before task start still ran validation")
  print("PASS production onboarding: 3 credential flows, late success/failure, replacement attempt, temporary-key cleanup and pre-start cancel")
 }
}
'''
with tempfile.TemporaryDirectory(prefix='leo-provider-validation-') as folder:
    path = Path(folder) / 'Validation.swift'
    binary = Path(folder) / 'validation'
    path.write_text(source)
    subprocess.run(['xcrun', 'swiftc', '-parse-as-library', str(path), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
