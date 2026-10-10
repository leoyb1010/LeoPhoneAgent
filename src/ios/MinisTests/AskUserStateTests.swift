import XCTest

/// [T-ask-user] The ask-user card's invariants, pinned on the pure rules in
/// `AskUserState.swift`. The live wait (continuation, notification, card) needs
/// the app; everything it decides — what counts as an answer, when a question
/// is cancelled, which question is still answerable after a relaunch, who may
/// call the tool — is decided here.
final class AskUserStateTests: XCTestCase {

    private func choiceRequest(allowOther: Bool = false) -> AskUserRequest {
        guard case .success(let request) = AskUserRequest.parse([
            "question": "部署到哪个环境？",
            "kind": "single_choice",
            "options": "[\"预发\", \"生产\"]",
            "default": "预发",
            "allow_other": allowOther,
        ]) else { XCTFail("parse failed"); fatalError() }
        return request
    }

    // MARK: - Parsing

    func testParse_singleChoiceFromJSONArrayString() {
        let request = choiceRequest()
        XCTAssertEqual(request.questions.count, 1)
        XCTAssertEqual(request.questions[0].kind, .choice)
        XCTAssertEqual(request.questions[0].options, ["预发", "生产"])
        XCTAssertEqual(request.questions[0].defaultAnswer, "预发")
        XCTAssertFalse(request.isMultiStep)
    }

    func testParse_acceptsArrayAndNewlineOptionsAndInfersKind() {
        guard case .success(let a) = AskUserRequest.parse(["question": "选一个", "options": ["甲", "乙", "甲", " "]]) else {
            return XCTFail("array options")
        }
        XCTAssertEqual(a.questions[0].kind, .choice, "options without kind → single choice")
        XCTAssertEqual(a.questions[0].options, ["甲", "乙"], "trimmed, deduplicated, blanks dropped")
        guard case .success(let b) = AskUserRequest.parse(["question": "选一个", "options": "红\n绿\n蓝"]) else {
            return XCTFail("newline options")
        }
        XCTAssertEqual(b.questions[0].options, ["红", "绿", "蓝"])
        guard case .success(let c) = AskUserRequest.parse(["question": "叫什么名字？"]) else { return XCTFail("text") }
        XCTAssertEqual(c.questions[0].kind, .text, "no options → short text")
    }

    func testParse_rejectsTooManyOrLongOptionsAndMissingQuestion() {
        let seven = (1...7).map { "选项\($0)" }
        XCTAssertEqual(AskUserRequest.parse(["question": "q", "options": seven]), .failure(.tooManyOptions))
        let long = String(repeating: "长", count: AskUserTool.maxOptionLength + 1)
        XCTAssertEqual(AskUserRequest.parse(["question": "q", "options": ["a", long]]), .failure(.optionTooLong))
        XCTAssertEqual(AskUserRequest.parse(["question": "q", "kind": "single_choice", "options": ["只有一个"]]),
                       .failure(.tooFewOptions))
        XCTAssertEqual(AskUserRequest.parse(["question": "   "]), .failure(.missingQuestion))
        XCTAssertEqual(AskUserRequest.parse(["question": "q", "kind": "slider"]), .failure(.invalidKind))
    }

    func testParse_multiStepCapsAtFourQuestions() {
        let three = "[{\"question\":\"b\",\"kind\":\"yes_no\"},{\"question\":\"c\"},{\"question\":\"d\",\"options\":[\"x\",\"y\"]}]"
        guard case .success(let ok) = AskUserRequest.parse(["question": "a", "options": ["1", "2"], "more_questions": three]) else {
            return XCTFail("4 questions must parse")
        }
        XCTAssertEqual(ok.questions.map(\.prompt), ["a", "b", "c", "d"])
        XCTAssertTrue(ok.isMultiStep)
        XCTAssertEqual(ok.questions[1].options, AskUserTool.yesNoTokens)
        let four = "[{\"question\":\"b\"},{\"question\":\"c\"},{\"question\":\"d\"},{\"question\":\"e\"}]"
        XCTAssertEqual(AskUserRequest.parse(["question": "a", "more_questions": four]), .failure(.tooManyQuestions))
    }

