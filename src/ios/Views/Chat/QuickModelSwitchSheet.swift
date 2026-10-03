import SwiftUI

/// Same native selector everywhere; draft choice never creates a conversation.
struct QuickModelSwitchSheet: View {
    let sessionId: String?
    let ensureSessionId: (() async -> String)?
    var pickedKey: String? = nil
    var onPick: ((String) -> Void)? = nil

    var body: some View {
        NavigationStack {
            SessionModelPicker(sessionId: sessionId, ensureSessionId: ensureSessionId,
                               draftChoice: pickedKey, onPick: onPick)
        }
    }
}
