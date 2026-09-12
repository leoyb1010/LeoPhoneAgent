#!/usr/bin/env python3
"""Run actual selection/default-group methods without reading user preferences."""
from pathlib import Path
import subprocess, tempfile
root = Path(__file__).resolve().parents[1]
def method(file, marker):
    text = (root / file).read_text()
    start = text.index(marker); opening = text.index('{', start); depth = 1; end = opening + 1
    while depth:
        if text[end] == '{': depth += 1
        elif text[end] == '}': depth -= 1
        end += 1
    return text[start:end]
resolver = 'src/ios/Providers/Voice/VoiceProviderResolver.swift'
store = 'src/ios/Providers/ProviderConfigStore.swift'
code = r'''
import Foundation
func require(_ value: Bool, _ detail: String) { if !value { FileHandle.standardError.write(Data((detail + "\n").utf8)); exit(1) } }
enum SystemVoiceProvider { static let builtinProviderId = "__builtin_system_speech__" }
struct ModelGroup { var id = UUID().uuidString; let name: String; let memberEntryIds: [String] }
struct Config { var voiceInputGroupId: String?; var modelGroups: [ModelGroup] = [] }
struct Logger { func info(_ message: String) {} }
final class VoiceSelectionStore { static let shared = VoiceSelectionStore(); var inputEntryId: String? }
final class ProviderConfigStore {
 static let shared = ProviderConfigStore()
 var config = Config(); var saves = 0; let logger = Logger()
 var voiceInputGroupId: String? { config.voiceInputGroupId }
 func group(for id: String) -> ModelGroup? { config.modelGroups.first { $0.id == id } }
 func save() { saves += 1 }
''' + method(store, '    func ensureDefaultVoiceInputGroup()') + r'''
}
enum VoiceProviderResolver {
 static let systemEntryId = SystemVoiceProvider.builtinProviderId
 enum SystemInputMode { case auto, online, offline }
''' + method(resolver, '    static func isSystemEntry(') + '\n' + method(resolver, '    static func resolvedSystemInputMode()') + r'''
}
let system = SystemVoiceProvider.builtinProviderId
let store = ProviderConfigStore.shared
func configure(_ selection: String?, _ members: [String]) {
 let group = ModelGroup(name: "fixture", memberEntryIds: members)
 store.config = Config(voiceInputGroupId: group.id, modelGroups: [group])
 VoiceSelectionStore.shared.inputEntryId = selection
}
for selection in [system, system + "/system-asr", system + "/input"] {
 configure(selection, [system + "/system-asr-online"])
 require(VoiceProviderResolver.resolvedSystemInputMode() == .auto, "Explicit automatic selection fell through to Online group member")
}
configure(system + "/system-asr-offline", [system + "/system-asr-online"])
require(VoiceProviderResolver.resolvedSystemInputMode() == .offline, "Offline override lost")
configure(system + "/system-asr-online", [system + "/system-asr-offline"])
require(VoiceProviderResolver.resolvedSystemInputMode() == .online, "Explicit network allowance lost")
configure(nil, [system + "/system-asr", system + "/system-asr-online"])
require(VoiceProviderResolver.resolvedSystemInputMode() == .auto, "Automatic group member was skipped")
configure(nil, ["unrelated/system-asr-online", system + "/system-asr-offline"])
require(VoiceProviderResolver.resolvedSystemInputMode() == .offline, "Foreign provider ID changed System policy")
store.config = Config(); store.saves = 0
let id = store.ensureDefaultVoiceInputGroup()!
require(store.group(for: id)!.memberEntryIds == [system + "/system-asr"], "New default group silently permits network recognition")
require(store.ensureDefaultVoiceInputGroup() == id && store.saves == 1, "Default group creation was not idempotent")
configure(nil, [system + "/system-asr-online"])
let previous = store.voiceInputGroupId!
require(store.ensureDefaultVoiceInputGroup() == previous, "Existing user group was replaced")
require(store.group(for: previous)!.memberEntryIds == [system + "/system-asr-online"], "Existing explicit group was rewritten")
print("PASS actual ASR selection: explicit Auto/Offline/Online, ordered group, provider identity, safe defaults and existing preferences")
'''
with tempfile.TemporaryDirectory(prefix='leophone-speech-selection-') as folder:
    file = Path(folder) / 'main.swift'; file.write_text(code)
    binary = Path(folder) / 'smoke'
    subprocess.run(['swiftc', str(file), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