    func testParse_yesNoNormalizesDefaultAndIgnoresOptions() {
        guard case .success(let r) = AskUserRequest.parse(["question": "要删吗？", "kind": "yes_no",
                                                            "options": ["随便"], "default": "否"]) else {
            return XCTFail("yes_no")
        }
        XCTAssertEqual(r.questions[0].options, ["yes", "no"])
        XCTAssertEqual(r.questions[0].defaultAnswer, "no")
        XCTAssertFalse(r.questions[0].allowsOther)
    }

    func testParse_questionIsCappedNotRejected() {
        let long = String(repeating: "问", count: AskUserTool.maxQuestionLength + 50)
        guard case .success(let r) = AskUserRequest.parse(["question": long]) else { return XCTFail("long question") }
        XCTAssertLessThanOrEqual(r.questions[0].prompt.count, AskUserTool.maxQuestionLength)
    }

    // MARK: - State machine: pause / resume

    func testPauseResume_answerResolvesWithCardSource() {
        var machine = AskUserMachine(toolUseId: "tu1", request: choiceRequest())
        XCTAssertEqual(machine.phase, .waiting, "a new question waits — the turn is paused")
        let outcome = machine.handle(.answer([.init(value: "生产")], source: .card))
        XCTAssertEqual(outcome, .answered([AskUserAnswer(question: "部署到哪个环境？", answer: "生产", isOther: false)], .card))
        XCTAssertFalse(machine.isWaiting, "answered → the same turn resumes")
        let result = AskUserResult.content(for: outcome!)
        XCTAssertFalse(result.isError)
        XCTAssertTrue(result.text.contains("生产"))
    }

    func testDuplicateAnswersAreIgnored() {
        var machine = AskUserMachine(toolUseId: "tu1", request: choiceRequest())
        XCTAssertNotNil(machine.handle(.answer([.init(value: "预发")], source: .card)))
        XCTAssertNil(machine.handle(.answer([.init(value: "生产")], source: .notification)),
                     "a second tap / the notification after the card must not resolve again")
        XCTAssertNil(machine.handle(.stop), "Stop after the answer changes nothing")
        XCTAssertEqual(machine.phase, .answered([AskUserAnswer(question: "部署到哪个环境？", answer: "预发", isOther: false)], .card))
    }

    func testAnswerValidation_unknownOptionNeedsOther() {
        var strict = AskUserMachine(toolUseId: "a", request: choiceRequest(allowOther: false))
        XCTAssertNil(strict.handle(.answer([.init(value: "测试环境")], source: .card)), "not an option")
        XCTAssertNil(strict.handle(.answer([.init(value: "测试环境", isOther: true)], source: .card)),
                     "other is not allowed on this question")
        XCTAssertNil(strict.handle(.answer([], source: .card)), "wrong count")
        XCTAssertTrue(strict.isWaiting, "invalid input keeps the question open")
        var open = AskUserMachine(toolUseId: "b", request: choiceRequest(allowOther: true))
        let outcome = open.handle(.answer([.init(value: "  测试环境 ", isOther: true)], source: .card))
        XCTAssertEqual(outcome, .answered([AskUserAnswer(question: "部署到哪个环境？", answer: "测试环境", isOther: true)], .card))
    }

    func testMultiStepNeedsEveryAnswer() {
        guard case .success(let r) = AskUserRequest.parse([
            "question": "名字？", "more_questions": "[{\"question\":\"公开吗？\",\"kind\":\"yes_no\"}]",
        ]) else { return XCTFail("parse") }
        var machine = AskUserMachine(toolUseId: "m", request: r)
        XCTAssertNil(machine.handle(.answer([.init(value: "Leo")], source: .card)), "one of two answers is not an answer")
        XCTAssertNil(machine.handle(.answer([.init(value: "Leo"), .init(value: "也许")], source: .card)),
                     "yes/no only takes yes or no")
        XCTAssertNotNil(machine.handle(.answer([.init(value: "Leo"), .init(value: "yes")], source: .card)))
    }

    // MARK: - Stop

