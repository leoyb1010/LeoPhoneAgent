import Foundation

/// Read only the message committed by this run. Looking up the last message
/// in a session can return a later turn when an observer resumes after sleep.
enum AgentRunResultReader {
    @MainActor
    static func message(sessionId: String, runId: String) async -> RawMessage? {
        guard let receipt = AgentActivityLog.shared.runState(runId: runId),
              receipt.sessionId == sessionId, receipt.phase == .completed,
              let messageId = receipt.resultMessageId,
              let message = await ChatStore.shared.loadSingleMessage(id: messageId),
              message.sessionId == sessionId, message.role == .assistant else { return nil }
        return message
    }

    @MainActor
    static func text(sessionId: String, runId: String) async -> String {
        guard let message = await message(sessionId: sessionId, runId: runId) else { return "" }
        return message.parts.compactMap { part -> String? in
            if case .text(let text) = part { return text }
            return nil
        }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
