import XCTest

/// [remote-ctl-ios] Leo Link 远控扩展(契约 leo-link-remote-controls.md)的 iOS 侧纯逻辑:
/// 模型列表解析、各路由请求体、能力开关、权限模式探测的竞态修复、计划审批卡的按钮。
final class HarnessRemoteControlsTests: XCTestCase {

    // MARK: 模型列表

    func testModelCatalogParsesGroupsByProviderInMacOrder() {
        let obj: [String: Any] = [
            "models": [
                ["provider": "anthropic", "provider_name": "Anthropic", "model": "opus", "name": "Claude Opus",
                 "efforts": ["low", "medium", "high"], "default_effort": "medium"],
                ["provider": "openai", "provider_name": "OpenAI", "model": "gpt", "name": "GPT", "efforts": []],
                ["provider": "anthropic", "provider_name": "Anthropic", "model": "sonnet", "name": "Claude Sonnet",
                 "default_effort": NSNull()],
                ["provider": "anthropic", "model": "opus", "name": "dup"],   // 重复:丢掉
                ["provider": "", "model": "bad"],                             // 缺 provider:丢掉
            ],
            "default": ["provider": "anthropic", "model": "sonnet", "effort": "high"],
        ]
        let catalog = HarnessModelCatalog.parse(obj)
        XCTAssertEqual(catalog.models.map(\.model), ["opus", "gpt", "sonnet"])
        XCTAssertEqual(catalog.models[0].efforts, ["low", "medium", "high"])
        XCTAssertEqual(catalog.models[0].defaultEffort, "medium")
        XCTAssertEqual(catalog.models[2].efforts, [])
        XCTAssertNil(catalog.models[2].defaultEffort)
        XCTAssertEqual(catalog.groups.map(\.provider), ["anthropic", "openai"])
        XCTAssertEqual(catalog.groups[0].models.map(\.model), ["opus", "sonnet"])
        XCTAssertEqual(catalog.groups[0].providerName, "Anthropic")
        XCTAssertEqual(catalog.defaultModel?.model, "sonnet")
        XCTAssertEqual(catalog.defaultModel?.effort, "high")
        XCTAssertEqual(catalog.option(for: HarnessModelRef(provider: "anthropic", model: "opus"))?.name, "Claude Opus")
        XCTAssertNil(catalog.option(for: HarnessModelRef(provider: "openai", model: "opus")))
    }

    func testModelCatalogToleratesEmptyAndMissingNames() {
        XCTAssertEqual(HarnessModelCatalog.parse([:]), HarnessModelCatalog())
        let catalog = HarnessModelCatalog.parse(["models": [["provider": "p", "model": "m"]], "default": NSNull()])
        XCTAssertEqual(catalog.models.first?.name, "m", "没有显示名用 model id")
        XCTAssertEqual(catalog.models.first?.providerName, "p")
        XCTAssertNil(catalog.defaultModel)
    }

    func testModelRefParse() {
        let ref = HarnessModelRef.parse(["provider": "a", "model": "b", "name": "B", "effort": ""])
        XCTAssertEqual(ref, HarnessModelRef(provider: "a", model: "b", name: "B", effort: nil))
        XCTAssertNil(HarnessModelRef.parse(["provider": "a"]))
        XCTAssertNil(HarnessModelRef.parse(NSNull()))
        XCTAssertEqual(HarnessModelRef(provider: "a", model: "b").displayName, "b")
    }

    // MARK: 请求体

    func testModelAndEffortBodies() {
        let body = HarnessRemoteRequests.modelBody(provider: "anthropic", model: "opus", effort: "high")
        XCTAssertEqual(body["provider"] as? String, "anthropic")
        XCTAssertEqual(body["model"] as? String, "opus")
        XCTAssertEqual(body["effort"] as? String, "high")
        let noEffort = HarnessRemoteRequests.modelBody(provider: "a", model: "b", effort: nil)
        XCTAssertNil(noEffort["effort"])
        XCTAssertEqual(Set(noEffort.keys), ["provider", "model"])
        let effortOnly = HarnessRemoteRequests.effortBody("low")
        XCTAssertEqual(effortOnly as NSDictionary, ["effort": "low"])
    }

