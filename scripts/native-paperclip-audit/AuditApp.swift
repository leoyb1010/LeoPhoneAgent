import SwiftUI

/// 独立宿主直接编译生产工作区视图，不复制一份假 UI，也不加载 iSH/Watch。
@main
struct PaperclipAuditApp: App {
    @StateObject private var fixtureStore: PaperclipWorkspaceStore
    private let taskFixture = ProcessInfo.processInfo.arguments.contains("--server-task-fixture")
    init() {
        if ProcessInfo.processInfo.arguments.contains("--reset-paperclip-fixture") {
            if let domain = Bundle.main.bundleIdentifier { UserDefaults.standard.removePersistentDomain(forName: domain) }
        }
        _fixtureStore = StateObject(wrappedValue: PaperclipAuditFixture.makeStore())
    }
    var body: some Scene {
        WindowGroup {
            if taskFixture {
                PaperclipWorkspaceView(store: fixtureStore)
                    .environment(\.locale, Locale(identifier: "zh_Hans_CN"))
            } else {
              IOSWorkspaceRootView {
                NavigationStack {
                    VStack(spacing: 16) {
                        Text("本机会话保留").accessibilityIdentifier("fixture.localSessions")
                        Text("本机记忆与工具保留")
                    }.navigationTitle("本机工作区")
                }
              }
            }
        }
    }
}
