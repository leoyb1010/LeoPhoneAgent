import Foundation

private let deepLinkLog = AppLogger(category: "DeepLink")

extension Notification.Name {
    /// Posted by `DeepLinkRouter` when `leophoneagent://open?session=…&path=…` lands
    /// from the LeoPhoneAgent launcher. `userInfo["shortcut"]` is a
    /// `WebAppShortcut` reconstructed from the deep-link params; not
    /// necessarily persisted. (Relocated here from the removed
    /// OpenWebAppIntent.swift — T-ios-remove-open-webapp-shortcut-intent.)
    static let openWebAppDeepLink = Notification.Name("openWebAppDeepLink")
}

/// Parses `leophoneagent://` URLs into navigation actions and dispatches them
/// to the relevant coordinator. Mirrors the Android `DeepLinkHandler`
/// route table at `src/android/.../deeplink/DeepLinkHandler.kt`.
///
/// Supported URLs (all aliases match the Android side):
///   leophoneagent://share
///   leophoneagent://voice
///   leophoneagent://views/alarm
///   leophoneagent://open_terminal[?init_command=…]
///   leophoneagent://collections       (alias: treasury)
///   leophoneagent://open?session=<sid>&path=<scope-prefixed-path>  (LeoPhoneAgent launcher round-trip)
///   leophoneagent://session/<id>      (legacy singular alias)
///   leophoneagent://sessions/<id>     (canonical — matches minis-sessions-cli)
///   leophoneagent://settings
///   leophoneagent://settings/providers[/<instanceId>]
///   leophoneagent://settings/model-groups[/<groupId>]   (alias: model_groups)
///   leophoneagent://settings/usage                      (alias: usage-stats, usage_stats)
///   leophoneagent://settings/skills
///   leophoneagent://settings/memory
///   leophoneagent://settings/storage
///   leophoneagent://settings/mount-external             (alias: mount_external, mounts, mounted-folders, mounted_folders)
///   leophoneagent://settings/shared-folders             (alias: shared_folders)
///   leophoneagent://settings/logs
///   leophoneagent://settings/appearance
///   leophoneagent://settings/background
///   leophoneagent://settings/about
///   leophoneagent://settings/permissions
///   leophoneagent://settings/environments[?create_key=…&create_note=…]  (create_value is ignored)
///   leophoneagent://settings/brain                      (alias: archive)
///   leophoneagent://brain/connect?token=…[&scopes=…]     (资料库令牌,确认后存钥匙串)
///   leophoneagent://settings/rootfs                     (alias: mirrors, rootfs-management, rootfs_management)
///   leophoneagent://shortcut-result?run=<runId>&status=success|error|cancel[&result=…]  (apple-shortcuts run callback)
///
/// Unknown settings paths fall back to the Settings home rather than
/// failing — same as Android — so an LLM-generated link can never
/// strand the user.
/// 改名 LeoBot 后 `lobe://` 是 `leophoneagent://` 的别名。入口处统一改写成规范 scheme,
/// 下游所有 `url.scheme == "leophoneagent"` 判断和生成的链接都不用动,旧快捷指令/链接照常可用。
enum AppURLScheme {
    static let canonical = "leophoneagent"
    /// 改名历史：LeoBot（1.58.0）→ LeoBot（1.59.0）。两个别名都保留，已存的链接和快捷指令照常可用。
    static let aliases: Set<String> = ["lobe", "leobot"]

    static func canonicalize(_ url: URL) -> URL {
        guard let scheme = url.scheme?.lowercased(), aliases.contains(scheme),
              var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        parts.scheme = canonical
        return parts.url ?? url
    }
}

enum DeepLinkRouter {