    func testRenameFollowCompactBodies() {
        XCTAssertEqual(HarnessRemoteRequests.renameBody("  新标题 \n") as NSDictionary?, ["title": "新标题"])
        XCTAssertNil(HarnessRemoteRequests.renameBody("   "), "空标题不发")
        XCTAssertEqual((HarnessRemoteRequests.renameBody(String(repeating: "x", count: 500))?["title"] as? String)?.count, 200)
        XCTAssertEqual(HarnessRemoteRequests.followBody(true) as NSDictionary, ["following": true])
        XCTAssertEqual(HarnessRemoteRequests.followBody(false) as NSDictionary, ["following": false])
    }

    func testAttachmentsValueAndLimits() {
        let data = Data([0xFF, 0xD8, 0xFF])
        let attachment = HarnessAttachment(name: "photo-1.jpg", mime: "image/jpeg", data: data)
        let value = HarnessRemoteRequests.attachmentsValue([attachment])
        XCTAssertEqual(value, [["name": "photo-1.jpg", "mime": "image/jpeg", "data_base64": data.base64EncodedString()]])
        XCTAssertTrue(attachment.isWithinLimits)
        XCTAssertFalse(HarnessAttachment(name: "a.gif", mime: "image/gif", data: data).isWithinLimits)
        XCTAssertFalse(HarnessAttachment(name: "big.jpg", mime: "image/jpeg",
                                         data: Data(count: HarnessAttachment.maxBytes + 1)).isWithinLimits)
        XCTAssertEqual(HarnessAttachment.maxCount, 4)
        XCTAssertEqual(HarnessAttachment.remainingSlots(current: 1), 3)
        XCTAssertEqual(HarnessAttachment.remainingSlots(current: 6), 0)
    }

    func testAnswerAndDeclineBodies() {
        let body = HarnessRemoteRequests.answerBody(questionId: "q1", answers: [
            HarnessQuestionAnswer(question: "用哪个库?", selected: ["A", "B"], text: "  都行 "),
            HarnessQuestionAnswer(question: "要测试吗?", selected: ["要"], text: "  "),
        ])
        XCTAssertEqual(body["question_id"] as? String, "q1")
        let answers = body["answers"] as? [[String: Any]]
        XCTAssertEqual(answers?.count, 2)
        XCTAssertEqual(answers?[0]["question"] as? String, "用哪个库?")
        XCTAssertEqual(answers?[0]["selected"] as? [String], ["A", "B"])
        XCTAssertEqual(answers?[0]["text"] as? String, "都行")
        XCTAssertNil(answers?[1]["text"], "空白补充不发")
        let decline = HarnessRemoteRequests.declineBody(questionId: "q1")
        XCTAssertEqual(decline["question_id"] as? String, "q1")
        XCTAssertEqual(decline["decline"] as? Bool, true)
        XCTAssertTrue(JSONSerialization.isValidJSONObject(body))
    }

