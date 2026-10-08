import Foundation

// The production `AgentMessage` lives in Providers/AgentProvider.swift, which
// also declares the provider protocol and pulls in every provider — too much for
// the UIKit-free logic-test target. ContextSizeMeter / IncrementalContextTrimmer
// only need the value types, so the logic tests compile against this mirror.
// It must stay field-for-field identical to the production declarations: a
// drift makes the shared sources fail to compile here, which is the point.

enum AgentContentPart: @unchecked Sendable {
    case text(String)
    case toolUse(id: String, name: String, input: [String: Any])
    case toolResult(id: String, name: String, content: String, isError: Bool, imageData: Data? = nil, imageMimeType: String? = nil, pageURL: String? = nil, imageLinuxPath: String? = nil)
    case imageData(data: Data, mimeType: String, linuxPath: String? = nil)
}

struct ReasoningEcho: @unchecked Sendable {
    let providerKind: String
    let modelId: String
    let items: [Item]

    enum Item: @unchecked Sendable {
        case openaiReasoning(id: String, encryptedContent: String?, summary: [String])
    }
}

struct AgentMessage: @unchecked Sendable {
    enum Role: String, Sendable { case user, assistant }
    let role: Role
    var parts: [AgentContentPart]
    var isInterrupted: Bool = false
    var reasoningContent: String?
    var reasoningEcho: ReasoningEcho?
    var dbMessageId: String? = nil
}
