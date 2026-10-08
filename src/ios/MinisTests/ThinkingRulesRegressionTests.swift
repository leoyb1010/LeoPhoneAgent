import XCTest

/// Named regression rules for the OpenAI-compatible thinking wire format, ported from
/// upstream's ThinkingRulesRegressionTests (wire-level subset). Each test encodes one rule
/// that a past field report taught; the golden snapshot covers the full matrix.
///
/// [Leo port] Calls `ThinkingRuleResolver.apply` with the context `injectThinkingParams`
/// builds (the test target cannot compile `OpenAIAgentProvider`). Declared tiers are
/// marked authoritative unless a test says otherwise.
final class ThinkingRulesRegressionTests: XCTestCase {

    // MARK: - Helpers

    private func inject(
        _ id: String,
        supportsReasoning: Bool? = true,
        effortValues: [String]? = nil,
        authoritative: Bool = true,
        level: ThinkingLevel,
        isOpenRouter: Bool = false,
        maxTokens: Int = 4096,
        offEffort: String? = nil,
        unified: Bool = false,
        isMistral: Bool = false,
        isDashScope: Bool = false,
        isCerebras: Bool = false,
        userRules: [ThinkingRule] = []
    ) -> [String: Any] {
        var body: [String: Any] = [:]
        let ctx = ThinkingResolveContext(
            modelId: id,
            supportsReasoning: supportsReasoning,
            declaredEffortValues: effortValues,
            effortDeclarationIsAuthoritative: authoritative && effortValues != nil,
            level: level,
            maxTokens: maxTokens,
            isOpenRouter: isOpenRouter,
            usesUnifiedReasoningEffort: unified,
            isMistral: isMistral,
            isDashScope: isDashScope,
            isCerebras: isCerebras,
            offEffort: offEffort,
            userRules: userRules
        )
        _ = ThinkingRuleResolver.apply(to: &body, ctx: ctx)
        return body
    }

    private func thinkingKeys(in body: [String: Any]) -> [String] {
        ["reasoning_effort", "reasoning", "thinking", "enable_thinking",
         "thinking_budget", "extra_body"].filter { body[$0] != nil }
    }

    // MARK: - Negative: zero fields

    /// Mistral: no thinking parameter may EVER be sent (422 extra_forbidden). The rule now
    /// lives INSIDE the resolver (`mistral-official`), so it cannot be lost when a second
    /// injection path is added.
    func testMistralEmitsNoThinkingFields() {
        for level in ThinkingLevel.allCases {
            let body = inject("mistral-large-latest", effortValues: ["low", "high"], level: level,
                              isOpenRouter: true, offEffort: "none", isMistral: true)
            XCTAssertEqual(thinkingKeys(in: body), [], "Mistral at \(level): \(body)")
        }
        // Load-bearing check: without the Mistral flag the same request DOES emit.
        XCTAssertFalse(thinkingKeys(in: inject("mistral-large-latest", effortValues: ["low", "high"],
                                               level: .high, isOpenRouter: true)).isEmpty)
    }

    /// Venice/Ark: the root `thinking` key must not appear even when thinking is OFF.
    func testUnifiedGatewayNeverReceivesRootThinkingKey() {
        for level in [ThinkingLevel.off, .high] {
            let body = inject("deepseek-v4-flash", effortValues: ["low", "high", "max"], level: level,
                              offEffort: "minimal", unified: true)
            XCTAssertNil(body["thinking"], "root thinking must never reach a unified gateway: \(body)")
        }
    }

    /// Families declaring no effort tiers keep the self-reasoning skip (22647505).
    func testUndeclaredGLMFamilySendsNoThinkingField() {
        let body = inject("glm-4.5-air", supportsReasoning: nil, level: .high)
        XCTAssertEqual(thinkingKeys(in: body), [], "\(body)")
    }

    /// [Leo] A NON-authoritative declaration (cross-provider vote on a custom relay) must
    /// not change what that relay receives: the glm skip still applies.
    func testNonAuthoritativeDeclarationKeepsRelayBehaviour() {
        let body = inject("glm-5.2", effortValues: ["high", "max"], authoritative: false, level: .high)
        XCTAssertEqual(thinkingKeys(in: body), [], "\(body)")
        let vendor = inject("vendor-y", effortValues: ["high", "max"], authoritative: false, level: .xhigh)
        XCTAssertEqual(vendor["reasoning_effort"] as? String, "xhigh",
                       "a guessed tier set must not clamp a custom relay's request: \(vendor)")
    }

