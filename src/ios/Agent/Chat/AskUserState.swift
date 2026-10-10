//
//  AskUserState.swift
//  MinisApp
//
//  [T-ask-user] The model can stop and ask the user to decide something: a
//  card in the chat (buttons / a short text field), the turn paused until the
//  answer comes back as the tool result.
//
//  Everything that DECIDES lives here as pure value types (compiled into the
//  logic tests): parsing the call, the per-question state machine, the result
//  text the model gets back, which question is still answerable after a
//  relaunch, and who may ask at all. The live wait, the card, the notification
//  and the resume live in `AIChatViewModel+AskUser.swift` / `AskUserCardView`.
//
//  Product rules:
//  · Only an attended conversation asks. Sub agents (depth rule), quiet /
//    context / automation / Shortcut / Siri / watch turns don't get the tool —
//    nobody is at the card there; they decide and state the assumption.
//  · Full auto doesn't answer for the user: this is not an approval.
//  · Typing a normal message while a question waits answers it (the text is
//    the answer). A message with attachments dismisses the question instead and
//    goes out as the next turn — a picture can't be a card answer.
//  · Stop cancels the question.
//  · The question survives a kill: the assistant step that asked is saved
//    before tools run, so "the saved conversation ends with an unanswered
//    ask_user" IS the persisted waiting state. Answering then writes the result
//    and resumes the same turn.
//

import Foundation

enum AskUserTool {
    static let name = "ask_user"
    static let maxQuestions = 4
    static let maxOptions = 6
    static let maxOptionLength = 60
    static let maxQuestionLength = 300
    static let maxAnswerLength = 2_000
    /// yes_no answers are language-neutral tokens; the card shows 是 / 否.
    static let yesNoTokens = ["yes", "no"]

    enum Kind: String, CaseIterable, Equatable {
        case choice = "single_choice"
        case yesNo = "yes_no"
        case text

        static func parse(_ raw: String) -> Kind? {
            switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
            case "single_choice", "choice", "single", "select", "options": return .choice
            case "yes_no", "yesno", "yes/no", "boolean", "bool", "confirm": return .yesNo
            case "text", "short_text", "free_text", "input", "string": return .text
            default: return nil
            }
        }
    }

    /// Session sources whose turns nobody is watching (see `sessionSource`).
    static let unattendedSources: Set<String> = [
        "context", "quiet", "automation", "shortcut", "siri", "watch",
        "orchestration", "subagent", "cli", "debug",
    ]

    static func isOffered(isSubAgentChild: Bool, blocksSideEffectTools: Bool,
                          sessionSource: String?, isRemoteReadOnly: Bool) -> Bool {
        guard !isSubAgentChild, !blocksSideEffectTools, !isRemoteReadOnly else { return false }
        if let sessionSource, unattendedSources.contains(sessionSource) { return false }
        return true
    }

    enum ComposerRoute: Equatable {
        /// No question waits: the composer behaves as always.
        case none
        /// The typed text answers the waiting question.
        case answer
        /// Attachments can't answer a card: close the question, send normally.
        case dismissThenSend
    }

    static func composerRoute(hasWaitingQuestion: Bool, text: String, hasAttachments: Bool) -> ComposerRoute {
        guard hasWaitingQuestion else { return .none }
        if hasAttachments { return .dismissThenSend }
        return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .none : .answer
    }

    static var definition: AgentToolDefinition {
        AgentToolDefinition(
            name: name,
            description: "Ask the user to decide something, then wait for the answer. The run pauses until the user answers on a card in the chat; the answer comes back as this tool's result. Use ONLY when a wrong guess would be costly or hard to undo (spending money, deleting or sending something, choosing between materially different approaches the user cares about) AND the answer is not something you can decide yourself, infer from the conversation, or look up with your tools. Never ask for low-stakes defaults or to confirm routine steps — decide and state your assumption instead. Never ask for permission the app already handles (sensitive actions have their own approval). Prefer one single_choice question with your recommended option first; at most \(maxQuestions) questions per call (more_questions). Call it alone, not in parallel with other tools.",
            parameters: [
                "question": AgentToolParam(type: .string, description: "The question, short and specific, in the user's language (max \(maxQuestionLength) characters)."),
                "kind": AgentToolParam(type: .string, description: "single_choice: pick one of options. yes_no: yes or no. text: a short free answer. Default: single_choice when options are given, else text.", enumValues: Kind.allCases.map(\.rawValue)),
                "options": AgentToolParam(type: .string, description: "For single_choice: 2–\(maxOptions) options, each at most \(maxOptionLength) characters, as a JSON array of strings, e.g. [\"Staging\", \"Production\"]. Put your recommendation first."),
                "default": AgentToolParam(type: .string, description: "Optional: the option (or answer) you recommend; the card marks it."),
                "allow_other": AgentToolParam(type: .boolean, description: "single_choice only: also let the user type their own answer."),
                "more_questions": AgentToolParam(type: .string, description: "Optional, for up to \(maxQuestions - 1) follow-up questions answered in sequence: a JSON array of objects with the same fields, e.g. [{\"question\": \"…\", \"kind\": \"yes_no\"}]."),
            ],
            required: ["question"],
            propertyOrdering: ["question", "kind", "options", "default", "allow_other", "more_questions"]
        )
    }

    /// System-prompt line, present only when the tool is offered.
    static let promptGuidance = "- ask_user: pauses the run until the user answers a card in the chat. Ask only when a wrong guess is costly or irreversible and the answer is not something you can decide, infer or look up yourself. Never ask to confirm routine steps, for low-stakes preferences, or for permission the app already handles. One clear question with your recommendation first beats several. If the user replies in their own words instead of picking an option, treat that reply as the answer."
}

