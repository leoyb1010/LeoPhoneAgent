#!/usr/bin/env python3
"""Run unchanged production URL dispatch and settings presentation handlers.
Only external services/storage are in-memory adapters. No user defaults, DB,
simulator, device, authorization, network or live account is accessed.
"""
from pathlib import Path
import importlib.util
import subprocess
import tempfile
root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('audit_generator', root/'scripts/native-model-audit/generate.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
router = (root/'src/ios/Shared/DeepLinkRouter.swift').read_text()
methods = '\n'.join(module.extract_swift_method(router, name) for name in ['handle', 'handleSettings'])
content = (root/'src/ios/Views/ContentView.swift').read_text()
start = content.index('.onChange(of: deepLink.pendingSettingsTarget')
end = content.index('.onChange(of: deepLink.pendingCollections', start)
observer = content[start:end]
swift = r'''
import Foundation
struct AppLogger { func info(_ message: String) {} }
let deepLinkLog = AppLogger()
enum IOSExecutionBackend: String { case local, paperclip }
final class UserDefaults {
 static let standard = UserDefaults(); var values: [String: String] = [:]
 func set(_ value: String, forKey key: String) { values[key] = value }
 func string(forKey key: String) -> String? { values[key] }
}
@MainActor final class ShareCoordinator { func raisePendingShare() {} }
@MainActor final class QuickActionRouter {
 static let shared = QuickActionRouter(); var newCalls = 0; var voiceCalls = 0
 func startVoiceChat() { voiceCalls += 1 }
 func startNewChat() { newCalls += 1 }
 func startQuickTask(id: String) {}
}
enum OffloadPermissionManager { static func isReservedSessionId(_ id: String) -> Bool { id.hasPrefix("__") } }
actor ChatStore { static let shared = ChatStore(); func sessionExists(id: String) -> Bool { id == "known-session" } }
@MainActor final class NotificationNavigationStore {
 static let shared = NotificationNavigationStore(); var pending: String?
 func setPending(_ id: String) { pending = id }
}
extension Notification.Name { static let openSessionFromIntent = Notification.Name("fixture-open") }
@MainActor final class DeepLinkCoordinator {
 static let shared = DeepLinkCoordinator()
 enum Target: Equatable {
  case home, providers, modelGroups, usage, skills, mcpIntegrations, mailAccounts, memory, storage,
       mountedFolders, sharedFolders, logs, appearance, background, about, permissions, selfTest,
       macConsole, environments
  case providerDetail(instanceId: String), modelGroupDetail(groupId: String), mcpServerDetail(serverId: String)
 }
 struct EnvCreate { let key: String; let value: String; let note: String }
 var pendingSettingsTarget: Target?; var showAlarmList = false; var terminalInitCommand: String?
 var showTerminal = false; var pendingCollections = false; var pendingLogsTab: String?
 var pendingEnvVarCreate: EnvCreate?; var pendingRootfsManagement = false
 func setFocus(rawQueryValue: String?) {}
}
@MainActor enum DeepLinkRouter {
 static func handleWebAppLauncherReturn(url: URL) {}
''' + methods + r'''
}
@MainActor final class WindowRegistry {
 static let shared = WindowRegistry(); var primary = true
 func isPrimary(_ id: UUID) -> Bool { primary }
}
@MainActor struct Observer {
 @discardableResult func onChange<Value>(of value: Value, _ callback: (Value) -> Void) -> Observer { self }
 @discardableResult func onChange<Value>(of value: Value, initial: Bool, _ callback: (Value, Value) -> Void) -> Observer {
  if initial { callback(value, value) }; return self
 }
}
@MainActor final class SettingsHost {
 enum Sheet { case settings }
 var activeToolSheet: Sheet?; let deepLink = DeepLinkCoordinator.shared; let windowId = UUID()
 func attach() { Observer()
''' + observer + r'''
 }
}
func expect(_ value: Bool, _ message: String) { if !value { print("FAIL: " + message); exit(1) } }
@main struct Runner {
 @MainActor static func main() async {
  let key = "leo.ios.executionBackend.v1"
  func reset() { UserDefaults.standard.set("paperclip", forKey: key); NotificationNavigationStore.shared.pending = nil; DeepLinkCoordinator.shared.pendingSettingsTarget = nil }
  func route(_ value: String) { DeepLinkRouter.handle(url: URL(string: value)!, shareCoordinator: ShareCoordinator()) }
  for routeName in ["settings", "settings/providers", "settings/model-groups", "settings/not-real"] {
   reset(); route("leophoneagent://" + routeName)
   expect(UserDefaults.standard.string(forKey: key) == "local", "settings remained in hidden Paperclip workspace")
   expect(DeepLinkCoordinator.shared.pendingSettingsTarget != nil, "settings target not dispatched")
  }
  for routeName in ["new", "new_chat", "voice"] {
   reset(); route("leophoneagent://" + routeName)
   expect(UserDefaults.standard.string(forKey: key) == "local", "explicit local " + routeName + " stayed hidden")
  }
  for routeName in ["session", "sessions"] {
   reset(); route("leophoneagent://" + routeName + "/known-session")
   for _ in 0..<30 { if NotificationNavigationStore.shared.pending != nil { break }; try? await Task.sleep(nanoseconds: 1_000_000) }
   expect(NotificationNavigationStore.shared.pending == "known-session", "valid session lost its cold-launch buffer")
   expect(UserDefaults.standard.string(forKey: key) == "local", "valid session routed into a hidden local stack")
  }
  for value in ["leophoneagent://sessions/missing", "leophoneagent://sessions/__new__fixture", "leophoneagent://sessions/", "leophoneagent://unknown", "https://example.invalid/settings"] {
   reset(); route(value); try? await Task.sleep(nanoseconds: 5_000_000)
   expect(UserDefaults.standard.string(forKey: key) == "paperclip", "unknown or reserved route changed workspace")
   expect(NotificationNavigationStore.shared.pending == nil, "unknown or reserved session navigated")
  }
  reset(); DeepLinkCoordinator.shared.pendingSettingsTarget = .providers
  let cold = SettingsHost(); cold.attach()
  expect(cold.activeToolSheet == .settings, "cold pending settings target was ignored")
  WindowRegistry.shared.primary = false
  let secondary = SettingsHost(); secondary.attach()
  expect(secondary.activeToolSheet == nil, "settings presented in a secondary window")
  WindowRegistry.shared.primary = true; DeepLinkCoordinator.shared.pendingSettingsTarget = nil
  let noTarget = SettingsHost(); noTarget.attach()
  expect(noTarget.activeToolSheet == nil, "no pending settings target still opened a sheet")
  expect(QuickActionRouter.shared.newCalls == 2 && QuickActionRouter.shared.voiceCalls == 1, "explicit entry did not invoke its original action exactly once")
  print("PASS production deep links: 14 routes + cold initial target, window ownership, empty target, original actions")
 }
}
'''
with tempfile.TemporaryDirectory(prefix='leo-workspace-link-') as folder:
    code = Path(folder)/'main.swift'; code.write_text(swift); binary = Path(folder)/'smoke'
    subprocess.run(['swiftc', '-parse-as-library', str(code), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