    @MainActor
    static func handle(url: URL, shareCoordinator: ShareCoordinator) {
        let url = AppURLScheme.canonicalize(url)
        guard url.scheme == "leophoneagent", let host = url.host else {
            deepLinkLog.info("ignored — unsupported scheme=\(url.scheme ?? "nil") hasHost=\(url.host != nil)")
            return
        }
        let coord = DeepLinkCoordinator.shared

        switch host {
        case "voice":
            QuickActionRouter.shared.startVoiceChat()

        // [T-widget-quick-tasks] Home Screen widget entries.
        case "new", "new_chat":
            QuickActionRouter.shared.startNewChat()

        case "quick-task", "quick_task":
            let id = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard !id.isEmpty else {
                deepLinkLog.info("quick-task URL missing id")
                return
            }
            QuickActionRouter.shared.startQuickTask(id: id)

        case "share":
            // Funnel through ShareCoordinator so any leftover
            // fullScreenCover (gallery / WebApp / camera) is dismissed
            // before the share UI tries to surface.
            shareCoordinator.raisePendingShare()

        case "views":
            // Only one view route today; future ones land here.
            if url.path == "/alarm" {
                coord.showAlarmList = true
            }

        case "open_terminal":
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            // 只预填、不执行:去掉换行和其它控制字符,链接里的 %0A 不能替你按回车。
            coord.terminalInitCommand = DeepLinkSafety.terminalPrefill(
                components?.queryItems?.first(where: { $0.name == "init_command" })?.value)
            coord.showTerminal = true

        case "collections", "treasury":
            coord.pendingCollections = true

        // [V-rec] 录音:打开列表 / 正在录的页面 / 导入分享来的音频。链接永远不会替你开始录音。
        case "recordings", "recording":
            RecordingPresenter.handleDeepLink(path: url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")))

        case "open":
            _ = handleWebAppLauncherReturn(url: url)

        case "session", "sessions":
            // `session/<id>` (legacy singular) and `sessions/<id>` (canonical,
            // matches minis-sessions-cli) both route to the same place. Post
            // `.openSessionFromIntent` so we reuse the same code path the
            // App Intents flow uses — which already pops the navigation
            // stack back to root before opening the target session.
            let id = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard !id.isEmpty, !OffloadPermissionManager.isReservedSessionId(id) else {
                deepLinkLog.info("\(host) URL missing or reserved id")
                return
            }
            // An id that isn't a local session (a Mac task's id from a Live
            // Activity, a stale link) would open an empty ghost chat.
            // Buffered as well: a cold launch has no receiver mounted yet.
            Task { @MainActor in
                guard await ChatStore.shared.sessionExists(id: id) else {
                    // [up-home] 灵动岛上 Mac 任务的卡片也是 sessions/<id>(Mac 的会话 id):找到是哪台 Mac
                    // 就打开那个 Mac 会话,以前点了没反应。
                    if let hostId = await macHostId(forSessionId: id) {
                        let target = ["macSessionId": id, "hostId": hostId, "machine": ""]
                        NotificationNavigationStore.shared.setPendingMac(target)
                        NotificationCenter.default.post(name: .openSessionFromIntent, object: nil, userInfo: target)
                        return
                    }
                    deepLinkLog.info("\(host) URL for unknown session — ignored")
                    return
                }
                NotificationNavigationStore.shared.setPending(id)
                NotificationCenter.default.post(
                    name: .openSessionFromIntent,
                    object: nil,
                    userInfo: ["sessionId": id]
                )
            }

        case "settings":
            handleSettings(url: url, coord: coord)

        // [T-brain] leobot://brain/connect?token=… —— 令牌只暂存,到设置 › 资料库确认后才写进钥匙串。
        // 日志不带 URL(令牌在查询串里)。
        case "brain":
            _ = BrainStore.shared.receiveDeepLink(url)
            coord.pendingSettingsTarget = .brain

        // [C1] 快捷指令 x-success / x-error / x-cancel 回调(通常已在 AppURLEntry 处理)。
        case ShortcutCallbackStore.callbackHost:
            ShortcutCallbackStore.shared.handle(url: url)

        default:
            deepLinkLog.info("unknown host '\(host)'")
        }
    }

    /// 这个会话 id 是不是某台 Mac 上的任务:先看内存(进行中列表、灵动岛桥),再挨台问一次
    /// (冷启动时内存是空的)。
    @MainActor
    private static func macHostId(forSessionId id: String) async -> String? {
        let store = GatewayHostStore.shared
        let macs = store.activeHosts.filter { !$0.isAndroidBody }
        if let known = MacLiveSessionsStore.shared.rows.first(where: { $0.session.id == id })?.hostId
            ?? HarnessLiveActivityBridge.shared.hostId(forSessionId: id) {
            return known
        }
        var reached = false
        for host in macs {
            guard let client = store.client(for: host),
                  let sessions = try? await client.harnessSessions() else { continue }
            reached = true
            if sessions.contains(where: { $0.id == id }) { return host.id }
        }
        // 一台都问不到(没网)而只配了一台 Mac:就是它,控制台连上后自己补齐。
        return !reached && macs.count == 1 ? macs[0].id : nil
    }

    // MARK: - Settings sub-router

    @MainActor
    private static func handleSettings(url: URL, coord: DeepLinkCoordinator) {
        let segments = url.path
            .split(separator: "/", omittingEmptySubsequences: true)
            .map { String($0) }
        guard let head = segments.first else {
            // bare `leophoneagent://settings`
            coord.pendingSettingsTarget = .home
            return
        }
        let arg = segments.count > 1 ? segments[1] : nil
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)

        switch head {
        case "providers":
            coord.pendingSettingsTarget = (arg?.isEmpty == false)
                ? .providerDetail(instanceId: arg!)
                : .providers

        case "model-groups", "model_groups":
            coord.pendingSettingsTarget = (arg?.isEmpty == false)
                ? .modelGroupDetail(groupId: arg!)
                : .modelGroups

        case "usage", "usage-stats", "usage_stats":
            coord.pendingSettingsTarget = .usage

        case "skills":
            coord.pendingSettingsTarget = .skills

        // [T-mcp-oauth-deeplink] leophoneagent://settings/mcp-servers/<serverId> —
        // jump straight to the server's edit form (Authorize button). The
        // AUTH_REQUIRED error from leophoneagent-mcp-cli embeds this link. Server
        // names may be percent-encoded; url.path already decodes them.
        case "mcp-servers", "mcp_servers", "mcp":
            coord.pendingSettingsTarget = (arg?.isEmpty == false)
                ? .mcpServerDetail(serverId: arg!)
                : .mcpIntegrations

        case "mail", "mail-accounts", "mailboxes":
            coord.pendingSettingsTarget = .mailAccounts

        case "brain", "archive":
            coord.pendingSettingsTarget = .brain

        case "memory":
            coord.pendingSettingsTarget = .memory

        case "storage":
            coord.pendingSettingsTarget = .storage

        case "mount-external", "mount_external", "mounts",
             "mounted-folders", "mounted_folders":
            coord.pendingSettingsTarget = .mountedFolders

        case "shared-folders", "shared_folders":
            coord.pendingSettingsTarget = .sharedFolders

        case "logs":
            // Optional ?tab=… selects the segmented control on the
            // Logs screen. Currently recognized: "logs" (default),
            // "config-audit". Unknown values fall back to the default.
            coord.pendingLogsTab = components?.queryItems?
                .first(where: { $0.name == "tab" })?.value
            coord.pendingSettingsTarget = .logs

        case "appearance":
            coord.pendingSettingsTarget = .appearance

        case "background":
            // [T-settings-focus-highlight] Optional `?focus=key=true,key2` —
            // parsing + decision logic lives in DeepLinkCoordinator so the
            // router (and every settings screen) stays free of `key=value` rules.
            coord.setFocus(rawQueryValue: components?.queryItems?
                .first(where: { $0.name == "focus" })?.value)
            coord.pendingSettingsTarget = .background

        case "about":
            coord.pendingSettingsTarget = .about

        case "permissions":
            coord.pendingSettingsTarget = .permissions

        case "selftest", "self-test", "self_test":
            // 只导航:自检会真发模型请求、连弹系统授权框,必须由用户在页面上点「开始」。
            // 旧链接里的 `?chat=1` 一律忽略。
            coord.pendingSettingsTarget = .selfTest

        case "mac", "mac-console", "gateway":
            // Mac 控制台:在已连接的 Mac 上开任务、看进度、审批(只导航,不做任何动作)。
            coord.pendingSettingsTarget = .macConsole

        case "environments":
            // `create_key` is the only required param. Missing
            // `create_value`/`create_note` default to empty so a link
            // like `…?create_key=GH_TOKEN&create_value=` (present-but-
            // empty) still opens the prefilled form. Without
            // `create_key`, plain navigation to the env vars list.
            // A link may name the variable, never supply its value: anything
            // in `create_value` is ignored so a link can't plant a credential.
            if let prefill = DeepLinkSafety.envVarPrefill(components?.queryItems ?? []) {
                coord.pendingEnvVarCreate = .init(key: prefill.key, value: "", note: prefill.note)
            }
            coord.pendingSettingsTarget = .environments

        case "rootfs", "rootfs-management", "rootfs_management",
             "mirrors":
            // RootfsManagementView lives in its own sheet on iOS, not
            // inside the SettingsSheet stack. Mirrors live as a section
            // inside it, so /mirrors and /rootfs route to the same
            // destination, matching the Android implementation.
            coord.pendingRootfsManagement = true

        default:
            // Unknown path → land on Settings home instead of failing,
            // so an LLM-generated link still gets the user *somewhere*
            // they can browse from. Mirrors Android.
            deepLinkLog.info("unknown settings path '\(head)' — falling back to Settings home")
            coord.pendingSettingsTarget = .home
        }
    }

