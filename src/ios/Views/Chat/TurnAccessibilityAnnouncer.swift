import UIKit

// [F2-voiceover] App glue: called once when a chat turn stops processing.

@MainActor
enum TurnAccessibilityAnnouncer {
    private static var gate = TurnAnnouncement.Gate()

    static func turnEnded(vm: AIChatViewModel) {
        guard UIAccessibility.isVoiceOverRunning,
              let message = vm.messages.last(where: { $0.role == .assistant }) else { return }
        let error = message.error ?? vm.errorMessage
        guard gate.shouldAnnounce(messageId: message.id.uuidString, error: error) else { return }
        let reply = message.blocks.filter { $0.kind == .text }.map(\.content).joined(separator: "\n")
        let text = TurnAnnouncement.text(replyText: reply, error: error)
        // Queued, so it does not cut off whatever VoiceOver is reading now.
        let announcement = NSAttributedString(string: text, attributes: [.accessibilitySpeechQueueAnnouncement: true])
        UIAccessibility.post(notification: .announcement, argument: announcement)
    }
}