    func testCreatePayloadMapsThinkingToEffortOnlyForEffortMacs() {
        let base = HarnessFullAuto.createPayload(harness: "zcode", cwd: "~/x", prompt: "hi", thinking: "high", fullAuto: false)
        XCTAssertEqual(base["thinking"] as? String, "high")

        // 旧 Mac:thinking 照发,不发 effort / model。
        var old = base
        HarnessRemoteRequests.applyCreateChoices(to: &old, model: HarnessModelRef(provider: "p", model: "m"),
                                                 effort: "low", thinking: "high", features: nil)
        XCTAssertEqual(old["thinking"] as? String, "high")
        XCTAssertNil(old["effort"])
        XCTAssertNil(old["model"])

        // 报了 effort:thinking 改成 effort,不再发 thinking。
        let effortMac = HarnessFeatures(server: "leophoneagent", flags: [HarnessFeatures.effort])
        var mapped = base
        HarnessRemoteRequests.applyCreateChoices(to: &mapped, model: nil, effort: nil, thinking: "high", features: effortMac)
        XCTAssertNil(mapped["thinking"])
        XCTAssertEqual(mapped["effort"] as? String, "high")
        XCTAssertNil(mapped["model"], "没报 models 不发 model")

        // 显式选的强度优先于 thinking;报了 models 才发 model。
        let full = HarnessFeatures(server: "leophoneagent", flags: [HarnessFeatures.effort, HarnessFeatures.models])
        var chosen = base
        HarnessRemoteRequests.applyCreateChoices(to: &chosen, model: HarnessModelRef(provider: "p", model: "m", name: "M"),
                                                 effort: "low", thinking: "high", features: full)
        XCTAssertEqual(chosen["effort"] as? String, "low")
        XCTAssertEqual(chosen["model"] as? [String: String], ["provider": "p", "model": "m"])
        XCTAssertEqual(chosen["harness"] as? String, "zcode")
        XCTAssertTrue(JSONSerialization.isValidJSONObject(chosen))

        // 什么都没选 = Mac 自动选择:不带 model / effort。
        var auto = HarnessFullAuto.createPayload(harness: "zcode", cwd: "~", prompt: "hi", thinking: nil, fullAuto: false)
        HarnessRemoteRequests.applyCreateChoices(to: &auto, model: nil, effort: nil, thinking: nil, features: full)
        XCTAssertNil(auto["model"]); XCTAssertNil(auto["effort"]); XCTAssertNil(auto["thinking"])
    }

    // MARK: 能力开关

    func testFeaturesParseAndGating() {
        let obj: [String: Any] = [
            "server": "leophoneagent",
            "features": ["models": true, "model_switch": true, "effort": false, "compact": true,
                         "rename": true, "attachments": true, "follow": true, "ask_user_question": true,
                         "harness_sessions": true, "weird": "yes"],
        ]
        let features = HarnessFeatures.parse(obj)
        XCTAssertEqual(features.server, "leophoneagent")
        XCTAssertTrue(features.listsModels)
        XCTAssertTrue(features.switchesModel)
        XCTAssertFalse(features.switchesEffort, "effort 为 false 不显示强度")
        XCTAssertTrue(features.compacts && features.renames && features.acceptsAttachments && features.follows)
        XCTAssertFalse(features.has("weird"), "非布尔值不算开")
        XCTAssertTrue(features.hasSessionSettings)

        // 旧 Mac:什么新控件都不显示。
        let old = HarnessFeatures.parse(["features": ["harness_sessions": true, "full_auto": true]])
        XCTAssertFalse(old.listsModels || old.switchesModel || old.switchesEffort || old.compacts
                       || old.renames || old.acceptsAttachments || old.follows || old.hasSessionSettings)

        // 只报 models、没有 model_switch:能列模型(新建页),会话里不能换。
        let listOnly = HarnessFeatures(server: "leophoneagent", flags: ["models"])
        XCTAssertTrue(listOnly.listsModels)
        XCTAssertFalse(listOnly.switchesModel)
    }

    func testFeatureCacheRoundTripsPerHost() throws {
        let suite = "HarnessRemoteControlsTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let features = HarnessFeatures(server: "leophoneagent", flags: ["models", "follow"])
        HarnessFeatureCache(defaults: defaults).record(features, for: "mac-1")
        let fresh = HarnessFeatureCache(defaults: defaults)
        XCTAssertEqual(fresh.features(for: "mac-1"), features, "重启后从磁盘读回")
        XCTAssertNil(fresh.features(for: "mac-2"))
        XCTAssertNil(fresh.features(for: nil))
    }

    // MARK: 权限模式探测的竞态修复

