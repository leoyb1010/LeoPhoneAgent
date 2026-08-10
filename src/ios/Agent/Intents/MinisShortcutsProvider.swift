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
            // [T-local-first] 通用的"干活/办事"归这里:在手机本机后台跑,
            // 不打开 app,结果由 Siri 念回来。要上 Mac 必须明说。
            intent: SendPromptIntent(),
            phrases: [
                "Send a prompt to \(.applicationName)",
                "Ask \(.applicationName) something",
                "Start a \(.applicationName) task",
                "\(.applicationName) get to work",
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
        // [T-collections] 收藏比「列出会话」日常价值高得多——App Shortcut
        // 上限 10 已满,让出名额;ListSessionsIntent 在快捷指令动作列表里仍在。
        AppShortcut(
            intent: CollectLinkIntent(),
            phrases: [
                "Collect with \(.applicationName)",
                "\(.applicationName) collect this",
            ],
            shortTitle: "收藏到 LPA",
            systemImageName: "star.square.on.square"
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
            // [T-local-first] 只保留**明确点名 Mac** 的说法。
            //
            // 之前把"让LPA干活"这种通用说法也挂在这里,结果随口一句
            // 简单任务就被派到远端 Mac 上跑——违反"本机优先、明确指令
            // 才上 Mac"的预期。通用说法现在归 SendPromptIntent(本机后台)。
            intent: CommandMacIntent(),
            phrases: [
                "Command a Mac with \(.applicationName)",
                "Ask \(.applicationName) to command a Mac",
                "\(.applicationName) run this on a Mac",
                "\(.applicationName) use my Mac",
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