// MARK: - Request

struct AskUserQuestion: Equatable {
    let prompt: String
    let kind: AskUserTool.Kind
    /// Choice options; `AskUserTool.yesNoTokens` for yes_no; empty for text.
    let options: [String]
    let defaultAnswer: String?
    let allowsOther: Bool
}

enum AskUserParseError: Error, Equatable {
    case missingQuestion, invalidKind, tooFewOptions, tooManyOptions, optionTooLong
    case tooManyQuestions, invalidMoreQuestions

    /// Sent back to the model so it re-issues a valid call.
    var modelMessage: String {
        let fix: String
        switch self {
        case .missingQuestion: fix = "`question` is required and must not be empty."
        case .invalidKind: fix = "`kind` must be single_choice, yes_no or text."
        case .tooFewOptions: fix = "single_choice needs at least 2 distinct options."
        case .tooManyOptions: fix = "At most \(AskUserTool.maxOptions) options."
        case .optionTooLong: fix = "Each option must be at most \(AskUserTool.maxOptionLength) characters — shorten them."
        case .tooManyQuestions: fix = "At most \(AskUserTool.maxQuestions) questions in one call (question + more_questions)."
        case .invalidMoreQuestions: fix = "`more_questions` must be a JSON array of objects with a `question` field."
        }
        return "Error: ask_user was not shown to the user. \(fix) Call ask_user again with valid arguments."
    }
}

struct AskUserRequest: Equatable {
    let questions: [AskUserQuestion]
    var isMultiStep: Bool { questions.count > 1 }

    static func parse(_ args: [String: Any]) -> Result<AskUserRequest, AskUserParseError> {
        var questions: [AskUserQuestion] = []
        switch parseQuestion(args) {
        case .success(let q): questions.append(q)
        case .failure(let e): return .failure(e)
        }
        if let raw = args["more_questions"], !(raw is NSNull) {
            guard let more = objectArray(raw) else {
                // An empty string / "[]" just means "no follow-ups".
                if let s = raw as? String, s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || s.trimmingCharacters(in: .whitespacesAndNewlines) == "[]" {
                    return .success(AskUserRequest(questions: questions))
                }
                return .failure(.invalidMoreQuestions)
            }
            guard more.count + 1 <= AskUserTool.maxQuestions else { return .failure(.tooManyQuestions) }
            for item in more {
                switch parseQuestion(item) {
                case .success(let q): questions.append(q)
                case .failure(let e): return .failure(e)
                }
            }
        }
        return .success(AskUserRequest(questions: questions))
    }

    /// Parse the JSON arguments a tool block saved (`toolInputArgs`).
    static func parse(json: String?) -> AskUserRequest? {
        guard let json, let data = json.data(using: .utf8),
              let args = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              case .success(let request) = parse(args) else { return nil }
        return request
    }

