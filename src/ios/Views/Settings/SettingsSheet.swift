//
//  SettingsSheet.swift
//  MinisApp
//
//  [T-slim-contentview] 从 5500 行的 ContentView.swift 拆出(原样搬迁,
//  跨文件可见性 private → internal)。
//

import SwiftUI

// MARK: - Settings Sheet

enum SettingsDestination: Hashable {
    case providers
    case providerDetail(instanceId: String)
    case modelGroups
    case modelGroupDetail(groupId: String)
    case usage
    case skills
    case memory
    case storage
    case mountedFolders
    case sharedFolders
    case logs
    case appearance
    case background
    case about
    case permissions
    case environments
    // [T-mcp-oauth-deeplink]
    case mcpIntegrations
    case mcpServerDetail(serverId: String)
    // [T-selftest-1.41]
    case selfTest
    // [T-mac-console-deeplink] leophoneagent://settings/mac
    case macConsole
}

struct SettingsSheet: View {
    /// [T-orchestration] AppStorage (not a raw UserDefaults Binding) so the
    /// toggle knob actually re-renders when flipped.
    @AppStorage(WorkerPool.enabledKey) private var orchestrationEnabled = false

    @Binding var showTerminal: Bool
    @AppStorage("appearanceMode") private var appearanceMode: Int = 0
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var deepLink = DeepLinkCoordinator.shared
    @State private var navPath = NavigationPath()
    @State private var showFeedbackDialog = false
    /// [T-ipad-settings-split] 面板够宽(iPad 整页面板)时用双栏。量到宽度之前
    /// 先按尺寸类别猜,免得第一帧先画单列再跳成双栏。
    @State private var measuredWide: Bool?
    @Environment(\.horizontalSizeClass) private var hSizeClass
    /// Opens on a real page (the most used one), never an empty detail column.
    @AppStorage("settings.split.selection") private var splitSelection = Self.defaultSplitSelection
    private static let defaultSplitSelection = "AI 服务商"

    var body: some View {
        Group {
            if measuredWide ?? (hSizeClass == .regular) { splitSettings } else { stackSettings }
        }
        .onGeometryChange(for: Bool.self) { $0.size.width >= 700 } action: { measuredWide = $0 }
    }

    private var splitSettings: some View {
        NavigationSplitView {
            SettingsSidebar(selection: Binding(
                get: { splitSelection },
                set: { newValue in
                    guard let newValue else { return }
                    splitSelection = newValue
                    navPath = NavigationPath()
                }),
                orchestrationEnabled: $orchestrationEnabled,
                onFeedback: { showFeedbackDialog = true })
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .navigationSplitViewColumnWidth(min: 280, ideal: 320, max: 380)
        } detail: {
            NavigationStack(path: $navPath) {
                Group {
                    if let entry = SettingsHomeView.groups.flatMap(\.entries).first(where: { $0.id == splitSelection }) {
                        entry.destination()
                    } else {
                        ContentUnavailableView("选择一项设置", systemImage: "gearshape.2",
                                               description: Text("左边按分组列出了全部设置，也可以直接搜索。"))
                    }
                }
                .navigationDestination(for: SettingsDestination.self) { settingsDestination($0) }
            }
            // 换一项就从这一项的首页开始,不留上一项推进去的页面。
            .id(splitSelection)
        }
        .sheet(isPresented: $showFeedbackDialog) {
            FeedbackComposerSheet()
        }
        .onAppear(perform: applyLaunchNavigation)
        .onChange(of: deepLink.pendingSettingsTarget) { _, _ in
            applyPendingDeepLink()
        }
        .preferredColorScheme(appearanceMode == 1 ? .light : appearanceMode == 2 ? .dark : nil)
        .appFontScale()
    }

