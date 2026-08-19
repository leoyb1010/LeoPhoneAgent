//
//  AppearanceSettingsView.swift
//  MinisApp
//
//  [T-slim-contentview] 从 5500 行的 ContentView.swift 拆出(原样搬迁,
//  跨文件可见性 private → internal)。
//

import SwiftUI
import WidgetKit


// MARK: - Appearance Settings

struct AppearanceSettingsView: View {
    @AppStorage("appearanceMode") private var appearanceMode: Int = 0
    @AppStorage("appIconMode") private var appIconMode: Int = 0
    @AppStorage("appLanguage") private var appLanguage: String = ""
    @AppStorage("launchScreen") private var launchScreen: Int = 0  // 0=Auto, 1=Last Session, 2=New Chat, 3=Home
    @AppStorage("toolPreviewEnabled") private var toolPreviewEnabled: Bool = true
    /// 0 = Return inserts a newline (default), 1 = Return sends the message.
    @AppStorage("returnKeyBehavior") private var returnKeyBehavior: Int = 0
    /// When true, holds `UIApplication.isIdleTimerDisabled` while any session
    /// is running a task. See `KeepScreenAwakeController`.
    @AppStorage("keepScreenAwakeDuringTasks") private var keepScreenAwakeDuringTasks: Bool = false
    /// [T-keyboard-auto-pop default flip] When true, the input field becomes
    /// the first responder ~1.5 s after the model finishes a reply (the
    /// historical behavior). ON by default — most users want the composer
    /// ready for a follow-up immediately. Existing users who explicitly
    /// toggled OFF keep their stored false; users who never opened the
    /// toggle get the new ON default via @AppStorage's fallback.
    @AppStorage("chat.autoFocusAfterReply") private var autoFocusAfterReply: Bool = true
    /// [T-thinking-auto-expand-toggle] When true (default, historical
    /// behavior) a NEW streaming thinking block auto-expands while reasoning
    /// streams. When false it stays collapsed until tapped. Read at
    /// block-mount time in ThinkingBlockView.
    @AppStorage("chat.autoExpandThinking") private var autoExpandThinking: Bool = true
    @AppStorage("leo.sessionListDensity") private var sessionListDensityRaw: Int = LeoSessionListDensity.standard.rawValue
    @AppStorage(LeoHaptics.enabledDefaultsKey) private var hapticsEnabled: Bool = true
    /// [T-reply-toolbar] Payload of the one-tap copy button under replies.
    @AppStorage("leo.copyFormat") private var copyFormat: String = "plain"
    /// [T-tldr-experiment] One-line summary above very long replies. OFF by
    /// default -- graduate only if it proves non-intrusive.
    @AppStorage("leo.tldrEnabled") private var tldrEnabled: Bool = false
    @AppStorage("autoCompactOnThreshold") private var autoCompactOnThreshold: Bool = false
    @ObservedObject private var fontSettings = FontSettings.shared

    private let iconOptions: [AppIconOption] = [
        AppIconOption(id: 0, title: "Automatic", subtitle: "Follows system", iconName: nil, imageName: "AlternateIcons/AppIcon-Light"),
        AppIconOption(id: 1, title: "Light", subtitle: "Always light", iconName: "AppIcon-Light", imageName: "AlternateIcons/AppIcon-Light"),
        AppIconOption(id: 2, title: "Dark", subtitle: "Always dark", iconName: "AppIcon-Dark", imageName: "AlternateIcons/AppIcon-Dark"),
        AppIconOption(id: 3, title: "Light (Legacy)", subtitle: "Classic light icon", iconName: "AppIcon-LegacyLight", imageName: "AlternateIcons/AppIcon-LegacyLight"),
        AppIconOption(id: 4, title: "Dark (Legacy)", subtitle: "Classic dark icon", iconName: "AppIcon-LegacyDark", imageName: "AlternateIcons/AppIcon-LegacyDark"),
    ]