    private static func parseQuestion(_ args: [String: Any]) -> Result<AskUserQuestion, AskUserParseError> {
        let prompt = string(args["question"])?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !prompt.isEmpty else { return .failure(.missingQuestion) }
        let cappedPrompt = String(prompt.prefix(AskUserTool.maxQuestionLength))
        let options = optionList(args["options"])
        let kind: AskUserTool.Kind
        if let rawKind = string(args["kind"]), !rawKind.trimmingCharacters(in: .whitespaces).isEmpty {
            guard let k = AskUserTool.Kind.parse(rawKind) else { return .failure(.invalidKind) }
            kind = k
        } else {
            kind = options.isEmpty ? .text : .choice
        }
        let rawDefault = string(args["default"])?.trimmingCharacters(in: .whitespacesAndNewlines)
        switch kind {
        case .choice:
            guard options.count >= 2 else { return .failure(.tooFewOptions) }
            guard options.count <= AskUserTool.maxOptions else { return .failure(.tooManyOptions) }
            guard options.allSatisfy({ $0.count <= AskUserTool.maxOptionLength }) else { return .failure(.optionTooLong) }
            let def = rawDefault.flatMap { d in options.contains(d) ? d : nil }
            return .success(AskUserQuestion(prompt: cappedPrompt, kind: .choice, options: options,
                                            defaultAnswer: def, allowsOther: bool(args["allow_other"])))
        case .yesNo:
            return .success(AskUserQuestion(prompt: cappedPrompt, kind: .yesNo, options: AskUserTool.yesNoTokens,
                                            defaultAnswer: rawDefault.flatMap(AskUserMachine.normalizeYesNo),
                                            allowsOther: false))
        case .text:
            let def = rawDefault.flatMap { $0.isEmpty ? nil : String($0.prefix(AskUserTool.maxQuestionLength)) }
            return .success(AskUserQuestion(prompt: cappedPrompt, kind: .text, options: [],
                                            defaultAnswer: def, allowsOther: false))
        }
    }

    // MARK: Lenient argument readers (models send arrays, JSON strings, lines)

    private static func string(_ value: Any?) -> String? {
        switch value {
        case let s as String: return s
        case let n as NSNumber: return n.stringValue
        default: return nil
        }
    }

    private static func bool(_ value: Any?) -> Bool {
        switch value {
        case let b as Bool: return b
        case let n as NSNumber: return n.boolValue
        case let s as String: return ["true", "yes", "1"].contains(s.trimmingCharacters(in: .whitespaces).lowercased())
        default: return false
        }
    }

    private static func optionList(_ value: Any?) -> [String] {
        var raw: [String] = []
        switch value {
        case let array as [Any]:
            raw = array.compactMap { string($0) }
        case let s as String:
            let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.hasPrefix("["), let data = trimmed.data(using: .utf8),
               let array = try? JSONSerialization.jsonObject(with: data) as? [Any] {
                raw = array.compactMap { string($0) }
            } else {
                raw = trimmed.components(separatedBy: .newlines)
                if raw.count == 1, trimmed.contains("|") { raw = trimmed.components(separatedBy: "|") }
            }
        default:
            raw = []
        }
        var seen: Set<String> = []
        var out: [String] = []
        for option in raw {
            let t = option.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty, seen.insert(t).inserted else { continue }
            out.append(t)
        }
        return out
    }

    private static func objectArray(_ value: Any) -> [[String: Any]]? {
        if let array = value as? [[String: Any]] { return array }
        if let array = value as? [Any] {
            let objects = array.compactMap { $0 as? [String: Any] }
            return objects.count == array.count ? objects : nil
        }
        if let s = value as? String, let data = s.data(using: .utf8),
           let array = try? JSONSerialization.jsonObject(with: data) as? [Any] {
            let objects = array.compactMap { $0 as? [String: Any] }
            return objects.count == array.count ? objects : nil
        }
        return nil
    }
}

// MARK: - Answers / outcome

struct AskUserAnswerInput: Equatable {
    var value: String
    var isOther: Bool = false
}

struct AskUserAnswer: Codable, Equatable {
    let question: String
    let answer: String
    let isOther: Bool

    enum CodingKeys: String, CodingKey { case question, answer, isOther = "other" }
}

enum AskUserAnswerSource: String, Codable, Equatable {
    case card
    case typedMessage = "typed_message"
    case notification
}

enum AskUserCancelReason: String, Codable, Equatable {
    /// The user tapped Stop.
    case stopped
    /// The user sent a new message (with attachments) instead of answering.
    case superseded
}

enum AskUserOutcome: Equatable {
    case answered([AskUserAnswer], AskUserAnswerSource)
    case cancelled(AskUserCancelReason)
}

// MARK: - State machine