    func testCancelOnStop() {
        var machine = AskUserMachine(toolUseId: "tu1", request: choiceRequest())
        let outcome = machine.handle(.stop)
        XCTAssertEqual(outcome, .cancelled(.stopped))
        XCTAssertNil(machine.handle(.answer([.init(value: "生产")], source: .card)), "a cancelled question can't be answered")
        let result = AskUserResult.content(for: .cancelled(.stopped))
        XCTAssertTrue(result.isError)
        XCTAssertEqual(AskUserResult.decode(result.text)?.reason, .stopped)
    }

    // MARK: - Typed message path

    func testTypedMessageBecomesTheAnswer() {
        var machine = AskUserMachine(toolUseId: "tu1", request: choiceRequest())
        let outcome = machine.handle(.typedMessage("先发预发，明天再上生产", hasAttachments: false))
        XCTAssertEqual(outcome, .answered([AskUserAnswer(question: "部署到哪个环境？",
                                                          answer: "先发预发，明天再上生产", isOther: true)], .typedMessage))
        XCTAssertEqual(AskUserTool.composerRoute(hasWaitingQuestion: true, text: "好", hasAttachments: false), .answer)
        XCTAssertEqual(AskUserTool.composerRoute(hasWaitingQuestion: false, text: "好", hasAttachments: false), .none)
    }

    func testTypedMessageWithAttachmentsDismissesTheQuestion() {
        var machine = AskUserMachine(toolUseId: "tu1", request: choiceRequest())
        XCTAssertNil(machine.handle(.typedMessage("   ", hasAttachments: false)), "empty text is not an answer")
        XCTAssertEqual(machine.handle(.typedMessage("看这张图", hasAttachments: true)), .cancelled(.superseded))
        XCTAssertEqual(AskUserTool.composerRoute(hasWaitingQuestion: true, text: "看图", hasAttachments: true),
                       .dismissThenSend)
        XCTAssertFalse(AskUserResult.content(for: .cancelled(.superseded)).isError,
                       "the user moved on — not a tool failure")
    }

    // MARK: - Relaunch

    func testAnswerAfterRelaunch_dormantQuestionIsFoundAndResumeResultsArePaired() {
        let calls = [AskUserPending.Call(id: "shell1", name: "shell_execute"),
                     AskUserPending.Call(id: "ask1", name: AskUserTool.name)]
        XCTAssertEqual(AskUserPending.dormantCallId(tailIsAssistant: true, tailCalls: calls, resolvedIds: []), "ask1",
                       "app killed while waiting: the saved tail is the assistant step that asked")
        XCTAssertNil(AskUserPending.dormantCallId(tailIsAssistant: false, tailCalls: calls, resolvedIds: []),
                     "the turn already moved on (a result or a new message follows)")
        XCTAssertNil(AskUserPending.dormantCallId(tailIsAssistant: true, tailCalls: calls, resolvedIds: ["ask1"]),
                     "already answered in this process — a second answer must not resume twice")
        XCTAssertNil(AskUserPending.dormantCallId(tailIsAssistant: true,
                                                  tailCalls: [.init(id: "s", name: "shell_execute")], resolvedIds: []))

        let answer = AskUserResult.content(for: .answered([AskUserAnswer(question: "q", answer: "预发", isOther: false)], .notification))
        let parts = AskUserPending.resumeResults(tailCalls: calls, askId: "ask1", content: answer.text, isError: answer.isError)
        XCTAssertEqual(parts.map(\.id), ["shell1", "ask1"], "results mirror the tool_use order")
        XCTAssertEqual(parts[0].content, AskUserPending.interruptedPlaceholder)
        XCTAssertTrue(parts[0].isError)
        XCTAssertEqual(parts[1].content, answer.text)
        XCTAssertFalse(parts[1].isError)
        XCTAssertEqual(AskUserResult.decode(parts[1].content)?.answers.first?.answer, "预发")
    }

    // MARK: - Who may ask

    func testChildCannotCallAskUser() {
        XCTAssertTrue(SubAgentTool.isForbiddenForChild(AskUserTool.name), "depth rule: a sub agent can't stop to ask")
        XCTAssertEqual(SubAgentTool.filterForChild([AskUserTool.name, "file_read"], name: { $0 }), ["file_read"])
        XCTAssertFalse(AskUserTool.isOffered(isSubAgentChild: true, blocksSideEffectTools: false,
                                             sessionSource: nil, isRemoteReadOnly: false))
    }

