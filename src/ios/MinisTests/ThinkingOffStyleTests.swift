import XCTest

/// 「关思考」被 Anthropic 拒绝(2026-10-14 实测:sonnet-5-5 要 between_tools;opus-5-5 / fable-5 / fable-5-1
/// 只能 adaptive + 最低档 effort)的修复:写法的选择、报错文本解析、按 (实例 + 模型) 记忆、被拒后只重试一次。
/// 全是纯逻辑,不联网;provider / URLProtocol 里的接线用读源码断言钉住(同 F1WiringTests 的做法)。
final class ThinkingOffStyleTests: XCTestCase {

    // 2026-10-14 真实报错原文(sonnet 那段在服务端是被截断的,后面的省略号是原样保留)。
    private let sonnet55Message = #"To turn thinking off on this model, send "thinking": {"type": "between_tools"} instead of {"type": "disabled"}…"#
    private let opus55Message = #""thinking.type.disabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior."#

    /// 和线上一致的 400 响应体(用 JSONSerialization 生成,引号转义与真实响应一样)。
    private func errorBody(_ message: String, type: String = "invalid_request_error") throws -> String {
        let data = try JSONSerialization.data(withJSONObject: ["type": "error", "error": ["type": type, "message": message]])
        return String(decoding: data, as: UTF8.self)
    }

    private func style(_ id: String, learned: ThinkingOffStyle? = nil) -> ThinkingOffStyle {
        resolveThinkingOffStyle(modelId: id, learned: learned)
    }

    // MARK: - 种子表

    /// 只有 4 个实测被拒的模型离开 disabled;其余实测可用的模型一个都不动。
    func testSeedTableOnlyCoversMeasuredBadModels() {
        XCTAssertEqual(style("claude-sonnet-5-5"), .betweenTools)
        for id in ["claude-opus-5-5", "claude-fable-5", "claude-fable-5-1"] {
            XCTAssertEqual(style(id), .adaptiveLow, id)
        }
        for id in ["claude-haiku-4-5", "claude-haiku-5-5", "claude-opus-4-5", "claude-opus-4-6", "claude-opus-4-7",
                   "claude-opus-4-8", "claude-opus-5", "claude-sonnet-4-6", "claude-sonnet-5",
                   "gpt-5.5", "deepseek-v4-pro", "mimo-v2.5", ""] {
            XCTAssertEqual(style(id), .disabled, "「\(id)」实测 disabled 可用,不能被种子表带走")
        }
    }

    /// 中转站前缀、日期后缀、`5.5` 写法、大小写、Bedrock/Vertex 风格都要认。
    func testSeedMatchingToleratesRelayPrefixDateSuffixAndSpelling() {
        for id in ["vendor/claude-sonnet-5-5", "anthropic/claude-sonnet-5.5", "openrouter/anthropic/claude-sonnet-5.5",
                   "CLAUDE-SONNET-5-5", "claude-sonnet-5-5-20261001", "vendor/claude-sonnet-5-5-20261001",
                   "claude-sonnet-5-5@20261001", "anthropic.claude-sonnet-5-5-v1:0", "claude-sonnet-5-5-thinking"] {
            XCTAssertEqual(style(id), .betweenTools, id)
        }
        for id in ["vendor/claude-opus-5-5", "claude-opus-5.5", "claude-opus-5-5-20261001", "Anthropic/Claude-Opus-5-5",
                   "vendor/claude-fable-5-1", "claude-fable-5.1", "claude-fable-5-1-20261001", "claude-fable-5-1@20261001"] {
            XCTAssertEqual(style(id), .adaptiveLow, id)
        }
    }

    /// 日期不是次版本:fable-5 与 fable-5-1 不混;opus-5(可用 disabled)加日期后缀也不会被当成 opus-5-5。
    func testDateSuffixIsNeverReadAsMinorVersion() {
        XCTAssertEqual(ThinkingOffStyle.canonicalClaudeId("claude-fable-5-20261001"), "claude-fable-5")
        XCTAssertEqual(ThinkingOffStyle.canonicalClaudeId("claude-fable-5-1-20261001"), "claude-fable-5-1")
        XCTAssertEqual(ThinkingOffStyle.canonicalClaudeId("claude-opus-5-20261001"), "claude-opus-5")
        XCTAssertEqual(ThinkingOffStyle.canonicalClaudeId("claude-sonnet-5-5@20261001"), "claude-sonnet-5-5")
        XCTAssertEqual(style("claude-fable-5-20261001"), .adaptiveLow)
        XCTAssertEqual(style("claude-opus-5-20261001"), .disabled)
        XCTAssertEqual(style("claude-sonnet-5-20261001"), .disabled)
    }