    private var stackSettings: some View {
        NavigationStack(path: $navPath) {
            // [T-settings-ia] 设置首页拆到 SettingsHomeView(5 组折叠 + 搜索)。
            // 旧 400 行单体 List 三次折叠尝试都撞类型检查超时,数据驱动是正解。
            SettingsHomeView(
                orchestrationEnabled: $orchestrationEnabled,
                onFeedback: { showFeedbackDialog = true }
            )
            .sheet(isPresented: $showFeedbackDialog) {
                FeedbackComposerSheet()
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .navigationDestination(for: SettingsDestination.self) { settingsDestination($0) }
            .onAppear(perform: applyLaunchNavigation)
            .onChange(of: deepLink.pendingSettingsTarget) { _, _ in
                applyPendingDeepLink()
            }
        }
        .preferredColorScheme(appearanceMode == 1 ? .light : appearanceMode == 2 ? .dark : nil)
        .appFontScale()
    }

    @ViewBuilder
    private func settingsDestination(_ dest: SettingsDestination) -> some View {
        switch dest {
        case .providers:
            ProviderInstancesView()
        case .providerDetail(let id):
            ProviderInstanceDetailView(instanceId: id)
        case .modelGroups:
            ModelGroupsView()
        case .modelGroupDetail(let id):
            ModelGroupDetailView(groupId: id)
        case .usage:
            UsageStatsView()
        case .skills:
            SkillsManagementView()
        case .memory:
            MemoryManagementView()
        case .storage:
            StorageManagementView()
        case .mountedFolders:
            MountedFoldersSettingsView()
        case .sharedFolders:
            SharedFoldersSettingsView()
        case .selfTest:
            CapabilitySelfTestView()
        case .macConsole:
            GatewayEntryView()
        case .logs:
            // Pull a one-shot tab hint from the deep link router
            // (e.g. `?tab=config-audit`). LogManagementView clears
            // its local state independently; the published value
            // here is consumed once and reset to nil.
            LogManagementView(initialTab: deepLink.pendingLogsTab ?? "logs")
                .onAppear { deepLink.pendingLogsTab = nil }
        case .appearance:
            AppearanceSettingsView()
        case .background:
            EnhancedBackgroundSettingsView()
        case .about:
            AboutView()
        case .environments:
            EnvironmentVariablesView()
        case .permissions:
            OffloadPermissionSettingsView()
        // [T-mcp-oauth-deeplink] Detail = the list view told to open
        // the server's edit sheet on appear; a deleted/unknown server
        // just lands on the list (no crash, sensible fallback).
        case .mcpIntegrations:
            MCPIntegrationsView()
        case .mcpServerDetail(let serverId):
            MCPIntegrationsView(initialEditServerId: serverId)
        }
    }

    /// Deep link / legacy flags / language-change reopen, on first appear —
    /// shared by the single-column and the split layout.
    private func applyLaunchNavigation() {
        // A saved entry that has since been renamed would open on an empty column.
        if !SettingsHomeView.groups.flatMap(\.entries).contains(where: { $0.id == splitSelection }) {
            splitSelection = Self.defaultSplitSelection
        }
        applyPendingDeepLink()
        // Legacy flags — kept so older call sites keep working.
        if deepLink.showEnvironmentVariables {
            show(.environments)
            deepLink.showEnvironmentVariables = false
        }
        if deepLink.showPermissions {
            show(.permissions)
            deepLink.showPermissions = false
        }
        // Restore the user's location after a language-change rebuild.
        // AppearanceSettingsView's language picker writes this flag
        // right before flipping `appLanguage`, knowing the root
        // `.id(appLanguage)` will tear the whole tree down. ContentView
        // re-opens the sheet on re-mount; here we push back to the
        // destination so the user lands where they were, now rendered
        // in the new language.
        if let dest = UserDefaults.standard.string(forKey: "pendingSettingsReopen") {
            UserDefaults.standard.removeObject(forKey: "pendingSettingsReopen")
            switch dest {
            case "appearance":
                show(.appearance)
            default:
                break
            }
        }
    }

    /// Translate `DeepLinkCoordinator.pendingSettingsTarget` into a
    /// NavigationStack push and clear the pending value. Called from
    /// `onAppear` (cold-start deep link) and `onChange` (deep link
    /// arriving while the sheet is already open).
    ///
    /// `.environments` keeps its existing prefill semantics — the
    /// environments view consumes `pendingEnvVarCreate` separately on
    /// appear, so we only have to navigate here.
    private func applyPendingDeepLink() {
        guard let target = deepLink.pendingSettingsTarget else { return }
        // A deep link always lands on the requested destination as the only
        // stack entry, not on top of whatever the user was browsing earlier.
        switch target {
        case .home: show()
        case .providers: show(.providers)
        case .providerDetail(let id): show(.providers, .providerDetail(instanceId: id))
        case .modelGroups: show(.modelGroups)
        case .modelGroupDetail(let id): show(.modelGroups, .modelGroupDetail(groupId: id))
        case .usage: show(.usage)
        case .skills: show(.skills)
        case .memory: show(.memory)
        case .storage: show(.storage)
        case .mountedFolders: show(.mountedFolders)
        case .sharedFolders: show(.sharedFolders)
        case .logs: show(.logs)
        case .appearance: show(.appearance)
        case .background: show(.background)
        case .about: show(.about)
        case .permissions: show(.permissions)
        case .environments: show(.environments)
        case .mcpIntegrations: show(.mcpIntegrations)
        case .mcpServerDetail(let id): show(.mcpServerDetail(serverId: id))
        case .selfTest:
            CapabilitySelfTest.shared.autoRunRequested = true
            show(.selfTest)
        case .macConsole: show(.macConsole)
        }
        deepLink.pendingSettingsTarget = nil
    }

    /// Two columns: a link's first page is a sidebar entry, so select that entry
    /// and push only what lies beyond it (pushing everything stacked the page on
    /// top of whichever entry happened to be selected).
    private func show(_ path: SettingsDestination...) {
        var rest = path[...]
        if measuredWide ?? (hSizeClass == .regular), let first = rest.first,
           let entry = Self.sidebarEntry[first] {
            splitSelection = entry
            rest = rest.dropFirst()
        }
        navPath = NavigationPath(rest)
    }

    /// Pages that are also sidebar entries (titles as in SettingsHomeView). Logs
    /// stay a push: the link can ask for a tab the sidebar page doesn't open on.
    private static let sidebarEntry: [SettingsDestination: String] = [
        .providers: "AI 服务商", .modelGroups: "模型分组", .usage: "Token 用量", .skills: "技能",
        .memory: "记忆", .storage: "存储", .mountedFolders: "挂载外部文件夹", .sharedFolders: "共享文件夹",
        .appearance: "外观", .background: "后台与通知", .about: "关于", .permissions: "权限",
        .environments: "环境变量", .mcpIntegrations: "MCP 集成", .selfTest: "能力自检", .macConsole: "Mac 控制台",
    ]

    /// Build the GitHub Issue URL with a bilingual bug-report template
    /// pre-filled with platform / OS / app / device info. SwiftUI `Link`
    /// hands the URL to UIApplication.shared.open, which routes to Safari.
    static func makeBugReportURL() -> URL? {
        let bundle = Bundle.main
        let appVersion = bundle.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let build = bundle.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        let iosVersion = UIDevice.current.systemVersion
        let device = machineIdentifier()

        let body = """
        ## 📝 Problem Summary

        <!-- Briefly describe the issue you encountered -->

        ## 📱 Basic Information

        | Field | Value |
        |-------|-------|
        | Platform | iOS |
        | OS Version | iOS \(iosVersion) |
        | LeoPhoneAgent Version | \(appVersion) (build \(build)) |
        | Device Model | \(device) |

        ## 🔁 Steps to Reproduce

        1.
        2.
        3.

        ## ❌ Error Details

        ```
        paste error here
        ```

        ## ✅ Expected Behavior

        ## 🗂️ Additional Information

        """

        var components = URLComponents(string: "https://github.com/leoyb1010/LeoPhoneAgent/issues/new")
        components?.queryItems = [
            URLQueryItem(name: "template", value: "bug_report.md"),
            URLQueryItem(name: "title", value: "[Bug] "),
            URLQueryItem(name: "body", value: body),
        ]
        return components?.url
    }

    /// Returns the hardware model identifier, e.g. "iPhone16,2".
    /// `UIDevice.current.model` returns the generic "iPhone" / "iPad" and
    /// isn't useful in a bug report, so we fall back to utsname.
    private static func machineIdentifier() -> String {
        var sys = utsname()
        uname(&sys)
        let id = withUnsafePointer(to: &sys.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(_SYS_NAMELEN)) {
                String(cString: $0)
            }
        }
        return id.isEmpty ? UIDevice.current.model : id
    }
}