/// One question's life: waiting → answered | cancelled. Exactly one event
/// resolves it; everything after is ignored (a double tap, the notification
/// action after the card, Stop after the answer).
struct AskUserMachine: Equatable {
    enum Phase: Equatable {
        case waiting
        case answered([AskUserAnswer], AskUserAnswerSource)
        case cancelled(AskUserCancelReason)
    }

    enum Event: Equatable {
        case answer([AskUserAnswerInput], source: AskUserAnswerSource)
        case typedMessage(String, hasAttachments: Bool)
        case stop
    }

    let toolUseId: String
    let request: AskUserRequest
    private(set) var phase: Phase = .waiting

    init(toolUseId: String, request: AskUserRequest) {
        self.toolUseId = toolUseId
        self.request = request
    }

    var isWaiting: Bool { phase == .waiting }

    /// Returns the outcome when this event resolved the question; nil when it
    /// was ignored (already resolved, or not a valid answer).
    mutating func handle(_ event: Event) -> AskUserOutcome? {
        guard isWaiting else { return nil }
        let outcome: AskUserOutcome
        switch event {
        case .stop:
            outcome = .cancelled(.stopped)
        case .typedMessage(let text, let hasAttachments):
            if hasAttachments {
                outcome = .cancelled(.superseded)
            } else {
                let trimmed = Self.cap(text)
                guard !trimmed.isEmpty else { return nil }
                let question = request.questions.map(\.prompt).joined(separator: " / ")
                outcome = .answered([AskUserAnswer(question: question, answer: trimmed, isOther: true)], .typedMessage)
            }
        case .answer(let inputs, let source):
            guard let answers = validate(inputs) else { return nil }
            outcome = .answered(answers, source)
        }
        switch outcome {
        case .answered(let a, let s): phase = .answered(a, s)
        case .cancelled(let r): phase = .cancelled(r)
        }
        return outcome
    }

    private func validate(_ inputs: [AskUserAnswerInput]) -> [AskUserAnswer]? {
        guard inputs.count == request.questions.count else { return nil }
        var answers: [AskUserAnswer] = []
        for (question, input) in zip(request.questions, inputs) {
            let value = Self.cap(input.value)
            guard !value.isEmpty else { return nil }
            switch question.kind {
            case .choice:
                if input.isOther {
                    guard question.allowsOther else { return nil }
                    answers.append(AskUserAnswer(question: question.prompt, answer: value, isOther: true))
                } else {
                    guard question.options.contains(value) else { return nil }
                    answers.append(AskUserAnswer(question: question.prompt, answer: value, isOther: false))
                }
            case .yesNo:
                guard let token = Self.normalizeYesNo(value) else { return nil }
                answers.append(AskUserAnswer(question: question.prompt, answer: token, isOther: false))
            case .text:
                answers.append(AskUserAnswer(question: question.prompt, answer: value, isOther: false))
            }
        }
        return answers
    }

    static func normalizeYesNo(_ raw: String) -> String? {
        switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "yes", "y", "true", "是", "是的", "好", "對", "对": return "yes"
        case "no", "n", "false", "否", "不", "不是": return "no"
        default: return nil
        }
    }

    private static func cap(_ text: String) -> String {
        String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(AskUserTool.maxAnswerLength))
    }
}

// MARK: - Result text (what the model reads; also what the card re-reads)

enum AskUserResult {
    private static let open = "<ask_user_result>"
    private static let close = "</ask_user_result>"

    struct Decoded: Codable, Equatable {
        enum Status: String, Codable { case answered, cancelled }
        let status: Status
        var source: AskUserAnswerSource?
        var reason: AskUserCancelReason?
        var answers: [AskUserAnswer]
    }