    /// 没实测过的版本不猜:fable-5-2、sonnet-5-50、旧写法 claude-3-5-sonnet 都走默认。
    func testUnmeasuredVersionsFallBackToDisabled() {
        for id in ["claude-fable-5-2", "claude-sonnet-5-50", "claude-sonnet-5-6", "claude-3-5-sonnet-20241022",
                   "myclaude-sonnet-5-5", "claude-sonnet"] {
            XCTAssertEqual(style(id), .disabled, id)
        }
        XCTAssertNil(ThinkingOffStyle.canonicalClaudeId("gpt-5.5"))
        XCTAssertNil(ThinkingOffStyle.canonicalClaudeId("claude-3-5-sonnet-20241022"))
    }

    /// 学到的写法优先于种子表 —— 它来自这个接入点上的真实响应。
    func testLearnedStyleOutranksSeedAndDefault() {
        XCTAssertEqual(style("claude-sonnet-5-5", learned: .adaptiveLow), .adaptiveLow)
        XCTAssertEqual(style("claude-sonnet-5", learned: .betweenTools), .betweenTools)
        XCTAssertEqual(style("some-new-model", learned: .adaptiveLow), .adaptiveLow)
    }

    // MARK: - 报错文本解析

    func testRealErrorTextsMapToTheSuggestedStyle() throws {
        // 纯文本和完整 JSON 响应体都要认。
        XCTAssertEqual(ThinkingOffRejection.suggestedStyle(status: 400, text: sonnet55Message), .betweenTools)
        XCTAssertEqual(ThinkingOffRejection.suggestedStyle(status: 400, text: opus55Message), .adaptiveLow)
        XCTAssertEqual(ThinkingOffRejection.suggestedStyle(status: 400, text: try errorBody(sonnet55Message)), .betweenTools)
        XCTAssertEqual(ThinkingOffRejection.suggestedStyle(status: 400, text: try errorBody(opus55Message)), .adaptiveLow)
        // 流式路径 SDK 描述 + 响应体拼在一起(provider 里就是这么传的)。
        let combined = try errorBody(sonnet55Message) + " " + #"responseUnsuccessful(description: "status code 400")"#
        XCTAssertEqual(ThinkingOffRejection.suggestedStyle(status: 400, text: combined, excluding: .disabled), .betweenTools)
    }

    /// 只认 400 + 明确的建议:5xx、限流、鉴权、别的 400、没有建议的 400 都不算。
    func testOtherErrorsAreNeverTreatedAsStyleSuggestions() throws {
        let sonnet = try errorBody(sonnet55Message)
        for status in [401, 403, 404, 413, 422, 429, 500, 529] {
            XCTAssertNil(ThinkingOffRejection.suggestedStyle(status: status, text: sonnet), "status \(status)")
        }
        XCTAssertNil(ThinkingOffRejection.suggestedStyle(status: 400, text: try errorBody("prompt is too long: 205000 tokens > 200000 maximum")))
        XCTAssertNil(ThinkingOffRejection.suggestedStyle(status: 400, text: try errorBody("messages.1.content.0.thinking.signature: Field required")))
        // 只提 adaptive 不提 effort,不是「关」的建议。
        XCTAssertNil(ThinkingOffRejection.suggestedStyle(status: 400, text: "thinking.type.adaptive is not enabled for your organization"))
        XCTAssertNil(ThinkingOffRejection.suggestedStyle(status: 400, text: ""))
    }

