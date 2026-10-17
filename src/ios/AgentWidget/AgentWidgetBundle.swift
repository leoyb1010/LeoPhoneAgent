import SwiftUI
import WidgetKit

@main
struct AgentWidgetBundle: WidgetBundle {
    var body: some Widget {
        AgentStatusWidget()
        QuickTasksWidget()
        RecentSessionsWidget()
        BriefingWidget()
        TodayOverviewWidget()
        MemoryWidget()
        ArtifactsWidget()
        // systemExtraLarge only exists on iPadOS, so this simply never offers
        // itself on iPhone.
        AgentConsoleWidget()
        AgentLiveActivityWidget()
        // [V-rec] 录音的灵动岛 / 锁屏卡片。
        RecordingLiveActivityWidget()
        // [T-control-center] Control Center / Lock Screen / Action Button.
        NewChatControl()
        VoiceChatControl()
        CameraChatControl()
    }
}