    // MARK: - Positive: effort mapping

    func testDeclaredGLMModelReceivesRootReasoningEffort() {
        let body = inject("glm-5.2", effortValues: ["high", "max"], level: .high)
        XCTAssertEqual(body["reasoning_effort"] as? String, "high", "\(body)")
    }

    func testSparseDeclaredSetClampsXhigh() {
        let body = inject("glm-5.2", effortValues: ["high", "max"], level: .xhigh)
        XCTAssertEqual(body["reasoning_effort"] as? String, "high", "\(body)")
    }

    /// ULTRA never reaches the wire as the literal "ultra".
    func testUltraNeverReachesWireAsLiteral() {
        for (id, unified, openRouter) in [("gpt-5.6-sol", false, false), ("vendor-z", false, false),
                                          ("vendor-z", true, false), ("vendor-z", false, true),
                                          ("deepseek-v4-pro", false, false)] {
            let body = inject(id, level: .ultra, isOpenRouter: openRouter, unified: unified)
            let flat = body["reasoning_effort"] as? String
            let nested = (body["reasoning"] as? [String: Any])?["effort"] as? String
            XCTAssertNotEqual(flat, "ultra", "\(id): \(body)")
            XCTAssertNotEqual(nested, "ultra", "\(id): \(body)")
        }
    }

    // MARK: - OFF semantics

    /// MiMo/Agnes validate a strict low/medium/high enum: OFF must omit the field.
    func testMimoAndAgnesOmitEffortWhenOff() {
        for id in ["mimo-v2.5", "mimo-2.5", "agnes-1"] {
            let body = inject(id, level: .off, offEffort: "minimal")
            XCTAssertNil(body["reasoning_effort"], "\(id): \(body)")
        }
    }

    func testUnknownVendorOmitsOffTierWhenNoneOffered() {
        let body = inject("some-relay-model", effortValues: ["low", "medium", "high"], level: .off)
        XCTAssertNil(body["reasoning_effort"], "\(body)")
    }

    func testAllowlistedOffTierIsSentExplicitly() {
        let body = inject("gpt-5.3", effortValues: ["none", "low", "medium", "high"], level: .off, offEffort: "none")
        XCTAssertEqual(body["reasoning_effort"] as? String, "none", "\(body)")
    }

    /// Ark: OFF on a self-reasoning family must still send the gateway's off tier.
    func testArkOffSendsMinimalForSelfReasoningFamily() {
        let body = inject("deepseek-v4-pro", effortValues: ["high", "max"], authoritative: false,
                          level: .off, offEffort: "minimal", unified: true)
        XCTAssertEqual(body["reasoning_effort"] as? String, "minimal", "\(body)")
    }

    // MARK: - Structure