    /// 服务端建议的和刚发出去的一样,重试没有意义,不算建议;双提及时挑和已发不同的那个。
    func testSuggestionNeverRepeatsTheStyleThatWasJustSent() {
        XCTAssertNil(ThinkingOffRejection.suggestedStyle(status: 400, text: sonnet55Message, excluding: .betweenTools))
        XCTAssertNil(ThinkingOffRejection.suggestedStyle(status: 400, text: opus55Message, excluding: .adaptiveLow))
        // 合成文本(不是真实原文):发了 between_tools 被拒,报错同时提到两种 → 该换 adaptiveLow,不能原地打转。
        let both = #""thinking.type.between_tools" is not supported. Use "thinking.type.adaptive" and "output_config.effort"."#
        XCTAssertEqual(ThinkingOffRejection.suggestedStyle(status: 400, text: both, excluding: .betweenTools), .adaptiveLow)
        XCTAssertEqual(ThinkingOffRejection.suggestedStyle(status: 400, text: both, excluding: .disabled), .betweenTools)
    }

    /// 中转站拿不到状态码时,必须带着 invalid_request_error 才认;type 被改写成别的但状态码是 400 也认。
    func testRelayWithoutStatusOrWithRewrittenType() throws {
        XCTAssertEqual(ThinkingOffRejection.suggestedStyle(status: nil, text: try errorBody(sonnet55Message)), .betweenTools)
        XCTAssertNil(ThinkingOffRejection.suggestedStyle(status: nil, text: sonnet55Message), "没有状态码也没有 type,不能凭一段文字就重试")
        XCTAssertEqual(ThinkingOffRejection.suggestedStyle(status: 400, text: try errorBody(opus55Message, type: "upstream_error")), .adaptiveLow)
    }

    // MARK: - 持久化往返

    private func makeDefaults() -> (UserDefaults, String) {
        let suite = "ThinkingOffStyleTests.\(UUID().uuidString)"
        return (UserDefaults(suiteName: suite)!, suite)
    }

    func testMemoryRoundTripSurvivesRelaunch() {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertNil(ThinkingOffStyleMemory.learned(scope: "instance:A", modelId: "claude-x", defaults: defaults))

        ThinkingOffStyleMemory.remember(.betweenTools, scope: "instance:A", modelId: "claude-x", defaults: defaults)
        XCTAssertEqual(ThinkingOffStyleMemory.learned(scope: "instance:A", modelId: "claude-x", defaults: defaults), .betweenTools)

        // 「重启」:同一个 suite 重新打开,学到的写法还在。
        let reopened = UserDefaults(suiteName: suite)!
        XCTAssertEqual(ThinkingOffStyleMemory.learned(scope: "instance:A", modelId: "claude-x", defaults: reopened), .betweenTools)

        // 覆盖写。
        ThinkingOffStyleMemory.remember(.adaptiveLow, scope: "instance:A", modelId: "claude-x", defaults: defaults)
        XCTAssertEqual(ThinkingOffStyleMemory.learned(scope: "instance:A", modelId: "claude-x", defaults: reopened), .adaptiveLow)
    }

    /// 同一个模型在不同实例(中转站)上分开记;模型 id 不区分大小写和首尾空白。
    func testMemoryIsScopedByInstanceAndModel() {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        ThinkingOffStyleMemory.remember(.betweenTools, scope: "instance:A", modelId: "Claude-Sonnet-5-5 ", defaults: defaults)
        XCTAssertEqual(ThinkingOffStyleMemory.learned(scope: "instance:A", modelId: "claude-sonnet-5-5", defaults: defaults), .betweenTools)
        XCTAssertNil(ThinkingOffStyleMemory.learned(scope: "instance:B", modelId: "claude-sonnet-5-5", defaults: defaults))
        XCTAssertNil(ThinkingOffStyleMemory.learned(scope: "instance:A", modelId: "claude-opus-5-5", defaults: defaults))
        XCTAssertNil(ThinkingOffStyleMemory.learned(scope: "endpoint:relay.example.com/v1", modelId: "claude-sonnet-5-5", defaults: defaults))
    }

    /// 字典里混进别的版本写的、或被手改坏的值:当作没学过,不崩。
    func testMemoryIgnoresUnknownStoredValues() {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(["instance:A|claude-x": "teleport", "instance:A|claude-y": "adaptiveLow"], forKey: ThinkingOffStyleMemory.defaultsKey)
        XCTAssertNil(ThinkingOffStyleMemory.learned(scope: "instance:A", modelId: "claude-x", defaults: defaults))
        XCTAssertEqual(ThinkingOffStyleMemory.learned(scope: "instance:A", modelId: "claude-y", defaults: defaults), .adaptiveLow)
        defaults.set("not a dictionary", forKey: ThinkingOffStyleMemory.defaultsKey)
        XCTAssertNil(ThinkingOffStyleMemory.learned(scope: "instance:A", modelId: "claude-y", defaults: defaults))
        // 坏数据不挡住新的写入。
        ThinkingOffStyleMemory.remember(.betweenTools, scope: "instance:A", modelId: "claude-y", defaults: defaults)
        XCTAssertEqual(ThinkingOffStyleMemory.learned(scope: "instance:A", modelId: "claude-y", defaults: defaults), .betweenTools)
    }