    // MARK: - LeoPhoneAgent launcher round-trip

    /// Parses a `leophoneagent://open?session=…&path=…` URL fired by the
    /// LeoPhoneAgent launcher when the pinned home-screen tile is
    /// launched in standalone mode. The `path` query is scope-prefixed
    /// so we can recover `(scope, scopeContext, htmlPath)` without
    /// looking anything up:
    ///
    ///   path=attachments/<rest>      → sessionAttachment(ctx=session)
    ///   path=workspace/<rest>        → sessionWorkspace(ctx=session)
    ///   path=shared:<rest>           → shared
    ///   path=mount:<uuid>/<rest>     → mount(ctx=<uuid>)
    ///
    /// Builds a transient `WebAppShortcut` (no persistence) and posts
    /// `.openWebAppDeepLink` so the SwiftUI root presents the immersive
    /// WebView screen.
    /// 返回 true 表示链接有效、已发出打开网页应用的导航。
    @MainActor @discardableResult
    private static func handleWebAppLauncherReturn(url: URL) -> Bool {
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let session = components?.queryItems?.first(where: { $0.name == "session" })?.value
        guard let rawPath = components?.queryItems?.first(where: { $0.name == "path" })?.value,
              !rawPath.isEmpty else {
            deepLinkLog.warning("leophoneagent://open missing path")
            return false
        }

        // Session ids must be ids and paths must stay inside their scope —
        // `session=../../..` or `path=attachments/../../x` is refused here,
        // before anything is resolved against the sandbox.
        guard let launch = DeepLinkSafety.parseWebAppLaunch(session: session, rawPath: rawPath) else {
            deepLinkLog.warning("leophoneagent://open rejected: invalid session or path")
            return false
        }
        let scope: WebAppPathScope
        switch launch.scope {
        case .sessionAttachment: scope = .sessionAttachment
        case .sessionWorkspace: scope = .sessionWorkspace
        case .shared: scope = .shared
        case .mount: scope = .mount
        }
        let ctx = launch.context
        let htmlPath = launch.htmlPath

        let title = url.fragment.flatMap { $0.removingPercentEncoding } ?? ""
        let shortcut = WebAppShortcut(
            id: UUID().uuidString,
            htmlPath: htmlPath,
            pathScope: scope,
            scopeContext: ctx,
            title: title,
            iconRef: .preset("globe"),
            iconCachePath: nil,
            createdAt: Date(),
            sourceSessionId: (scope == .sessionAttachment || scope == .sessionWorkspace) ? ctx : nil
        )

        deepLinkLog.info("leophoneagent://open scope=\(scope.rawValue) hasContext=\(ctx != nil) pathLength=\(htmlPath.count)")
        let isSessionScope = scope == .sessionAttachment || scope == .sessionWorkspace
        Task { @MainActor in
            // A session scope must name a conversation that exists here.
            if isSessionScope, let sid = ctx {
                guard await ChatStore.shared.sessionExists(id: sid),
                      !OffloadPermissionManager.isReservedSessionId(sid) else {
                    deepLinkLog.info("leophoneagent://open for unknown session — ignored")
                    return
                }
            }
            // Dismiss any leftover fullScreenCover (image gallery, in-chat
            // web preview, camera, etc.) BEFORE attempting to present the
            // WebApp. iOS only allows one fullScreenCover per host view at a
            // time, so a present-while-another-is-up silently no-ops.
            NotificationCenter.default.post(name: .dismissAllImmersivePresentations, object: nil)
            // 350ms covers the standard fullScreenCover dismiss animation
            // (~300ms) with a small safety margin.
            try? await Task.sleep(nanoseconds: 350_000_000)
            NotificationCenter.default.post(
                name: .openWebAppDeepLink,
                object: nil,
                userInfo: ["shortcut": shortcut]
            )
        }
        return true
    }
}