    func testModeSupportNeverConcludesNoFromARowWithoutMode() {
        // 桌面任务行不带 mode:以前据此把整台 Mac 记成「不支持」。能力不明时不下结论。
        XCTAssertNil(HarnessModeSupport.resolve(features: nil, summaryMode: nil))
        XCTAssertNil(HarnessModeSupport.resolve(features: HarnessFeatures(server: "something", flags: []), summaryMode: nil))
        // LeoPhoneAgent 桥支持模式,哪怕这一行没有 mode。
        XCTAssertEqual(HarnessModeSupport.resolve(
            features: HarnessFeatures(server: "leophoneagent", flags: ["harness_sessions"]), summaryMode: nil), true)
        XCTAssertEqual(HarnessModeSupport.resolve(
            features: HarnessFeatures(server: nil, flags: ["session_mode"]), summaryMode: nil), true)
        // 摘要里带了 mode 就是支持。
        XCTAssertEqual(HarnessModeSupport.resolve(features: nil, summaryMode: .plan), true)
        // 只有原版 leoagent(有 harness_sessions、不报 server)才按能力判为不支持。
        XCTAssertEqual(HarnessModeSupport.resolve(
            features: HarnessFeatures(server: nil, flags: ["harness_sessions"]), summaryMode: nil), false)
        XCTAssertEqual(HarnessModeSupport.resolve(
            features: HarnessFeatures(server: nil, flags: ["harness_sessions"]), summaryMode: .build), true)
    }

    // MARK: 控制事件

    func testQuestionEventParse() {
        let obj: [String: Any] = [
            "event": "question.request", "seq": 7, "question_id": "q9",
            "questions": [
                ["question": "选哪个?", "header": "方案", "multi_select": true,
                 "options": [["label": "A", "description": "快"], ["label": "B"], ["label": ""]]],
                ["question": "", "options": []],   // 空题丢掉
                ["question": "还有吗?", "options": [["label": "没有"]]],
            ],
        ]
        guard case .question(let request)? = HarnessControlEvent.parse(obj) else { return XCTFail("not a question") }
        XCTAssertEqual(request.questionId, "q9")
        XCTAssertEqual(request.questions.count, 2)
        XCTAssertEqual(request.questions[0].header, "方案")
        XCTAssertTrue(request.questions[0].multiSelect)
        XCTAssertEqual(request.questions[0].options, [HarnessQuestionOption(label: "A", description: "快"),
                                                      HarnessQuestionOption(label: "B")])
        XCTAssertFalse(request.questions[1].multiSelect)
        XCTAssertNil(HarnessControlEvent.parse(["event": "question.request", "questions": []]), "没有 question_id 不认")
        XCTAssertEqual(HarnessControlEvent.parse(["event": "question.responded", "question_id": "q9"]),
                       .questionResponded(questionId: "q9"))
    }

    func testModelAndFollowEventsParse() {
        XCTAssertEqual(HarnessControlEvent.parse(["event": "model", "model": ["provider": "p", "model": "m", "effort": "high"]]),
                       .model(HarnessModelRef(provider: "p", model: "m", effort: "high")))
        XCTAssertEqual(HarnessControlEvent.parse(["event": "model", "model": NSNull()]), .model(nil))
        XCTAssertEqual(HarnessControlEvent.parse(["event": "follow", "following": false]), .follow(false))
        XCTAssertNil(HarnessControlEvent.parse(["event": "follow"]))
        XCTAssertNil(HarnessControlEvent.parse(["event": "message.delta", "delta": "x"]), "别的事件照旧走 GatewayEvent")
        XCTAssertNil(HarnessControlEvent.parse(["type": "mode", "mode": "plan"]))
    }

    func testQuestionDraftSelectionAndSubmit() {
        let request = HarnessQuestionRequest(questionId: "q", questions: [
            HarnessQuestion(question: "单选", options: [.init(label: "A"), .init(label: "B")], multiSelect: false),
            HarnessQuestion(question: "多选", options: [.init(label: "X"), .init(label: "Y")], multiSelect: true),
        ])
        var draft = HarnessQuestionDraft()
        XCTAssertFalse(draft.canSubmit(request))
        draft.toggle("A", question: 0, multiSelect: false)
        draft.toggle("B", question: 0, multiSelect: false)
        XCTAssertEqual(draft.selected[0], ["B"], "单选换选项")
        draft.toggle("X", question: 1, multiSelect: true)
        draft.toggle("Y", question: 1, multiSelect: true)
        draft.toggle("X", question: 1, multiSelect: true)
        XCTAssertEqual(draft.selected[1], ["Y"], "多选可取消")
        XCTAssertTrue(draft.canSubmit(request))
        draft.selected[1] = []
        draft.text[1] = "自己写"
        XCTAssertTrue(draft.canSubmit(request), "只写了字也能提交")
        XCTAssertEqual(draft.answers(for: request), [
            HarnessQuestionAnswer(question: "单选", selected: ["B"]),
            HarnessQuestionAnswer(question: "多选", selected: [], text: "自己写"),
        ])
    }