    func testNotOfferedInQuietAutomationOrContextTurns() {
        XCTAssertTrue(AskUserTool.isOffered(isSubAgentChild: false, blocksSideEffectTools: false,
                                            sessionSource: nil, isRemoteReadOnly: false), "an ordinary chat gets it")
        XCTAssertFalse(AskUserTool.isOffered(isSubAgentChild: false, blocksSideEffectTools: true,
                                             sessionSource: nil, isRemoteReadOnly: false))
        for source in ["quiet", "context", "shortcut", "siri", "automation", "orchestration", "watch"] {
            XCTAssertFalse(AskUserTool.isOffered(isSubAgentChild: false, blocksSideEffectTools: false,
                                                 sessionSource: source, isRemoteReadOnly: false), source)
        }
        XCTAssertFalse(AskUserTool.isOffered(isSubAgentChild: false, blocksSideEffectTools: false,
                                             sessionSource: nil, isRemoteReadOnly: true))
        XCTAssertTrue(ContextToolPolicy.blockedTools.contains(AskUserTool.name), "defence in depth for restricted turns")
    }

    func testFullAutoDoesNotAnswerForTheUser() {
        XCTAssertNil(SensitiveToolGate.Category.forToolName(AskUserTool.name),
                     "not an approval: full auto never auto-answers a question")
    }

    // MARK: - Result format

    func testResultRoundTripSurvivesAppendedReminder() {
        let answers = [AskUserAnswer(question: "名字？", answer: "Leo \"小\" 李", isOther: false),
                       AskUserAnswer(question: "公开吗？", answer: "no", isOther: false)]
        let text = AskUserResult.content(for: .answered(answers, .card)).text
            + "\n<system-reminder>The user cancelled this operation.</system-reminder>"
        let decoded = AskUserResult.decode(text)
        XCTAssertEqual(decoded?.status, .answered)
        XCTAssertEqual(decoded?.answers, answers)
        XCTAssertEqual(decoded?.source, .card)
        XCTAssertNil(AskUserResult.decode("Error: Unknown tool"))
    }

    func testToolDefinitionShape() {
        let def = AskUserTool.definition
        XCTAssertEqual(def.name, "ask_user")
        XCTAssertEqual(def.required, ["question"])
        XCTAssertEqual(def.parameters["kind"]?.enumValues, AskUserTool.Kind.allCases.map(\.rawValue))
        XCTAssertNotNil(def.parameters["more_questions"])
    }

    // MARK: - Notification

    func testNotificationActionsOnlyForSingleQuestions() {
        let choice = choiceRequest(allowOther: true)
        let actions = AskUserNotification.actions(for: choice, labels: .init(yes: "是", no: "否", other: "其他", answer: "回答"))
        XCTAssertEqual(actions.map(\.title), ["预发", "生产", "其他"])
        XCTAssertEqual(actions.last?.isTextInput, true)
        let input = AskUserNotification.answerInput(actionId: actions[1].id, typedText: nil, request: choice)
        var machine = AskUserMachine(toolUseId: "n", request: choice)
        XCTAssertEqual(machine.handle(.answer(input ?? [], source: .notification)),
                       .answered([AskUserAnswer(question: "部署到哪个环境？", answer: "生产", isOther: false)], .notification))
        XCTAssertNil(AskUserNotification.answerInput(actionId: AskUserNotification.optionActionPrefix + "9",
                                                     typedText: nil, request: choice), "out of range")
        XCTAssertEqual(AskUserNotification.answerInput(actionId: AskUserNotification.textActionId,
                                                       typedText: " 测试 ", request: choice),
                       [AskUserAnswerInput(value: "测试", isOther: true)])

        guard case .success(let multi) = AskUserRequest.parse(["question": "a", "more_questions": "[{\"question\":\"b\"}]"]) else {
            return XCTFail("parse")
        }
        XCTAssertTrue(AskUserNotification.actions(for: multi, labels: .init(yes: "是", no: "否", other: "其他", answer: "回答")).isEmpty,
                      "multi-step opens the chat to the card")
    }
}
