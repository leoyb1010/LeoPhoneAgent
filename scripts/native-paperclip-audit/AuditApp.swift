import SwiftUI

/// 独立宿主编译生产工作区；本机内容仅是导航/状态保留 fixture，不是完整 App。
@main
struct PaperclipAuditApp: App {
    init() {
        if ProcessInfo.processInfo.arguments.contains("--reset-paperclip-fixture") {
            if let domain = Bundle.main.bundleIdentifier { UserDefaults.standard.removePersistentDomain(forName: domain) }
        }
    }
    var body: some Scene {
        WindowGroup { IOSWorkspaceRootView { LocalWorkspaceFixture() } }
    }
}

private struct LocalWorkspaceFixture: View {
    @AppStorage("leo.ios.executionBackend.v1") private var backend = IOSExecutionBackend.local.rawValue
    @State private var draft = ""
    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Text("本机会话保留").accessibilityIdentifier("fixture.localSessions")
                Text("本机记忆与工具保留")
                TextField("未发送的本机草稿", text: $draft).accessibilityIdentifier("fixture.localDraft")
            }
            .navigationTitle("本机工作区")
            .toolbar { ToolbarItem(placement: .topBarTrailing) {
                Button("服务器任务") { backend = IOSExecutionBackend.paperclip.rawValue }
                    .accessibilityIdentifier("paperclip.openWorkspace")
            } }
        }
    }
}