    // MARK: 计划审批卡

    func testPlanCardShowsOnlyOfferedApproveAndDeny() {
        XCTAssertTrue(HarnessApprovalPresentation.isPlan(tool: "ExitPlanMode"))
        XCTAssertFalse(HarnessApprovalPresentation.isPlan(tool: "Bash"))
        XCTAssertFalse(HarnessApprovalPresentation.isPlan(tool: nil))
        XCTAssertEqual(HarnessApprovalPresentation.visibleChoices(["once", "deny"], tool: "ExitPlanMode"), ["once", "deny"])
        XCTAssertEqual(HarnessApprovalPresentation.visibleChoices(["once", "session", "always", "deny"], tool: "ExitPlanMode"),
                       ["once", "deny"], "计划只有批准 / 不批准")
        XCTAssertEqual(HarnessApprovalPresentation.visibleChoices(["deny"], tool: "ExitPlanMode"), ["deny"],
                       "事件没给的按钮不显示")
        XCTAssertEqual(HarnessApprovalPresentation.visibleChoices(["session"], tool: "ExitPlanMode"), ["session"],
                       "两个都没有时原样显示,不凭空造按钮")
    }

    func testOrdinaryCardsRenderOnlyOfferedChoices() {
        XCTAssertEqual(HarnessApprovalPresentation.visibleChoices(["once", "deny", "once", ""], tool: "Bash"), ["once", "deny"])
        XCTAssertEqual(HarnessApprovalPresentation.visibleChoices(["once", "session", "always", "deny"], tool: nil),
                       ["once", "session", "always", "deny"])
    }

    func testPlanTextFallsBackToDescription() {
        XCTAssertEqual(HarnessApprovalPresentation.planText(plan: "# 计划\n1. 改", description: "desc"), "# 计划\n1. 改")
        XCTAssertEqual(HarnessApprovalPresentation.planText(plan: "  ", description: " 描述 "), "描述")
        XCTAssertEqual(HarnessApprovalPresentation.planText(plan: nil, description: nil), "")
    }

    // MARK: 关注 / 默认目录

    func testApprovalNotificationSkipsUnfollowedSessionsOnly() {
        XCTAssertTrue(HarnessFollowPolicy.notifiesApproval(following: true))
        XCTAssertTrue(HarnessFollowPolicy.notifiesApproval(following: nil), "旧 Mac 不报,按关注处理")
        XCTAssertFalse(HarnessFollowPolicy.notifiesApproval(following: false))
    }

    func testLaunchDefaultCwdMatchesHomeTarget() {
        let saved = HomeMacDispatchTarget(hostId: "mac-1", cliKey: "zcode", cliName: "LeoBot", cwd: "~/proj")
        XCTAssertEqual(HarnessLaunchDefaults.cwd(hostId: "mac-1", saved: saved, recentCwds: ["~/other"]), "~/proj")
        XCTAssertEqual(HarnessLaunchDefaults.cwd(hostId: "mac-2", saved: saved, recentCwds: ["~", "~/other"]), "~/other",
                       "别的 Mac 的记忆不用;最近目录跳过主目录")
        XCTAssertEqual(HarnessLaunchDefaults.cwd(hostId: "mac-2", saved: nil, recentCwds: []), "~")
        var home = saved
        home.cwd = nil
        XCTAssertEqual(HarnessLaunchDefaults.cwd(hostId: "mac-1", saved: home, recentCwds: []), "~")
    }

    func testEffortTitles() {
        XCTAssertFalse(HarnessEffort.title("high").isEmpty)
        XCTAssertEqual(HarnessEffort.title("ultra-custom"), "ultra-custom")
    }
}
