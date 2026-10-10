import SwiftUI

// [F2-tool-toggles] Settings › 工具开关. Each switch removes the tool from what
// the model is offered on the next turn; nothing else changes.

struct ToolTogglesSettingsView: View {
    @AppStorage(AgentToolToggles.browserUseKey) private var browserUse = true
    @AppStorage(SubAgentSettings.enabledKey) private var subAgents = true
    @AppStorage(AgentToolToggles.selfSchedulingKey) private var selfScheduling = true

    var body: some View {
        List {
            Section {
                Toggle(isOn: $browserUse) {
                    Label(String(localized: "浏览器"), systemImage: "globe")
                }
                .accessibilityIdentifier("toolToggles.browser")
                Toggle(isOn: $subAgents) {
                    Label(String(localized: "子代理"), systemImage: "person.2.fill")
                }
                .accessibilityIdentifier("toolToggles.subagents")
                Toggle(isOn: $selfScheduling) {
                    Label(String(localized: "定时跟进"), systemImage: "clock.arrow.circlepath")
                }
                .accessibilityIdentifier("toolToggles.selfScheduling")
            } footer: {
                Text(String(localized: "关掉的工具从下一轮起不再提供给 Agent。浏览器关掉后,shell 里的 minis-browser-use 也一起停用;子代理的角色在 设置 › 子代理 里管理;定时跟进让 Agent 在本会话里安排一次稍后的跟进,到点时 App 被唤醒才会运行,并会发一条提醒通知。"))
            }
        }
        .navigationTitle(String(localized: "工具开关"))
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: browserUse) { _, _ in LeoHaptics.selection() }
        .onChange(of: subAgents) { _, _ in LeoHaptics.selection() }
        .onChange(of: selfScheduling) { _, _ in LeoHaptics.selection() }
    }
}
