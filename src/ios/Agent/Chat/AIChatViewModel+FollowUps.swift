import Foundation

private let logger = AppLogger(category: "AIChatVM")

// MARK: - 回复后的追问建议(只用本机模型)

extension AIChatViewModel {
    /// 回复结束(isProcessing true → false)时调用。只在本机模型可用、用户自己在界面里聊、
    /// 回复正常结束时生成;不联网。生成期间如果又开始新一轮,结果直接丢弃。
    func scheduleFollowUpSuggestions() {
        followUpSuggestionTask?.cancel()
        followUpSuggestionTask = nil
        guard let sid = sessionId, Self.activeSessionId == sid,
              let reply = messages.last, reply.role == .assistant else { return }
        let replyText = reply.blocks.filter { $0.kind == .text }.map(\.content).joined(separator: "\n")
        guard FollowUpSuggestionPolicy.shouldGenerate(
            enabled: FollowUpSuggestionPolicy.isEnabled(),
            onDeviceReady: LocalBrain.shared.isReady,
            sessionSource: sessionSource,
            isSubAgent: isSubAgentChild,
            isProgrammaticSend: subAgentState.isProgrammaticSend,
            userCancelled: userDidCancel,
            replyText: replyText,
            replyHasError: reply.error != nil
        ) else { return }
        let lastUser = messages.last(where: { $0.role == .user }).map { ReplyNextStep.cleanPrompt($0.content) } ?? ""
        let messageId = reply.id
        let started = Date()
        followUpSuggestionTask = Task { [weak self] in
            let suggestions = await LocalBrain.shared.suggestFollowUps(lastUser: lastUser, reply: replyText)
            guard !Task.isCancelled, let self, !self.isProcessing,
                  self.messages.last?.id == messageId else { return }
            logger.info("[FollowUp] on-device suggestions count=\(suggestions.count) ms=\(Int(Date().timeIntervalSince(started) * 1000))")
            self.followUpSuggestionsMessageId = suggestions.isEmpty ? nil : messageId
            self.followUpSuggestions = suggestions
        }
    }

    func clearFollowUpSuggestions() {
        followUpSuggestionTask?.cancel()
        followUpSuggestionTask = nil
        guard !followUpSuggestions.isEmpty || followUpSuggestionsMessageId != nil else { return }
        followUpSuggestions = []
        followUpSuggestionsMessageId = nil
    }

    /// 界面上真正该显示的建议:流式中、回复已不是最后一条、或用户已经在输入时都不显示。
    var visibleFollowUpSuggestions: [String] {
        guard !isProcessing, !followUpSuggestions.isEmpty,
              let id = followUpSuggestionsMessageId, messages.last?.id == id,
              inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        return followUpSuggestions
    }

    /// 点一条建议:填进输入框,不自动发送。
    func applyFollowUpSuggestion(_ text: String) {
        inputText = text
        clearFollowUpSuggestions()
    }
}