    static func content(for outcome: AskUserOutcome) -> (text: String, isError: Bool) {
        let payload: Decoded
        let human: String
        let isError: Bool
        switch outcome {
        case .answered(let answers, let source):
            payload = Decoded(status: .answered, source: source, reason: nil, answers: answers)
            let lines = answers.map { "- \($0.question) → \($0.answer)" }.joined(separator: "\n")
            let lead = source == .typedMessage
                ? "The user replied in their own words instead of using the card. Read it as their answer:"
                : "The user answered:"
            human = "\(lead)\n\(lines)\nContinue the task with this answer."
            isError = false
        case .cancelled(let reason):
            payload = Decoded(status: .cancelled, source: nil, reason: reason, answers: [])
            switch reason {
            case .stopped:
                human = "The user stopped the run before answering. Do not assume an answer."
                isError = true
            case .superseded:
                human = "The user sent a new message instead of answering. Treat the question as dismissed and respond to that message."
                isError = false
            }
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]   // "/" stays escaped: an answer can't close the tag
        let json = (try? encoder.encode(payload)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        return ("\(open)\(json)\(close)\n\(human)", isError)
    }

    static func decode(_ text: String) -> Decoded? {
        guard let start = text.range(of: open),
              let end = text.range(of: close, range: start.upperBound..<text.endIndex) else { return nil }
        let json = String(text[start.upperBound..<end.lowerBound])
        return try? JSONDecoder().decode(Decoded.self, from: Data(json.utf8))
    }
}

// MARK: - Relaunch

enum AskUserPending {
    struct Call: Equatable {
        let id: String
        let name: String
    }

    struct ResultPart: Equatable {
        let id: String
        let name: String
        let content: String
        let isError: Bool
    }

    /// Same words the agent loop's orphan pass uses for a call lost with the process.
    static let interruptedPlaceholder = "The app stopped before this tool finished, so its result was lost."
        + " It may already have run: check its effects before running it again."

    /// The question still waiting when the saved conversation ends with the
    /// assistant step that asked it (the app was killed or the run stopped
    /// mid-wait). `resolvedIds`: answered in this process already.
    static func dormantCallId(tailIsAssistant: Bool, tailCalls: [Call], resolvedIds: Set<String>) -> String? {
        guard tailIsAssistant else { return nil }
        return tailCalls.first { $0.name == AskUserTool.name && !resolvedIds.contains($0.id) }?.id
    }

    /// The tool_result message that answers a dormant question: one result per
    /// call of that step, in call order (providers pair them by position).
    static func resumeResults(tailCalls: [Call], askId: String, content: String, isError: Bool) -> [ResultPart] {
        tailCalls.map { call in
            call.id == askId
                ? ResultPart(id: call.id, name: call.name, content: content, isError: isError)
                : ResultPart(id: call.id, name: call.name, content: interruptedPlaceholder, isError: true)
        }
    }
}

// MARK: - Notification actions

enum AskUserNotification {
    static let categoryPrefix = "LEO_ASK_USER_"
    static let optionActionPrefix = "LEO_ASK_OPT_"
    static let textActionId = "LEO_ASK_TEXT"
    static let toolUseKey = "askUserToolUseId"
    static let argsKey = "askUserArgs"

    struct Labels: Equatable {
        let yes: String
        let no: String
        let other: String
        let answer: String
    }

    struct ActionSpec: Equatable {
        let id: String
        let title: String
        let isTextInput: Bool
    }

    static func categoryId(toolUseId: String) -> String {
        categoryPrefix + String(toolUseId.filter { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" }.prefix(64))
    }

    /// Buttons on the notification. Only a single question can be answered
    /// there; a multi-step question opens the chat to the card.
    static func actions(for request: AskUserRequest, labels: Labels) -> [ActionSpec] {
        guard request.questions.count == 1, let q = request.questions.first else { return [] }
        switch q.kind {
        case .choice:
            var specs = q.options.enumerated().map {
                ActionSpec(id: optionActionPrefix + "\($0.offset)", title: $0.element, isTextInput: false)
            }
            if q.allowsOther { specs.append(ActionSpec(id: textActionId, title: labels.other, isTextInput: true)) }
            return specs
        case .yesNo:
            return [ActionSpec(id: optionActionPrefix + "0", title: labels.yes, isTextInput: false),
                    ActionSpec(id: optionActionPrefix + "1", title: labels.no, isTextInput: false)]
        case .text:
            return [ActionSpec(id: textActionId, title: labels.answer, isTextInput: true)]
        }
    }

    /// A notification action → the card's answer input; nil when the action
    /// isn't an answer (tapping the notification body opens the chat).
    static func answerInput(actionId: String, typedText: String?, request: AskUserRequest) -> [AskUserAnswerInput]? {
        guard request.questions.count == 1, let q = request.questions.first else { return nil }
        if actionId.hasPrefix(optionActionPrefix),
           let index = Int(actionId.dropFirst(optionActionPrefix.count)), q.options.indices.contains(index) {
            return [AskUserAnswerInput(value: q.options[index])]
        }
        if actionId == textActionId {
            let text = (typedText ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            return [AskUserAnswerInput(value: text, isOther: q.kind == .choice)]
        }
        return nil
    }
}