    func testMemoryKeyIsVersioned() {
        XCTAssertEqual(ThinkingOffStyleMemory.defaultsKey, "leo.thinkingOffStyle.v1")
    }

    // MARK: - 被拒后只重试一次

    private struct FakeRejection: Error, CustomStringConvertible {
        let text: String
        var description: String { text }
    }

    /// 和 provider 里一样的 learn:只看 400 + 报错文本。
    private func learn(_ error: Error, _ sent: ThinkingOffStyle) -> ThinkingOffStyle? {
        ThinkingOffRejection.suggestedStyle(status: 400, text: String(describing: error), excluding: sent)
    }

    func testRejectedStyleIsRetriedExactlyOnceAndSucceeds() async throws {
        var sentStyles: [ThinkingOffStyle] = []
        let result = try await ThinkingOffRetry.run(
            style: .disabled,
            attempt: { style -> String in
                sentStyles.append(style)
                if style == .disabled { throw FakeRejection(text: self.sonnet55Message) }
                return "stream"
            },
            learn: { error, sent in self.learn(error, sent) }
        )
        XCTAssertEqual(sentStyles, [.disabled, .betweenTools])
        XCTAssertEqual(result.value, "stream")
        XCTAssertEqual(result.style, .betweenTools, "调用方据此判断写法变了,要记下来")
    }

