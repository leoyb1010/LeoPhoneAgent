import AppIntents

/// Registers app shortcuts so they appear in Shortcuts with zero user setup.
///
/// Phrase localization: the English phrases below are the KEYS. Localized
/// Siri trigger phrases (zh-Hans/zh-Hant, e.g. "问问LeoPhoneAgent") live in
/// `src/ios/<locale>.lproj/AppShortcuts.strings` — the table name
/// AppShortcuts is what the AppIntents runtime looks up. Legacy .strings
/// (not .xcstrings) because the deployment target is iOS 16 and Xcode
/// rejects AppShortcuts.xcstrings below iOS 17. Add new phrases here AND
/// to every AppShortcuts.strings; keys must match exactly with
/// `\(.applicationName)` spelled `${applicationName}` in the tables.
@available(iOS 17.0, *)
struct MinisShortcutsProvider: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        // Siri-facing "ask LeoPhoneAgent" entry — opens the app and lands in the
        // conversation. Note: iOS App Intents cannot capture free-form trailing
        // text from the phrase itself (e.g. "…the weather today"); Siri collects
        // the prompt via the parameter's requestValueDialog follow-up. The
        // phrases below are the invocation triggers, not the prompt.
        AppShortcut(
            intent: AskMinisIntent(),
            phrases: [
                "Hey \(.applicationName)",
                "Ask \(.applicationName)",
                "Ask \(.applicationName) a question",
                "Talk to \(.applicationName)",
                "New \(.applicationName) chat",
            ],
            shortTitle: "Ask LeoPhoneAgent",
            systemImageName: "sparkles"
        )
        AppShortcut(
            intent: RunQuickTaskIntent(),
            phrases: [
                "Run a \(.applicationName) quick task",
                "Use \(.applicationName) quick task",
            ],
            shortTitle: "Quick Task",
            systemImageName: "bolt.fill"
        )
        AppShortcut(
            intent: SendPromptIntent(),
            phrases: [
                "Send a prompt to \(.applicationName)",
                "Ask \(.applicationName) something",
                "Start a \(.applicationName) task",
            ],
            shortTitle: "Send Prompt",
            systemImageName: "message.fill"
        )
        AppShortcut(
            intent: GetSessionStatusIntent(),
            phrases: [
                "Get \(.applicationName) session status",
                "Check \(.applicationName) task",
            ],
            shortTitle: "Session Status",
            systemImageName: "info.circle.fill"
        )
        AppShortcut(
            intent: ListSessionsIntent(),
            phrases: [
                "List \(.applicationName) sessions",
                "Show \(.applicationName) chats",
            ],
            shortTitle: "List Sessions",
            systemImageName: "list.bullet"
        )
        AppShortcut(
            intent: FollowUpSessionIntent(),
            phrases: [
                "Follow up a \(.applicationName) session",
                "Continue a \(.applicationName) session",
            ],
            shortTitle: "Follow Up",
            systemImageName: "arrowshape.turn.up.left.fill"
        )
        // RetryRunIntent is not registered here because its
        // @IntentParameterDependency causes an iOS 16 launch crash
        // (Swift metadata resolution). It remains available in Shortcuts
        // via the "All Actions" list.
        // [T-siri-fleet] OpenSessionIntent 不再占 App Shortcut 名额(上限 10,
        // 让给 Mac 舰队四件套;它在快捷指令 App 的动作列表里仍然可用)。
        AppShortcut(
            intent: CommandMacIntent(),
            phrases: [
                "Command a Mac with \(.applicationName)",
                "Ask \(.applicationName) to command a Mac",
                "\(.applicationName) get to work",
            ],
            shortTitle: "指挥一台 Mac",
            systemImageName: "desktopcomputer"
        )
        AppShortcut(
            intent: MacFleetStatusIntent(),
            phrases: [
                "\(.applicationName) fleet report",
                "Ask \(.applicationName) for a report",
                "Check \(.applicationName) Macs",
            ],
            shortTitle: "Mac 任务汇报",
            systemImageName: "waveform.and.person.filled"
        )
        AppShortcut(
            intent: ApprovePendingMacIntent(),
            phrases: [
                "Approve with \(.applicationName)",
                "\(.applicationName) approve",
            ],
            shortTitle: "批准待审批",
            systemImageName: "checkmark.seal.fill"
        )
        AppShortcut(
            intent: StopMacTaskIntent(),
            phrases: [
                "Stop a Mac task with \(.applicationName)",
                "\(.applicationName) stop",
            ],
            shortTitle: "停止 Mac 任务",
            systemImageName: "stop.circle.fill"
        )
        // [T-ios-remove-open-webapp-shortcut-intent] OpenWebAppIntent removed —
        // the Home-Screen WebApp tile path was replaced by another mechanism,
        // so the Shortcuts/AppIntents action is no longer registered.
    }
}
