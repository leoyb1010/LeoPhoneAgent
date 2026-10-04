import SwiftUI

/// 独立宿主编译生产工作区；本机内容仅是导航/状态保留 fixture，不是完整 App。
@main
struct PaperclipAuditApp: App {
    private let taskFixture = ProcessInfo.processInfo.arguments.contains("--server-task-fixture")
    init() {
        if ProcessInfo.processInfo.arguments.contains("--reset-paperclip-fixture"),
           let domain = Bundle.main.bundleIdentifier {
            UserDefaults.standard.removePersistentDomain(forName: domain)
        }
        if ProcessInfo.processInfo.arguments.contains("--server-task-fixture") {
            UserDefaults.standard.set(IOSExecutionBackend.paperclip.rawValue, forKey: "leo.ios.executionBackend.v1")
        }
    }
    var body: some Scene {
        WindowGroup {
            IOSWorkspaceRootView(makeStore: {
                taskFixture ? PaperclipAuditFixture.makeStore() : PaperclipWorkspaceStore()
            }) { LocalWorkspaceFixture() }
        }
    }
}

private struct LocalWorkspaceFixture: View {
    @AppStorage("leo.ios.executionBackend.v1") private var backend = IOSExecutionBackend.local.rawValue
    @State private var draft = ""
    @State private var chatDraft = ""
    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Text("本机会话保留").accessibilityIdentifier("fixture.localSessions")
                Text("本机记忆与工具保留")
                TextField("未发送的本机草稿", text: $draft).accessibilityIdentifier("fixture.localDraft")
                NavigationLink("打开本机会话") {
                    VStack(spacing: 16) {
                        Text("本机聊天保留").accessibilityIdentifier("fixture.localChat")
                        TextField("未发送的聊天草稿", text: $chatDraft).accessibilityIdentifier("fixture.chatDraft")
                    }
                    .navigationTitle("本机聊天")
                    .toolbar { workspaceEntry }
                }.accessibilityIdentifier("fixture.openChat")
            }
            .navigationTitle("本机工作区")
            .toolbar { workspaceEntry }
        }
    }
    private var workspaceEntry: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button("服务器任务") { backend = IOSExecutionBackend.paperclip.rawValue }
                .accessibilityIdentifier("paperclip.openWorkspace")
        }
    }
}