    /// 重试后服务端又给了另一个建议:不再试第三次,错误原样抛出。
    func testSecondRejectionIsNotRetriedAgain() async {
        var attempts = 0
        var learnCalls = 0
        do {
            _ = try await ThinkingOffRetry.run(
                style: .disabled,
                attempt: { style -> String in
                    attempts += 1
                    // 第一次被拒建议 between_tools,换了之后又被拒、建议 adaptive —— 不能再跟。
                    throw FakeRejection(text: style == .disabled ? self.sonnet55Message : self.opus55Message)
                },
                learn: { error, sent in learnCalls += 1; return self.learn(error, sent) }
            )
            XCTFail("第二次失败应原样抛出")
        } catch let error as FakeRejection {
            XCTAssertEqual(error.text, opus55Message, "抛出的是第二次的错误")
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertEqual(attempts, 2)
        XCTAssertEqual(learnCalls, 1, "只在第一次失败时学习一次")
    }

    func testNoRetryWhenFirstAttemptSucceedsOrErrorIsUnrelated() async throws {
        var attempts = 0
        var learnCalls = 0
        let ok = try await ThinkingOffRetry.run(
            style: .betweenTools,
            attempt: { _ -> Int in attempts += 1; return 7 },
            learn: { _, _ in learnCalls += 1; return nil }
        )
        XCTAssertEqual(ok.value, 7)
        XCTAssertEqual(ok.style, .betweenTools)
        XCTAssertEqual(attempts, 1)
        XCTAssertEqual(learnCalls, 0)

        // 与「关」无关的错误(过载、限流、别的 400):不重试,原样抛出。
        for text in ["overloaded_error", "rate_limit_error", "prompt is too long: 205000 tokens"] {
            attempts = 0
            do {
                _ = try await ThinkingOffRetry.run(
                    style: .disabled,
                    attempt: { _ -> Int in attempts += 1; throw FakeRejection(text: text) },
                    learn: { error, sent in self.learn(error, sent) }
                )
                XCTFail("应当抛出")
            } catch let error as FakeRejection {
                XCTAssertEqual(error.text, text)
            }
            XCTAssertEqual(attempts, 1, text)
        }
    }

    /// 建议的写法和刚发的一样,重试没意义。
    func testNoRetryWhenSuggestionEqualsSentStyle() async {
        var attempts = 0
        do {
            _ = try await ThinkingOffRetry.run(
                style: .betweenTools,
                attempt: { _ -> Int in attempts += 1; throw FakeRejection(text: self.sonnet55Message) },
                learn: { error, sent in self.learn(error, sent) }
            )
            XCTFail("应当抛出")
        } catch {}
        XCTAssertEqual(attempts, 1)
    }

    /// 重试前任务已取消:不再发第二次请求。
    func testCancelledTaskDoesNotRetry() async {
        // Task 闭包是 sending：不能捕获可变局部变量和 self（Swift 6 并发检查），所以用线程安全的计数器并提前取值。
        let message = sonnet55Message
        let counter = AttemptCounter()
        let task = Task {
            try await ThinkingOffRetry.run(
                style: .disabled,
                attempt: { _ -> Int in counter.increment(); throw FakeRejection(text: message) },
                learn: { error, sent in
                    withUnsafeCurrentTask { $0?.cancel() }
                    return ThinkingOffRejection.suggestedStyle(status: 400, text: String(describing: error), excluding: sent)
                }
            )
        }
        do {
            _ = try await task.value
            XCTFail("应当被取消")
        } catch is CancellationError {
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertEqual(counter.value, 1)
    }

    private final class AttemptCounter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        func increment() { lock.lock(); count += 1; lock.unlock() }
        var value: Int { lock.lock(); defer { lock.unlock() }; return count }
    }

    // MARK: - 请求体写法

    func testEachStyleWritesItsOwnWireShape() throws {
        var disabled: [String: Any] = ["model": "m"]
        XCTAssertFalse(ThinkingOffStyle.disabled.apply(to: &disabled))
        XCTAssertEqual(disabled["thinking"] as? [String: String], ["type": "disabled"])
        XCTAssertNil(disabled["output_config"])

        var between: [String: Any] = ["model": "m"]
        XCTAssertFalse(ThinkingOffStyle.betweenTools.apply(to: &between))
        XCTAssertEqual(between["thinking"] as? [String: String], ["type": "between_tools"])
        XCTAssertNil(between["output_config"])

        // adaptiveLow:thinking 只有 type(不带 display,「关」不要思考摘要),effort 放 output_config;
        // 返回 true 让调用方补 effort 的 beta 头;请求体里别的键(含 output_config 里别的键)不动。
        var low: [String: Any] = ["model": "m", "max_tokens": 16, "output_config": ["format": "json"]]
        XCTAssertTrue(ThinkingOffStyle.adaptiveLow.apply(to: &low))
        XCTAssertEqual(low["thinking"] as? [String: String], ["type": "adaptive"])
        let outputConfig = try XCTUnwrap(low["output_config"] as? [String: Any])
        XCTAssertEqual(outputConfig["effort"] as? String, "low")
        XCTAssertEqual(outputConfig["format"] as? String, "json")
        XCTAssertEqual(low["max_tokens"] as? Int, 16)
        XCTAssertEqual(low["model"] as? String, "m")

        var custom: [String: Any] = [:]
        ThinkingOffStyle.adaptiveLow.apply(to: &custom, effort: "high")
        XCTAssertEqual((custom["output_config"] as? [String: Any])?["effort"] as? String, "high")
    }

    /// adaptiveLow 的 effort 取该模型声明档位里最低的一档(复用现有 clampEffort),没声明就是 low。
    func testAdaptiveLowEffortFollowsDeclaredTiers() {
        let low = ThinkingOffStyle.adaptiveLowEffort
        XCTAssertEqual(low, "low")
        XCTAssertEqual(ThinkingRuleResolver.clampEffort(low, to: nil), "low")
        XCTAssertEqual(ThinkingRuleResolver.clampEffort(low, to: ["low", "medium", "high", "xhigh", "max"]), "low")
        XCTAssertEqual(ThinkingRuleResolver.clampEffort(low, to: ["medium", "high", "max"]), "medium")
        XCTAssertEqual(ThinkingRuleResolver.clampEffort(low, to: ["high", "max"]), "high")
    }

    func testRequestSettingsDefaultToTheSeedTableNotToDisabled() {
        let settings = AnthropicRequestSettings()
        XCTAssertFalse(settings.thinkingDisabled)
        XCTAssertNil(settings.thinkingOffStyle, "nil = 改写请求体时按模型 id 查种子表")
        XCTAssertNil(settings.thinkingOffEffort)
        XCTAssertEqual(resolveThinkingOffStyle(modelId: "claude-sonnet-5-5", learned: settings.thinkingOffStyle), .betweenTools)
    }

    // MARK: - 不能误伤的路径

    /// OpenAI 兼容路径的 `{"thinking":{"type":"disabled"}}` 是 DeepSeek V4 自己的写法(golden snapshot 钉住),
    /// 不是 Anthropic 的;Claude 的 id 走这条路径时从来不会收到 `thinking` 字段 —— 所以修 Claude 的「关」
    /// 不能去动 ThinkingRuleResolver。
    func testOpenAICompatPathNeverWritesThinkingObjectForClaudeIds() {
        func body(_ id: String, level: ThinkingLevel, openRouter: Bool) -> [String: Any] {
            var body: [String: Any] = [:]
            let ctx = ThinkingResolveContext(modelId: id, supportsReasoning: true, level: level, maxTokens: 4096,
                                             isOpenRouter: openRouter, usesUnifiedReasoningEffort: false,
                                             isMistral: false, offEffort: "none")
            _ = ThinkingRuleResolver.apply(to: &body, ctx: ctx)
            return body
        }
        for id in ["claude-sonnet-5-5", "anthropic/claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"] {
            for level in [ThinkingLevel.off, .high] {
                for openRouter in [false, true] {
                    XCTAssertNil(body(id, level: level, openRouter: openRouter)["thinking"], "\(id) \(level) openRouter=\(openRouter)")
                }
            }
        }
        // DeepSeek 的 disabled 原样保留。
        let deepseek = body("deepseek-v4-pro", level: .off, openRouter: false)
        XCTAssertEqual((deepseek["thinking"] as? [String: Any])?["type"] as? String, "disabled")
    }

    // MARK: - 接线(读源码断言:provider / URLProtocol 依赖 SwiftAnthropic 和网络,逻辑测试编译不了)

    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    /// 改写请求体的唯一出口走写法枚举,不再有写死的 disabled;自带 Base URL(EagerStreaming)和
    /// 手填令牌 / 中转站(DualAuth)两个 URLProtocol 都经过同一个改写,所以学到的写法对中转站同样生效。
    func testPatcherUsesStyleAndBothProtocolsShareIt() throws {
        let text = try source("Providers/Anthropic/OAuthHTTPClient.swift")
        XCTAssertFalse(text.contains(#"json["thinking"] = ["type": "disabled"]"#), "「关」不能再写死 disabled")
        XCTAssertTrue(text.contains("resolveThinkingOffStyle(modelId: modelId, learned: nil)"))
        XCTAssertTrue(text.contains("style.apply(to: &json, effort: settings?.thinkingOffEffort)"))
        XCTAssertEqual(text.components(separatedBy: "RequestBodyPatcher.injectThinkingConfig(into: mutable, settings: requestSettings)").count - 1, 2)
    }

    /// provider 决定写法时先看记忆再看种子;被拒走 ThinkingOffRetry(只一次),成功且写法变了才记。
    func testAgentProviderWiresMemorySeedAndSingleRetry() throws {
        let text = try source("Providers/Anthropic/AnthropicAgentProvider.swift")
        XCTAssertTrue(text.contains("ThinkingOffStyleMemory.learned(scope: provider.thinkingOffScope, modelId: model.id)"))
        XCTAssertTrue(text.contains("resolveThinkingOffStyle(modelId: model.id, learned: learnedOffStyle)"))
        XCTAssertEqual(text.components(separatedBy: "ThinkingOffRetry.run(").count - 1, 1)
        XCTAssertTrue(text.contains("ThinkingOffStyleMemory.remember(opened.style, scope: provider.thinkingOffScope, modelId: model.id)"))
        XCTAssertTrue(text.contains("guard AnthropicProvider.httpStatus(inDescription: description) == 400"))
    }

    /// 标题生成走 `.off` 的 AgentProvider(所以自动吃到上面的修复),并保留首条消息兜底。
    func testTitleGenerationStillUsesOffThinkingAndKeepsFallbackTitle() throws {
        let text = try source("Agent/Chat/AIChatViewModel+TitleGeneration.swift")
        XCTAssertTrue(text.contains("thinkingLevel: .off"))
        XCTAssertTrue(text.contains("await Self.applyFallbackTitle("))
    }
}