    /// DeepSeek V4: switch and tier are ROOT SIBLINGS. The nested-tier shape ran the vendor
    /// default for months; the negative assertion is the point.
    func testDeepSeekV4SendsRootSiblings() {
        for id in ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-flash", "deepseek-flash-lite"] {
            let body = inject(id, level: .high)
            let thinking = body["thinking"] as? [String: Any]
            XCTAssertEqual(thinking?["type"] as? String, "enabled", "\(id): \(body)")
            XCTAssertEqual(body["reasoning_effort"] as? String, "high", "\(id): \(body)")
            XCTAssertNil(thinking?["reasoning_effort"], "tier must not be nested: \(body)")
        }
        XCTAssertEqual(inject("deepseek-v4-pro", level: .max)["reasoning_effort"] as? String, "max")
        // Without any catalog hit the documented [high,max] ladder still applies.
        XCTAssertEqual(inject("deepseek-v4-pro", level: .low)["reasoning_effort"] as? String, "high")
    }

    func testDeepSeekV4ExplicitlyDisablesWhenOff() {
        let body = inject("deepseek-v4-pro", effortValues: ["high", "max"], level: .off)
        XCTAssertEqual((body["thinking"] as? [String: Any])?["type"] as? String, "disabled", "\(body)")
        XCTAssertNil(body["reasoning_effort"], "\(body)")
    }

    /// `deepseek-flash*` must not claim other DeepSeek ids.
    func testDeepSeekFlashScopeDoesNotClaimOtherModels() {
        for id in ["deepseek-chat", "deepseek-reasoner"] {
            XCTAssertNil(inject(id, level: .high)["thinking"], id)
        }
    }

    func testArkHostedDeepSeekUsesUniformEffort() {
        let body = inject("deepseek-v4-flash", effortValues: ["low", "high", "max"], level: .high, unified: true)
        XCTAssertNil(body["thinking"], "\(body)")
        XCTAssertNotNil(body["reasoning_effort"], "\(body)")
    }

    /// DashScope: dual send at root AND extra_body.
    func testQwenDualSendsOnDashScope() {
        let body = inject("qwen3-32b", level: .medium, isDashScope: true)
        XCTAssertNotNil(body["enable_thinking"], "\(body)")
        XCTAssertNotNil((body["extra_body"] as? [String: Any])?["enable_thinking"], "\(body)")
    }

    /// [T-ios-qwen-extra-body-400] Any other endpoint: root enable_thinking ONLY.
    func testQwenOnRelaySendsRootEnableThinkingOnly() {
        let body = inject("qwen3.8-max", level: .high, maxTokens: 16384)
        XCTAssertEqual(body["enable_thinking"] as? Bool, true, "\(body)")
        XCTAssertNil(body["extra_body"], "\(body)")
        XCTAssertNil(body["thinking_budget"], "\(body)")
    }

    /// [T-ios-cerebras-reasoning-400] Cerebras re-hosts a qwen id: root effort, no enable_thinking.
    func testCerebrasQwenUsesReasoningEffort() {
        let body = inject("qwen-3.8-27b", level: .high, isCerebras: true)
        XCTAssertNil(body["enable_thinking"], "\(body)")
        XCTAssertEqual(body["reasoning_effort"] as? String, "high", "\(body)")
    }

    func testOpenRouterUsesNestedReasoningAndOmitsWhenOff() {
        let on = inject("anthropic/claude-sonnet-4-6", effortValues: ["low", "medium", "high"], level: .high, isOpenRouter: true)
        XCTAssertEqual((on["reasoning"] as? [String: Any])?["effort"] as? String, "high", "\(on)")
        XCTAssertNil(on["reasoning_effort"], "\(on)")
        let off = inject("anthropic/claude-sonnet-4-6", level: .off, isOpenRouter: true, offEffort: "none")
        XCTAssertNil(off["reasoning"], "\(off)")
    }

    // MARK: - Boundary

    func testQwenBudgetStaysStrictlyBelowMaxTokens() {
        for maxTokens in [16384, 64000, 4096, 2] {
            let body = inject("qwen3-32b", level: .max, maxTokens: maxTokens, isDashScope: true)
            if let budget = body["thinking_budget"] as? Int, budget > 0 {
                XCTAssertLessThan(budget, maxTokens, "\(body)")
            }
        }
    }

    func testQwenDropsBudgetWhenMaxTokensLeavesNoRoom() {
        let body = inject("qwen3-32b", level: .max, maxTokens: 1, isDashScope: true)
        XCTAssertLessThanOrEqual((body["thinking_budget"] as? Int) ?? 0, 0, "\(body)")
    }

    /// Non-reasoning models (gpt-4o) never get an effort field.
    func testNonReasoningModelReceivesNoEffortField() {
        for level in ThinkingLevel.allCases {
            XCTAssertEqual(thinkingKeys(in: inject("gpt-4o", supportsReasoning: false, level: level,
                                                   offEffort: "none")), [], "\(level)")
            XCTAssertEqual(thinkingKeys(in: inject("vendor-plain", supportsReasoning: false, level: level)),
                           [], "\(level)")
        }
    }

    // MARK: - User rules (unified ThinkingRule)

    /// Empty user rules must change nothing (the persistence layer's core invariant).
    func testEmptyUserRulesChangeNothing() {
        for id in ["deepseek-v4-pro", "glm-5.2", "qwen3-32b", "gpt-5.3"] {
            for level in [ThinkingLevel.off, .high] {
                let a = inject(id, level: level, offEffort: "none")
                let b = inject(id, level: level, offEffort: "none", userRules: [])
                XCTAssertEqual(NSDictionary(dictionary: a), NSDictionary(dictionary: b), id)
            }
        }
    }

    /// A user wire rule outranks the built-in vendor rule it precedes.
    func testCustomWireRuleOverridesBuiltIn() {
        let rule = ThinkingRule(kind: .custom, scope: .modelPattern("deepseek-v4*"),
                                wireFormat: .extraBodyToggle(path: "extra_body.thinking.enabled"),
                                label: "my-relay")
        let on = inject("deepseek-v4-pro", level: .high, userRules: [rule])
        XCTAssertNil(on["thinking"], "\(on)")
        XCTAssertEqual(((on["extra_body"] as? [String: Any])?["thinking"] as? [String: Any])?["enabled"] as? Bool, true)
        let off = inject("deepseek-v4-pro", level: .off, userRules: [rule])
        XCTAssertEqual(((off["extra_body"] as? [String: Any])?["thinking"] as? [String: Any])?["enabled"] as? Bool, false)
    }

    /// A ceiling-only custom rule (no wire format) must not shadow the vendor rule below.
    func testCeilingOnlyRuleDoesNotShadowWireRules() {
        let ceiling = ThinkingRule.ceiling(prefix: "deepseek", maxLevel: .high)
        let body = inject("deepseek-v4-pro", level: .high, userRules: [ceiling])
        XCTAssertEqual((body["thinking"] as? [String: Any])?["type"] as? String, "enabled", "\(body)")
    }

    /// Custom patterns without `*` are prefixes (the legacy settings semantics).
    func testCustomPatternWithoutStarIsPrefix() {
        let rule = ThinkingRule.ceiling(prefix: "gpt-5.7", maxLevel: .medium)
        XCTAssertTrue(rule.matches("gpt-5.7-new-preview"))
        XCTAssertTrue(rule.matches("GPT-5-7-NEW"), "dot/dash and case are normalised")
        XCTAssertFalse(rule.matches("gpt-5.6-sol"))
        let glob = ThinkingRule(kind: .custom, scope: .modelPattern("*flash"), wireFormat: .omitEverything, label: "x")
        XCTAssertTrue(glob.matches("gemini-flash"))
        XCTAssertFalse(glob.matches("gemini-flash-lite"))
        // Built-in patterns stay exact globs.
        let builtin = ThinkingRule(kind: .officialVendor, scope: .modelPattern("o1"), wireFormat: nil, label: "b")
        XCTAssertFalse(builtin.matches("o1-mini"))
    }

    /// Built-in rule ids are unique per scope (five openai-native rows ≠ one SwiftUI row).
    func testBuiltInRuleIdsAreUnique() {
        let ctx = ThinkingResolveContext(modelId: "", supportsReasoning: true, level: .high, maxTokens: 8192,
                                         isOpenRouter: true, usesUnifiedReasoningEffort: true, isMistral: true,
                                         isDashScope: true, isCerebras: true, offEffort: nil)
        let ids = ThinkingRuleResolver.builtInRules(for: ctx).map(\.id)
        XCTAssertEqual(ids.count, Set(ids).count, "\(ids)")
    }

    /// The trace names the winning rule and the gate that intervened.
    func testTraceNamesRuleAndGate() {
        var body: [String: Any] = [:]
        let ctx = ThinkingResolveContext(modelId: "mimo-v2.5", supportsReasoning: true, level: .off, maxTokens: 4096,
                                         isOpenRouter: false, usesUnifiedReasoningEffort: false, isMistral: false,
                                         offEffort: "minimal")
        let trace = ThinkingRuleResolver.apply(to: &body, ctx: ctx)
        XCTAssertEqual(trace.matchedRuleLabel, "openai-compatible-default")
        XCTAssertTrue(trace.logLine.contains("strict-effort-enum"), trace.logLine)
    }

    // MARK: - Effort vocabulary

    func testClampEffortNearestBelowThenLowest() {
        XCTAssertEqual(ThinkingRuleResolver.clampEffort("xhigh", to: ["high", "max"]), "high")
        XCTAssertEqual(ThinkingRuleResolver.clampEffort("low", to: ["high", "max"]), "high")
        XCTAssertEqual(ThinkingRuleResolver.clampEffort("max", to: ["low", "medium", "high"]), "high")
        XCTAssertEqual(ThinkingRuleResolver.clampEffort("medium", to: nil), "medium")
        XCTAssertEqual(ThinkingRuleResolver.clampEffort("medium", to: ["future-tier"]), "medium")
    }

    func testNativeEffortRequiresAffirmativeReasoning() {
        XCTAssertNil(ThinkingRuleResolver.nativeEffort(supportsReasoning: nil, level: .high))
        XCTAssertNil(ThinkingRuleResolver.nativeEffort(supportsReasoning: true, level: .off))
        XCTAssertEqual(ThinkingRuleResolver.nativeEffort(supportsReasoning: true, level: .ultra), "max")
    }
}
