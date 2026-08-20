import Foundation

/// Pure helpers for agent-loop correctness that MinisTests can compile
/// without UIKit or the full chat view-model.
enum AgentChatCorrectness {
    /// Last assistant row, even when a queued user message sits after it.
    static func lastAssistantIndex(isAssistant: [Bool]) -> Int? {
        isAssistant.lastIndex(of: true)
    }

    /// Image attachments must not enter send or enqueue on a text-only model.
    static func shouldBlockImageAttachments(hasImages: Bool, supportsImageInput: Bool) -> Bool {
        hasImages && !supportsImageInput
    }

    /// `read_image` is a vision tool. Register it only when the *active* model
    /// can consume image input — not a leftover default like Haiku.
    static func shouldRegisterReadImage(supportsImageInput: Bool) -> Bool {
        supportsImageInput
    }

    /// Reminder after some attached images were saved to disk but not inlined.
    /// Non-vision models must not be told to call `read_image` or that they saw the files.
    static func omittedImageReminder(inlined: Int, total: Int, supportsImageInput: Bool) -> String? {
        guard total > inlined else { return nil }
        let omitted = total - inlined
        if supportsImageInput {
            return "<system-reminder>Only \(inlined) of \(total) images are inlined above."
                + " The remaining \(omitted) are saved to disk — use read_image to view them."
                + " To stay within the context image limit, process images in batches:"
                + " read a batch, analyze, then summarize your findings before reading the next batch.</system-reminder>"
        }
        return "<system-reminder>Only \(inlined) of \(total) images were kept as on-disk files."
            + " This model cannot view images. Do not claim you inspected, OCR'd, or described"
            + " their pixels. Refer to the saved paths only, or ask the user to switch to a vision model.</system-reminder>"
    }

    /// Drop already-scheduled stream UI writes after Stop, or when the
    /// assistant row was rebuilt under a different identity.
    static func shouldApplyStreamDelta(
        userDidCancel: Bool,
        messageId: UUID?,
        expectedMessageId: UUID?
    ) -> Bool {
        guard !userDidCancel else { return false }
        if let expectedMessageId, let messageId, messageId != expectedMessageId {
            return false
        }
        return true
    }
}
