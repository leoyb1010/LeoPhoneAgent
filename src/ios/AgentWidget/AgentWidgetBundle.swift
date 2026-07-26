import SwiftUI
import WidgetKit

@main
struct AgentWidgetBundle: WidgetBundle {
    var body: some Widget {
        AgentStatusWidget()
        if #available(iOSApplicationExtension 16.2, *) {
            AgentLiveActivityWidget()
        }
    }
}
