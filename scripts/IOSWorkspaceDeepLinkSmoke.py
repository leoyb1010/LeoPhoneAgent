#!/usr/bin/env python3
"""Run unchanged production URL dispatch and settings presentation handlers.
Only external services/storage are in-memory adapters. No user defaults, DB,
simulator, device, authorization, network or live account is accessed.

Compiled verbatim from production: DeepLinkRouter.handle / handleSettings /
handleWebAppLauncherReturn, QuickActionRouter.postNewChat,
NotificationNavigationStore.setPending / setPendingMac (cold-launch buffer used by
notification taps, Spotlight, Siri/App Intents) and IOSExecutionBackend.selectLocal.
ContentView's warm-path receivers live in a SwiftUI body and are checked as
source assertions instead.
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
methods = '\n'.join(module.extract_swift_method(router, name)
                    for name in ['handle', 'handleSettings', 'handleWebAppLauncherReturn'])
quick = (root/'src/ios/Shared/QuickActionRouter.swift').read_text()
post_new_chat = module.extract_swift_method(quick, 'postNewChat')
intents = (root/'src/ios/Agent/Intents/SendPromptIntent.swift').read_text()
pending_methods = '\n'.join(module.extract_swift_method(intents, name) for name in ['setPending', 'setPendingMac'])
contract = (root/'src/ios/Agent/Paperclip/PaperclipContract.swift').read_text()
backend_start = contract.index('enum IOSExecutionBackend')
backend = contract[backend_start:contract.index('\n}\n', backend_start) + 3]
# [G7] 服务器任务深链：解析器与编号校验同样逐字取自生产代码。
link_start = contract.index('enum PaperclipDeepLink')
paperclip_link = contract[link_start:contract.index('\n}\n', link_start) + 3]
component = module.extract_swift_method(contract, 'component')
content = (root/'src/ios/Views/ContentView.swift').read_text()
# SwiftUI 接收器不能脱离视图编译：用源码断言确认热启动路径在导航前先切回本机。
local_write = 'executionBackend = IOSExecutionBackend.local.rawValue'
receiver = content[content.index('.onReceive(NotificationCenter.default.publisher(for: .openSessionFromIntent))'):]
assert local_write in receiver[:receiver.index('macSessionId')], 'openSessionFromIntent receiver does not select local first'
# [T-local-first] 冷启动总是从本机开始：App.init 里在其他启动步骤之前写回本机。
app = (root/'src/ios/MinisApp.swift').read_text()
app_init = app[app.index('    init() {'):]
assert 'IOSExecutionBackend.selectLocal()' in app_init[:app_init.index('LeoPerf.start()')], 'cold launch does not reset to local'
new_chat = module.extract_swift_method(content, 'handleNewChatRequest')
assert local_write in new_chat[:new_chat.index('makeNewSessionId')], 'quick action new-chat handler does not select local'
start = content.index('.onChange(of: deepLink.pendingSettingsTarget')
end = content.index('.onChange(of: deepLink.pendingCollections', start)
observer = content[start:end]
swift = r'''
import Foundation
struct AppLogger { func info(_ message: String) {}; func warning(_ message: String) {} }
let deepLinkLog = AppLogger()
let logger = AppLogger()
final class UserDefaults {
 static let standard = UserDefaults(); var values: [String: String] = [:]
 func set(_ value: String, forKey key: String) { values[key] = value }
 func string(forKey key: String) -> String? { values[key] }
}
''' + backend + r'''
enum PaperclipError: Error { case invalidResponse }
enum PaperclipProfile {
''' + component + r'''
}
''' + paperclip_link + r'''
// [C1] 快捷指令回调由 AppURLEntry 先处理；这里只需能编译路由里的同名分支。
final class ShortcutCallbackStore { static let shared = ShortcutCallbackStore(); static let callbackHost = "shortcut-result"
 @discardableResult func handle(url: URL) -> Bool { false } }
@MainActor final class PaperclipNavigationInbox { static let shared = PaperclipNavigationInbox(); var pending: PaperclipDeepLink.Target? }
@MainActor final class ShareCoordinator { var raised = 0; func raisePendingShare() { raised += 1 } }
@MainActor final class QuickActionRouter {
 static let shared = QuickActionRouter(); var newCalls = 0; var voiceCalls = 0; var quickTasks: [String] = []
 var newChatTrigger = 0
 func startVoiceChat() { voiceCalls += 1; postNewChat() }
 func startNewChat() { newCalls += 1; postNewChat() }
 func startQuickTask(id: String) { quickTasks.append(id); postNewChat() }
''' + post_new_chat + r'''
}
enum WebAppPathScope: String { case sessionAttachment, sessionWorkspace, shared, mount }
enum WebAppIconRef { case preset(String) }
struct WebAppShortcut {
 init(id: String, htmlPath: String, pathScope: WebAppPathScope, scopeContext: String?, title: String,
      iconRef: WebAppIconRef, iconCachePath: String?, createdAt: Date, sourceSessionId: String?) {}
}
extension Notification.Name {
 static let dismissAllImmersivePresentations = Notification.Name("fixture-dismiss")
 static let openWebAppDeepLink = Notification.Name("fixture-webapp")
}
enum OffloadPermissionManager { static func isReservedSessionId(_ id: String) -> Bool { id.hasPrefix("__") } }
actor ChatStore { static let shared = ChatStore(); func sessionExists(id: String) -> Bool { id == "known-session" } }
@MainActor final class NotificationNavigationStore {
 static let shared = NotificationNavigationStore()
 private var pendingSessionId: String?; private var pendingSetAt: Date?
 private var pendingMac: (target: [String: String], at: Date)?
 var pending: String? { get { pendingSessionId } set { pendingSessionId = newValue; pendingMac = nil } }
 var mac: [String: String]? { pendingMac?.target }
''' + pending_methods + r'''
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
  // 1.53.2：其余显示本机内容的深链入口同样切回本机，原动作照常执行。
  let share = ShareCoordinator()
  let localRoutes = ["leophoneagent://quick-task/fixture-task", "leophoneagent://quick_task/fixture-task", "leophoneagent://share",
                     "leophoneagent://views/alarm", "leophoneagent://open_terminal?init_command=ls", "leophoneagent://collections",
                     "leophoneagent://treasury", "leophoneagent://open?path=shared:index.html",
                     "leophoneagent://open?session=s1&path=workspace/app/index.html"]
  for value in localRoutes {
   reset(); DeepLinkRouter.handle(url: URL(string: value)!, shareCoordinator: share)
   expect(UserDefaults.standard.string(forKey: key) == "local", value + " stayed in hidden Paperclip workspace")
  }
  expect(QuickActionRouter.shared.quickTasks == ["fixture-task", "fixture-task"], "quick task action lost")
  expect(share.raised == 1, "share route did not raise pending share")
  expect(DeepLinkCoordinator.shared.showAlarmList && DeepLinkCoordinator.shared.showTerminal && DeepLinkCoordinator.shared.pendingCollections, "local presentation flags not set")
  expect(DeepLinkCoordinator.shared.terminalInitCommand == "ls", "terminal command not prefilled")
  for value in ["leophoneagent://quick-task/", "leophoneagent://views/other", "leophoneagent://open",
                "leophoneagent://open?path=unknown/x", "leophoneagent://open?path=attachments/x.html"] {
   reset(); route(value)
   expect(UserDefaults.standard.string(forKey: key) == "paperclip", "invalid " + value + " changed workspace")
  }
  // [G7] 服务器任务深链（通知、灵动岛、Spotlight 共用）：切到 Paperclip 工作区并缓冲待打开的工单，不被切回本机。
  func resetLocal() { UserDefaults.standard.set("local", forKey: key); PaperclipNavigationInbox.shared.pending = nil }
  resetLocal(); route("leophoneagent://paperclip/issue/issue-1?company=company_a")
  expect(UserDefaults.standard.string(forKey: key) == "paperclip", "paperclip issue link stayed in local workspace")
  expect(PaperclipNavigationInbox.shared.pending == PaperclipDeepLink.Target(issueID: "issue-1", companyID: "company_a"), "paperclip issue link lost its target")
  resetLocal(); route("leophoneagent://paperclip/issue/PAP-12")
  expect(PaperclipNavigationInbox.shared.pending?.issueID == "PAP-12" && PaperclipNavigationInbox.shared.pending?.companyID == nil, "identifier link not buffered")
  let built = PaperclipDeepLink.url(issueID: "issue-2", companyID: "company_b")!
  resetLocal(); route(built.absoluteString)
  expect(PaperclipNavigationInbox.shared.pending?.issueID == "issue-2", "link built for notifications/Live Activity/Spotlight does not round-trip")
  for value in ["leophoneagent://paperclip/issue/", "leophoneagent://paperclip/issue/a/b", "leophoneagent://paperclip/agent/x", "leophoneagent://paperclip"] {
   resetLocal(); route(value)
   expect(UserDefaults.standard.string(forKey: key) == "local", "invalid " + value + " changed workspace")
   expect(PaperclipNavigationInbox.shared.pending == nil, "invalid " + value + " buffered a target")
  }
  // 冷启动缓冲：通知点击、Spotlight、Siri/App Intents 经 setPending/setPendingMac；快捷操作、小组件、控制中心经 postNewChat。
  reset(); NotificationNavigationStore.shared.setPending("notification-session")
  expect(UserDefaults.standard.string(forKey: key) == "local" && NotificationNavigationStore.shared.pending == "notification-session", "notification/Spotlight/Siri cold buffer stayed hidden")
  reset(); NotificationNavigationStore.shared.setPendingMac(["macSessionId": "m1"])
  expect(UserDefaults.standard.string(forKey: key) == "local" && NotificationNavigationStore.shared.mac?["macSessionId"] == "m1", "Mac session notification stayed hidden")
  reset(); let before = QuickActionRouter.shared.newChatTrigger; QuickActionRouter.shared.startNewChat()
  expect(UserDefaults.standard.string(forKey: key) == "local" && QuickActionRouter.shared.newChatTrigger == before + 1, "home screen quick action stayed hidden")
  print("PASS production deep links: 18 local routes + 10 rejected, 3 Paperclip issue routes + 4 rejected, cold buffers (notification/Spotlight/Siri/Mac/quick action), warm receivers (source), window ownership, original actions")
 }
}
'''
with tempfile.TemporaryDirectory(prefix='leo-workspace-link-') as folder:
    code = Path(folder)/'main.swift'; code.write_text(swift); binary = Path(folder)/'smoke'
    subprocess.run(['swiftc', '-parse-as-library', str(code), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