    var body: some View {
        List {
            Section {
                Picker("Theme", selection: $appearanceMode) {
                    Text("System").tag(0)
                    Text("Light").tag(1)
                    Text("Dark").tag(2)
                }
                .pickerStyle(.segmented)
            } header: {
                Text("Theme")
            } footer: {
                Text("Override the system appearance for this app.")
            }
            .onChange(of: appearanceMode) { _ in
                // [T-multiwindow-theme] Every window, not `.first` of an
                // unordered Set — with two iPad windows only a random one used
                // to change appearance.
                for case let windowScene as UIWindowScene in UIApplication.shared.connectedScenes {
                    for window in windowScene.windows {
                        window.overrideUserInterfaceStyle = appearanceMode == 1 ? .light : appearanceMode == 2 ? .dark : .unspecified
                    }
                }
            }

            Section {
                Picker("Launch Session", selection: $launchScreen) {
                    Text("Auto").tag(0)
                    Text("Last Session").tag(1)
                    Text("New Chat").tag(2)
                    Text("Home").tag(3)
                }
            } header: {
                Text("Launch Session")
            } footer: {
                Text("Choose what to show when the app starts. \"Auto\" opens a new chat if the last session is older than 15 minutes.")
            }

            Section {
                Picker("Session List Density", selection: $sessionListDensityRaw) {
                    ForEach(LeoSessionListDensity.allCases, id: \.rawValue) { density in
                        Text(density.title).tag(density.rawValue)
                    }
                }
                .pickerStyle(.segmented)
            } header: {
                Text("Home")
            } footer: {
                Text("Adjust session spacing without changing text size or accessibility settings.")
            }

            Section {
                Picker(String(localized: "Return Key"), selection: $returnKeyBehavior) {
                    Text(String(localized: "Newline")).tag(0)
                    Text(String(localized: "Send")).tag(1)
                }
                .pickerStyle(.segmented)
            } header: {
                Text("Return Key")
            } footer: {
                Text("Choose whether the Return key in the chat input inserts a newline or sends the message. Hardware Shift+Return always inserts a newline.")
            }

            Section {
                Picker(String(localized: "Copy Format"), selection: $copyFormat) {
                    Text(String(localized: "Plain Text")).tag("plain")
                    Text(String(localized: "Markdown")).tag("markdown")
                }
                .pickerStyle(.segmented)
            } header: {
                Text("Copy Format")
            } footer: {
                Text("What the one-tap copy button under a reply puts on the clipboard. The long-press menu always offers both.")
            }

            Section {
                Toggle(String(localized: "Long Reply Summary"), isOn: $tldrEnabled)
            } header: {
                Text("Long Reply Summary")
            } footer: {
                Text("Experimental: show a one-line TL;DR above very long replies.")
            }

            Section {
                Toggle("到阈值自动压缩", isOn: $autoCompactOnThreshold)
            } header: {
                Text("压缩")
            } footer: {
                Text("关掉后不再自动压。对话菜单里仍可「现在压缩」；压完会留下一条可见说明。")
            }

            Section {
                Toggle(String(localized: "Keep Screen Awake"), isOn: $keepScreenAwakeDuringTasks)
            } header: {
                Text("Keep Screen Awake")
            } footer: {
                Text("Prevent the screen from sleeping while any session is running a task. May increase battery drain.")
            }

            Section {
                Toggle(String(localized: "Auto-Focus Input After Reply"), isOn: $autoFocusAfterReply)
            } header: {
                Text("Auto-Focus Input After Reply")
            } footer: {
                Text("When on, the keyboard pops up automatically after the model finishes replying so the input is ready for a follow-up. On by default; turn off if you prefer to read the response without an unexpected keyboard.")
            }

            Section {
                Toggle("Haptic Feedback", isOn: $hapticsEnabled)
            } header: {
                Text("Interaction")
            } footer: {
                Text("Controls LeoPhoneAgent action feedback. System alerts and keyboard haptics are unchanged.")
            }

            Section {
                Toggle(String(localized: "Tool Preview Window"), isOn: $toolPreviewEnabled)
            } header: {
                Text("Tool Status Bar")
            } footer: {
                Text("Show a live preview thumbnail alongside the tool status bar during agent execution.")
            }

            // [T-thinking-auto-expand-toggle] Whether a NEW streaming thinking
            // block opens expanded (historical behavior, default) or stays
            // collapsed. Only affects the streaming auto-expand; manual taps
            // always work either way.
            Section {
                Toggle(String(localized: "Expand Thinking While Streaming"), isOn: $autoExpandThinking)
            } header: {
                Text("Deep Thinking")
            } footer: {
                Text("When on, a new thinking block expands automatically while the model is reasoning and collapses when it finishes. When off, thinking blocks stay collapsed — tap one to read it.")
            }

            Section {
                FontScaleRow(
                    label: "Chat Input",
                    level: $fontSettings.chatInputScale
                )
                FontScaleRow(
                    label: "Message Text",
                    level: $fontSettings.messageBaseScale
                )
                FontScaleRow(
                    label: "App Base",
                    level: $fontSettings.appBaseScale
                )
                if fontSettings.isModified {
                    Button("Reset to Defaults") {
                        fontSettings.resetToDefaults()
                    }
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .center)
                }
            } header: {
                Text("Font Size")
            } footer: {
                Text("Scale fonts for chat input, message content, and general app text. Changes apply immediately.")
            }

            if UIApplication.shared.supportsAlternateIcons {
                Section {
                    ForEach(iconOptions) { option in
                        Button {
                            guard appIconMode != option.id else { return }
                            appIconMode = option.id
                            UIApplication.shared.setAlternateIconName(option.iconName) { error in
                                if let error = error {
                                    print("[AppIcon] Failed to set icon: \(error.localizedDescription)")
                                }
                            }
                        } label: {
                            HStack(spacing: 14) {
                                if let img = UIImage(named: option.imageName) {
                                    Image(uiImage: img)
                                        .resizable()
                                        .aspectRatio(contentMode: .fill)
                                        .frame(width: 60, height: 60)
                                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                                        .overlay(
                                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                                .stroke(Color.primary.opacity(0.15), lineWidth: 0.5)
                                        )
                                }
                                VStack(alignment: .leading, spacing: 2) {
                                    // `option.title` / `option.subtitle` are fixed English
                                    // keys ("Automatic", "Light", "Always light", etc.).
                                    // Wrap in LocalizedStringKey so the catalog lookup kicks
                                    // in — Text(String) would render them verbatim.
                                    Text(LocalizedStringKey(option.title))
                                        .foregroundStyle(.primary)
                                    Text(LocalizedStringKey(option.subtitle))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if appIconMode == option.id {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(.blue)
                                        .font(.title3)
                                }
                            }
                            .padding(.vertical, 4)
                        }
                    }
                } header: {
                    Text("App Icon")
                } footer: {
                    Text("\"Automatic\" uses the system icon which adapts to Dark Mode on iOS 18+.")
                }
            }

            Section {
                ForEach(supportedLanguages) { lang in
                    Button {
                        // Persist a reopen-hint BEFORE flipping appLanguage —
                        // the @AppStorage write triggers the root
                        // `.id(appLanguage)` rebuild in MinisApp.swift, which
                        // drops the entire view tree including the Settings
                        // sheet. ContentView/SettingsSheet read this flag on
                        // re-mount and reopen the sheet + push back to the
                        // Appearance page so the user lands where they were
                        // with all strings rendered in the new language.
                        UserDefaults.standard.set("appearance", forKey: "pendingSettingsReopen")
                        appLanguage = lang.id
                        Bundle.setLanguage(lang.id.isEmpty ? nil : lang.id)
                        // [T-widget-localization] Widgets live in another
                        // process; hand them the new language and rebuild.
                        LeoWidgetLanguage.save(lang.id)
                        WidgetCenter.shared.reloadAllTimelines()
                    } label: {
                        HStack(spacing: 12) {
                            if !lang.flag.isEmpty {
                                Text(lang.flag).font(.title2)
                            } else {
                                Image(systemName: "globe")
                                    .font(.title3)
                                    .foregroundStyle(.secondary)
                                    .frame(width: 28)
                            }
                            Text(lang.name)
                                .foregroundStyle(.primary)
                            Spacer()
                            if appLanguage == lang.id {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(.blue)
                                    .fontWeight(.semibold)
                            }
                        }
                    }
                }
            } header: {
                Text("Language")
            } footer: {
                Text("Override the display language for this app. \"System\" follows your device language.")
            }
        }
        .navigationTitle("Appearance")
        .navigationBarTitleDisplayMode(.inline)
        .background(InteractivePopGestureDisabler())
    }
}
