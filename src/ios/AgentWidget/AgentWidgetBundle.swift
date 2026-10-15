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
        if #available(iOSApplicationExtension 16.2, *) {
            AgentLiveActivityWidget()
            // [V-rec] 录音的灵动岛 / 锁屏卡片。
            RecordingLiveActivityWidget()
        }
        // [T-control-center] Control Center / Lock Screen / Action Button.
        if #available(iOSApplicationExtension 18.0, *) {
            NewChatControl()
            VoiceChatControl()
            CameraChatControl()
        }
    }
}
