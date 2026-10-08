import Foundation

/// The context a resolution runs against — everything about the endpoint and the model
/// that any rule is allowed to look at. Passing this explicitly (rather than reading a
/// provider instance) keeps the resolver a pure function, which is what makes it
/// snapshot-testable without a network stub.
struct ThinkingResolveContext {
    var modelId: String
    var supportsReasoning: Bool?
    var declaredEffortValues: [String]?
    /// [OpenMinis#163] The catalog affirmatively declares this model has NO
    /// effort tiers (reasons, but takes no `reasoning_effort`). Distinct from
    /// `declaredEffortValues == nil`, which also means "catalog never heard of
    /// it" — only the affirmative case suppresses the field. Defaults false so
    /// every existing construction site keeps its current behaviour.
    ///
    /// Only consulted together with `isXAI` — see the skip in `.reasoningEffort`.
    var declaresNoEffortTiers: Bool = false

    /// [T-thinking-off-custom-provider] True only when `declaredEffortValues` came from a
    /// catalog entry that describes THIS endpoint — i.e. the model's own provider matched
    /// a models.dev provider key.
    ///
    /// False for the cross-provider fallback scan, which is what every user-defined
    /// OpenAI-compatible relay hits: a custom instance's provider name is not in
    /// `ModelsDevAPI.providerKeyMap`, so resolution falls through to "match this bare
    /// model id under ANY publisher, then majority-vote the effort sets". That vote is a
    /// reasonable guess for CLAMPING a tier the user asked for, but it is not evidence
    /// about the endpoint the user actually configured — for `minimax-m3` the winning set
    /// carries only 4 of 9 declaring publishers.
    ///
    /// So it must not be used to SUPPRESS the user's explicit "thinking off": doing that
    /// would let one relay's registration silently override a different relay's real
    /// capability, with no error to explain why the toggle did nothing. Unknown endpoints
    /// default to pass-through and let the vendor answer for itself.
    var effortDeclarationIsAuthoritative: Bool = false
    /// [OpenMinis#163] Endpoint is xAI's own API (api.x.ai), not a relay that
    /// merely serves grok-named models. Scopes the empty-tier skip to the
    /// vendor where the 400 was actually observed.
    var isXAI: Bool = false
    var level: ThinkingLevel
    var maxTokens: Int
    /// Vendor predicates, resolved by the caller from the provider's base URL. The
    /// resolver never parses URLs itself — that keeps URL-sniffing in one place and lets
    /// Phase 2 replace these with user-authored scopes without touching this file.
    var isOpenRouter: Bool
    var usesUnifiedReasoningEffort: Bool
    var isMistral: Bool
    /// [T-ios-qwen-extra-body-400] Endpoint is Alibaba DashScope itself, not a relay that
    /// merely serves qwen-named models. Selects the `extra_body` envelope, which is
    /// DashScope-specific and a hard 400 on strict-schema gateways.
    ///
    /// Defaults false so an unknown endpoint gets the root-only shape: omitting the
    /// envelope costs at most a thinking toggle that doesn't take, while sending it to a
    /// vendor that doesn't know the field fails the whole request.
    var isDashScope: Bool = false
    /// [T-ios-cerebras-reasoning-400] Endpoint is Cerebras (OpenMinis#361).
    ///
    /// Same shape of problem as `isDashScope` and for the same reason: the
    /// `*qwen*` rule matches on the model NAME, and Cerebras re-hosts
    /// `qwen-3.8-27b`. Qwen's native `enable_thinking` is not accepted there —
    /// their control is root `reasoning_effort`, which the bundled models-dev
    /// catalog already declares for both Cerebras models.
    ///
    /// Defaults false so every other endpoint resolves exactly as before.
    var isCerebras: Bool = false
    /// The vendor's documented off tier, or nil to omit the field when thinking is off.
    /// Already an ALLOWLIST decision made by `explicitOffEffort` (ff60c818).
    var offEffort: String?

    /// User-authored rules for this provider instance, in evaluation order. Prepended to
    /// the built-in registry, so a custom rule always outranks a built-in and the
    /// built-ins remain as an un-deletable floor. Rules without a wire format are
    /// ignored here. EMPTY IS THE DEFAULT and must change nothing (golden snapshots).
    var userRules: [ThinkingRule] = []
}

/// [T-thinking-vision-diag] What kind of evidence a gate decided on.
///
/// Naming the SOURCE, not just the outcome, is the whole point: three rounds of the
/// thinking-off 400 investigation were spent working out whether a given suppression came
/// from a model-name substring, from the endpoint's host, or from a models.dev entry — and
/// whether that entry described this endpoint or somebody else's. A gate id alone does not
/// answer that; the evidence tag does.
enum ThinkingEvidence: String {
    /// Model-id substring match (mimo/agnes, the deepseek/glm/kimi/minimax family list).
    case modelFamily
    /// models.dev, from an entry belonging to the model's OWN provider.
    case catalogAuthoritative
    /// models.dev declared tiers used WITHOUT regard to whose entry they came from —
    /// the plain membership test. Distinct from `catalogAuthoritative` because that
    /// distinction is precisely what 621b0f27 turned on, and a shared tag here would
    /// re-merge the two mechanisms the last commit spent its effort separating.
    case catalogHeuristic
    /// The endpoint's own identity — host match or an endpoint flag (xAI, unified gateway).
    case endpointIdentity
    /// The model's declared capability (`supportsReasoning`).
    case modelCapability
}

/// [T-thinking-vision-diag] One gate that intervened during emission.
///
/// Records only metadata — gate id, evidence class, verdict — never prompt or user content.
struct ThinkingGateEvent {
    /// Stable identifier, e.g. "strict-effort-enum". Matches the design doc's G1..G7 map.
    let id: String
    let evidence: ThinkingEvidence
    /// What the gate did, in the vocabulary of the design's `Verdict`.
    let verdict: String

    var logFragment: String { "\(id)/\(evidence.rawValue):\(verdict)" }
}

/// Why a particular wire shape was chosen. Design §8 / OpenMinis#100: the resolved
/// outcome must be inspectable, otherwise a user-editable rule layer just replaces one
/// hidden variable with a more complicated one.
struct ThinkingResolveTrace {
    var matchedRuleLabel: String
    var matchedRuleKind: ThinkingRule.Kind
    var formatSource: String
    var wireFormat: ThinkingWireFormat?
    var emittedKeys: [String]
    var clampedFrom: String?
    var clampedTo: String?
    /// [T-thinking-vision-diag] Gates that actually intervened, in evaluation order.
    /// Empty means the chosen format emitted unimpeded — which is itself the answer to
    /// "did something silently suppress my thinking parameter?".
    var gateEvents: [ThinkingGateEvent] = []

    /// One-line form for `AppLogger(category: "Thinking")`.
    var logLine: String {
        var parts = ["rule=\(matchedRuleLabel)", "kind=\(matchedRuleKind)", "src=\(formatSource)"]
        if let from = clampedFrom, let to = clampedTo, from != to {
            parts.append("clamp=\(from)->\(to)")
        }
        parts.append("keys=[\(emittedKeys.sorted().joined(separator: ","))]")
        // [T-thinking-vision-diag] Only printed when a gate fired, so the common
        // unimpeded case stays exactly as terse as it was before.
        if !gateEvents.isEmpty {
            parts.append("gates=[\(gateEvents.map(\.logFragment).joined(separator: " "))]")
        }
        return parts.joined(separator: " ")
    }
}

/// Data-driven replacement for the thinking-parameter if-return chain.
///
/// SCOPE — read before extending:
///   • Covers the OpenAI-compatible family only (everything routed through
///     `OpenAIAgentProvider`). Gemini and Anthropic keep their own per-request emitters.
///   • Pure: no store, no network, no `LLMModel` — everything arrives in
///     `ThinkingResolveContext`, so the logic tests compile this file directly.
///   • [Leo] Catalog effort tiers are honoured ONLY when the declaration is
///     authoritative for this endpoint (`effortDeclarationIsAuthoritative`). A custom
///     relay resolves its tiers through a cross-provider vote; using that guess to clamp
///     or suppress would change what a working relay receives, so non-authoritative
///     tiers are treated exactly like "the catalog says nothing" (pre-engine behaviour).
///   • Pinned by ThinkingWireGoldenSnapshotTests and ThinkingRulesRegressionTests.
///
/// EVALUATION MODEL (design §4): two stages.
///   Stage A — walk the rules top to bottom, first scope match wins, stop. Ordering is
///             therefore priority. Built-ins sort below user rules, and the
///             providerTypeDefault at the bottom has `.allModels` scope so a match is
///             guaranteed and stage A can never fall through.
///   Stage B — a matched rule that leaves `wireFormat` nil defers to the fallback chain
///             (model self-declaration, then the format default). Kept separate from
///             stage A on purpose: cross-rule field merging would make "why did this
///             value come from there" unanswerable in a trace.
enum ThinkingRuleResolver {

    // MARK: - Built-in registry

    /// The vendor rules, in priority order. Each entry names the evidence it encodes.
    ///
    /// Order matters and is not alphabetical — the most specific predicate must be
    /// consulted first. Mistral leads because its rule is a total prohibition that
    /// outranks every shape below it.
    static func builtInRules(for ctx: ThinkingResolveContext) -> [ThinkingRule] {
        var rules: [ThinkingRule] = []

        // Mistral — OpenMinis#87 / 4592ca9b / 29065ca0. Total prohibition: the request
        // rejects `reasoning` (422 extra_forbidden) and AssistantMessage is a closed
        // schema that rejects `reasoning_content`. Must outrank everything.
        if ctx.isMistral {
            rules.append(ThinkingRule(
                kind: .officialVendor,
                scope: .allModels,
                wireFormat: .omitEverything,
                reasoningEcho: ReasoningEchoPolicy(fieldName: "reasoning_content", timing: .never),
                label: "mistral-official"
            ))
        }

        // Cerebras — OpenMinis#361. Endpoint-scoped, and it must sit ABOVE the
        // `*qwen*` rule further down: stage A stops at the first scope match,
        // and Cerebras re-hosts `qwen-3.8-27b`, which would otherwise be handed
        // Qwen's native `enable_thinking` (a field Cerebras does not accept).
        // Their documented control is root `reasoning_effort` — and the bundled
        // models-dev catalog already declares exactly that for both Cerebras
        // models (`gpt-oss-120b`, `qwen-3.8-27b`), so this rule makes the app
        // agree with data it already ships rather than inventing a shape.
        //
        // This is the same class of fix as [T-ios-qwen-extra-body-400], which
        // split the qwen rule by endpoint after a strict relay rejected
        // `extra_body`: a model-NAME pattern cannot answer a question about the
        // ENDPOINT, so the endpoint gets its own rule above it.
        //
        // ORDER: registered here (after Mistral, before OpenRouter) as a NEW
        // rule — no existing rule is moved. The note below about order being
        // load-bearing describes a real regression caused by hoisting an
        // existing rule; adding a narrowly-scoped one that only exists when
        // `ctx.isCerebras` leaves every other endpoint's resolution untouched.
        //
        // `reasoningEcho: .never` records the intent and matches Mistral's
        // entry. Note it is NOT what suppresses the echo today — no consumer
        // reads the policy yet; `OpenAIAgentProvider`'s `forbidReasoningField`
        // does that. Written here so the rule states the whole contract, and so
        // it starts working for free if/when the policy is wired up.
        if ctx.isCerebras {
            rules.append(ThinkingRule(
                kind: .officialVendor,
                scope: .allModels,
                wireFormat: .reasoningEffort(offValue: ctx.offEffort),
                reasoningEcho: ReasoningEchoPolicy(fieldName: "reasoning_content", timing: .never),
                label: "cerebras-official"
            ))
        }

        // OpenRouter — nested `reasoning:{effort}`, and OMIT when off so
        // forced-reasoning backends don't reject `effort:"none"`.
        if ctx.isOpenRouter {
            rules.append(ThinkingRule(
                kind: .officialVendor,
                scope: .allModels,
                wireFormat: .reasoningEffortNested(offValue: nil),
                label: "openrouter"
            ))
        }

        // ORDER IS LOAD-BEARING FROM HERE DOWN. It reproduces the pre-refactor
        // if-return chain's evaluation order exactly, which was:
        //     OpenRouter → OpenAI-native (o*/gpt-*) → qwen → deepseek-v4 (unified-guarded)
        //     → self-reasoning skip → generic fallback
        //
        // [T-thinking-rules-phase1] The first version of this registry hoisted the
        // unified-gateway rule ABOVE qwen and the OpenAI-native patterns, which silently
        // changed two real cases: a qwen id on Ark/Azure/Venice stopped emitting
        // `enable_thinking`+`thinking_budget` and started emitting `reasoning_effort`,
        // and (on Android, mirrored) a gpt-5 id on DashScope flipped the other way. That
        // is a user-visible silent-degradation regression of exactly the kind this whole
        // design exists to prevent. The old chain applied the unified guard ONLY to
        // deepseek-v4 — qwen and the OpenAI-native ids never consulted it — so the
        // gateway rule must sit BELOW them, not above.
        //
        // The golden snapshot did not catch it because every matrix row varied a single
        // dimension; the cross-product rows (qwen×unified, gpt5×dashscope, mimo×unified)
        // were added alongside this fix.

        // OpenAI native o-series / GPT-5.x / GPT-4.x — root reasoning_effort. Ahead of
        // the gateway rule because the old chain checked these prefixes first and never
        // consulted `unifiedReasoningEffort` on this path.
        rules.append(ThinkingRule(
            kind: .officialVendor,
            scope: .modelPattern("o1*"),
            wireFormat: .reasoningEffort(offValue: ctx.offEffort),
            label: "openai-native"
        ))
        rules.append(ThinkingRule(kind: .officialVendor, scope: .modelPattern("o3*"),
                                  wireFormat: .reasoningEffort(offValue: ctx.offEffort), label: "openai-native"))
        rules.append(ThinkingRule(kind: .officialVendor, scope: .modelPattern("o4*"),
                                  wireFormat: .reasoningEffort(offValue: ctx.offEffort), label: "openai-native"))
        rules.append(ThinkingRule(kind: .officialVendor, scope: .modelPattern("gpt-5*"),
                                  wireFormat: .reasoningEffort(offValue: ctx.offEffort), label: "openai-native"))
        rules.append(ThinkingRule(kind: .officialVendor, scope: .modelPattern("gpt-4*"),
                                  wireFormat: .reasoningEffort(offValue: ctx.offEffort), label: "openai-native"))

        // Qwen / DashScope — dual-send + strict budget inequality (25165700, a5a0de20).
        // Also ahead of the gateway rule: the old qwen branch carried no unified guard,
        // so a qwen model keeps its native enable_thinking mechanism even when the
        // endpoint is Ark/Azure/Venice.
        //
        // [T-ios-qwen-extra-body-400] Split by ENDPOINT, because this scope matches on the
        // model NAME alone and a qwen-named model is served by plenty of things that are
        // not DashScope. The `extra_body` envelope is DashScope-specific; a strict-schema
        // relay answers `400 UNKNOWN_FIELD: 未知请求字段：extra_body` and the whole request
        // fails (reproduced on tokenrhythm.studio with qwen3.8-max / qwen3.7-max, where
        // the same endpoint serves deepseek models fine — the trigger is the model name,
        // not the gateway).
        //
        // The gate lives HERE, at registration, and never inside the `.qwenDual` emitter:
        // that shape is user-selectable in the rule editor, so rewriting it at emit time
        // would silently contradict a choice the user made explicitly and can see.
        rules.append(ThinkingRule(
            kind: .officialVendor,
            scope: .modelPattern("*qwen*"),
            wireFormat: ctx.isDashScope ? .qwenDual : .qwenRootOnly,
            label: ctx.isDashScope ? "qwen-dashscope" : "qwen-root-only"
        ))

        // Unified gateways (Volcengine Ark / Azure / Venice) — ba055121 + 84f5c9e1.
        // These re-host third-party families behind one OpenAI surface where thinking is
        // controlled ONLY by root `reasoning_effort`; the vendor-native `thinking:{}`
        // object is not honoured, and on Venice an unknown root key is a hard 400.
        // Registered as ONE concept rather than three flags so they cannot drift apart.
        //
        // Placed AFTER the OpenAI-native and qwen patterns so it claims exactly what the
        // old chain's `!unifiedReasoningEffort` guard claimed — the deepseek-v4 branch
        // and the self-reasoning families below — and nothing more.
        if ctx.usesUnifiedReasoningEffort {
            rules.append(ThinkingRule(
                kind: .officialVendor,
                scope: .allModels,
                wireFormat: .reasoningEffort(offValue: ctx.offEffort),
                label: "unified-gateway(ark|azure|venice)"
            ))
        }

        // DeepSeek V4 vendor-native sibling shape (847822eb). Only when NOT on a unified
        // gateway — the gateway rule above already claimed those.
        rules.append(ThinkingRule(
            kind: .officialVendor,
            scope: .modelPattern("*deepseek-v4*"),
            wireFormat: .deepSeekSibling,
            reasoningEcho: ReasoningEchoPolicy(fieldName: "reasoning_content", timing: .afterToolUseOnly),
            label: "deepseek-v4-official"
        ))
        // [T-deepseek-flash-scope] GH#356. DeepSeek now recommends the bare
        // `deepseek-flash`; `deepseek-v4-flash` is kept only as a legacy alias
        // and both are served by the same DeepSeek-V4.1-Flash. The pattern
        // above needs the literal "deepseek-v4", so the new id matched NOTHING
        // and fell through to the generic `reasoning_effort` default — the
        // wrong wire shape for this vendor.
        //
        // `ThinkingRule.scope` is a single pattern with no OR, and the house
        // style is to register a sibling rule rather than widen one; this one
        // carries the same wireFormat / echo policy / label family as its
        // neighbour so the two are obviously one decision.
        //
        // `deepseek-flash*` rather than `*deepseek-flash*` or `*deepseek*`:
        // anchored at the start it still picks up future sub-variants like
        // `deepseek-flash-lite`, without claiming a future DeepSeek model whose
        // wire format may differ (`deepseek-chat`, `deepseek-reasoner` and
        // `deepseek-v4-pro` all correctly stay out — verified against the glob
        // implementation, not assumed).
        rules.append(ThinkingRule(
            kind: .officialVendor,
            scope: .modelPattern("deepseek-flash*"),
            wireFormat: .deepSeekSibling,
            reasoningEcho: ReasoningEchoPolicy(fieldName: "reasoning_content", timing: .afterToolUseOnly),
            label: "deepseek-flash-official"
        ))

        // Fallback for the providerType: generic root reasoning_effort, subject to the
        // self-reasoning skip in stage B. `.allModels` guarantees stage A always matches.
        rules.append(ThinkingRule(
            kind: .providerTypeDefault,
            scope: .allModels,
            wireFormat: .reasoningEffort(offValue: ctx.offEffort),
            label: "openai-compatible-default"
        ))

        return rules
    }

    // MARK: - Resolution

    /// Resolve and apply the thinking parameters for one request.
    ///
    /// Returns the trace so the caller can log it; the body is mutated in place to keep
    /// the call site identical to the function this replaced.
    static func apply(to body: inout [String: Any], ctx: ThinkingResolveContext) -> ThinkingResolveTrace {
        let before = Set(body.keys)

        // ---- Stage A: first-match-wins -------------------------------------------
        // [T-thinking-rules-phase2] User rules first, built-ins after. Ordering IS
        // priority (design §4.3), so a custom rule shadows any built-in it precedes, and
        // the built-in providerTypeDefault at the very bottom (scope .allModels)
        // guarantees stage A can never fall through no matter what the user configures.
        let rules = ctx.userRules.filter { $0.wireFormat != nil } + builtInRules(for: ctx)
        // The providerTypeDefault has .allModels scope, so this cannot be nil. `first`
        // rather than a forced unwrap keeps a future registry edit from crashing.
        guard let winner = rules.first(where: { $0.matches(ctx.modelId) }) else {
            return ThinkingResolveTrace(
                matchedRuleLabel: "none", matchedRuleKind: .providerTypeDefault,
                formatSource: "no-match", wireFormat: nil, emittedKeys: [],
                clampedFrom: nil, clampedTo: nil
            )
        }

        // ---- Stage B: fill in what the rule left unspecified ----------------------
        var formatSource = "rule"
        var format = winner.wireFormat
        if format == nil {
            format = .reasoningEffort(offValue: ctx.offEffort)
            formatSource = "providerTypeDefault"
        }

        var clampedFrom: String?
        var clampedTo: String?
        var gateEvents: [ThinkingGateEvent] = []

        if let format {
            let clamp = emit(format: format, ctx: ctx, into: &body, gateEvents: &gateEvents)
            clampedFrom = clamp.from
            clampedTo = clamp.to
        }

        let emitted = Array(Set(body.keys).subtracting(before))
        return ThinkingResolveTrace(
            matchedRuleLabel: winner.label,
            matchedRuleKind: winner.kind,
            formatSource: formatSource,
            wireFormat: format,
            emittedKeys: emitted,
            clampedFrom: clampedFrom,
            clampedTo: clampedTo,
            gateEvents: gateEvents
        )
    }

    // MARK: - Emission

    /// Write the fields for one wire format. Each branch reproduces the corresponding
    /// branch of the pre-refactor chain exactly — including its guards, which are the
    /// part that carries the field evidence.
    /// [T-thinking-vision-diag] `gateEvents` is an OUT parameter only — every condition
    /// below is unchanged, and nothing in this function reads what has been appended. The
    /// gates were always here; this records which of them fired so the answer stops
    /// requiring a rebuild to obtain.
    private static func emit(
        format: ThinkingWireFormat,
        ctx: ThinkingResolveContext,
        into body: inout [String: Any],
        gateEvents: inout [ThinkingGateEvent]
    ) -> (from: String?, to: String?) {

        // [T-thinking-off-explicit] Strict-enum families never receive an off tier:
        // sending "minimal" to MiMo/Agnes killed the whole request (c5efeb1e). Applied
        // before every branch, exactly as the original did at the top of the function.
        let lid = ctx.modelId.lowercased()
        let strictEffortEnum = lid.contains("mimo") || lid.contains("agnes")
        // [T-vision-thinking-off-400] Forced-reasoning families reject an OFF tier
        // outright rather than ignoring it. Field evidence: a MiniMax M3 relay
        // answered a thinking-off vision request with
        //   400 invalid params, invalid thinking.type: "none" (allowed: adaptive, disabled)
        // The app never writes `thinking.type` on this path — the relay translates our
        // root `reasoning_effort` into its own vendor shape, so an off tier we consider
        // harmless becomes an illegal enum value one hop downstream.
        //
        // The existing `deepseek/glm/kimi/minimax` skip below does NOT cover this: it is
        // gated on `!declaresEffort`, and the catalog DOES declare effort tiers for
        // several of these ids (e.g. fireworks' minimax-m3 publishes
        // `reasoning_options:[{type:"effort",values:[low,medium,high]}]`).
        //
        // But the family name alone is NOT the right predicate, and the first version of
        // this guard got that wrong: it suppressed the off tier for every
        // deepseek/glm/kimi/minimax id, which silently took away the user's ability to
        // turn thinking OFF on the 161 catalog entries (of 353 tier-declaring matches)
        // that explicitly publish an off value — greenpt's glm-5.2 / kimi-k3 /
        // minimax-m2.5 list `["none","minimal","low","medium","high"]`, baseten's
        // GLM-5.2 lists `["none","high","max"]`, and so on. Suppressing an off tier a
        // vendor documents is a worse failure than the 400 it was meant to prevent: the
        // 400 is loud, this would be silent.
        //
        // The catalog already answers the real question, so ask it directly: withhold the
        // off tier only when the model declares tiers and NONE of them is an off value.
        // That covers the reported MiniMax M3 case (`[low,medium,high]` — no off tier, so
        // "none" was never legal there) while leaving every model that documents an off
        // tier able to honour it. Models declaring no tiers at all are untouched here —
        // the pre-existing `!declaresEffort` skip below still owns them.
        //
        // Scoped to the OFF direction only: enabled tiers still flow normally, so this
        // cannot change any request where the user actually asked for thinking.
        //
        // [T-thinking-off-custom-provider] And scoped to AUTHORITATIVE declarations only.
        // A user-defined OpenAI-compatible relay is not in the catalog under its own
        // name, so its effort tiers come from the cross-provider fallback scan — "some
        // other publisher serving a model with this bare id". That is fine for clamping a
        // tier the user asked for (worst case the request is a notch weaker), but it is
        // not evidence about THIS endpoint, so it must never be used to override an
        // explicit "thinking off". Silently ignoring the user's own toggle because a
        // different vendor's registration says so is precisely the failure mode this
        // whole guard was introduced to avoid, just pointed at a different victim.
        //
        // Unknown/custom endpoints therefore keep the pre-fix pass-through behaviour: we
        // send what the user asked for and let the vendor answer for itself. If some
        // relay does 400 on it, that is a visible, attributable error about the user's
        // own configuration — strictly better than a toggle that does nothing.
        // [Leo] Only an authoritative declaration describes THIS endpoint.
        let tiers: [String]? = ctx.effortDeclarationIsAuthoritative ? ctx.declaredEffortValues : nil
        let declaredTiers = tiers.map { Set($0.map { $0.lowercased() }) }
        let offTierNotDeclared: Bool = {
            guard ctx.effortDeclarationIsAuthoritative else { return false }
            guard let tiers = declaredTiers, !tiers.isEmpty else { return false }
            return tiers.isDisjoint(with: ["none", "off", "minimal", "disabled"])
        }()
        let offEffort = (strictEffortEnum || offTierNotDeclared) ? nil : ctx.offEffort

        // [T-thinking-vision-diag] Record G1/G2 attribution. Both only matter when an off
        // tier was actually on the table, so an enabled level (or a nil ctx.offEffort)
        // records nothing — otherwise every ordinary request would carry a gate line that
        // changed no outcome. Recorded independently because they can BOTH be true, and
        // "which one suppressed it" is exactly the question that cost three rounds.
        if ctx.offEffort != nil, !ctx.level.isEnabled {
            if strictEffortEnum {
                gateEvents.append(ThinkingGateEvent(
                    id: "strict-effort-enum", evidence: .modelFamily, verdict: "suppressOffTier"))
            }
            if offTierNotDeclared {
                gateEvents.append(ThinkingGateEvent(
                    id: "off-tier-not-declared", evidence: .catalogAuthoritative,
                    verdict: "suppressOffTier"))
            }
        }

        switch format {
        case .omitEverything:
            return (nil, nil)

        case .reasoningEffortNested:
            // OpenRouter: omit entirely when off.
            guard ctx.level.isEnabled else { return (nil, nil) }
            let effort = Self.wireEffort(for: ctx.level)
            body["reasoning"] = ["effort": effort]
            return (effort, effort)

        case .reasoningEffort:
            // Two sub-shapes share this case, matching the original chain:
            //  • OpenAI-native ids (o*/gpt-*) use `reasoningEffort(for:level:)`, which is
            //    NOT clamped onto the declared set.
            //  • everything else goes through the generic fallback, which IS clamped.
            let isOpenAINative = lid.hasPrefix("o1") || lid.hasPrefix("o3") || lid.hasPrefix("o4")
                || lid.hasPrefix("gpt-5") || lid.hasPrefix("gpt-4")
            if isOpenAINative {
                if let effort = Self.nativeEffort(supportsReasoning: ctx.supportsReasoning, level: ctx.level) {
                    body["reasoning_effort"] = effort
                    return (effort, effort)
                } else if !ctx.level.isEnabled, let offEffort, ctx.supportsReasoning ?? false {
                    body["reasoning_effort"] = offEffort
                    return (offEffort, offEffort)
                }
                return (nil, nil)
            }

            // Generic path. The legacy self-reasoning skip stays keyed on "declares
            // nothing" rather than on family name — 22647505 replaced the id-substring
            // skip-list after GLM behind a relay silently received no thinking field.
            let declaresEffort = !(tiers?.isEmpty ?? true)
            if !ctx.usesUnifiedReasoningEffort, !declaresEffort,
               ["deepseek", "glm", "kimi", "minimax"].contains(where: { lid.contains($0) }) {
                gateEvents.append(ThinkingGateEvent(
                    id: "self-reasoning-family", evidence: .modelFamily, verdict: "emitNothing"))
                return (nil, nil)
            }
            // [OpenMinis#163] xAI-scoped skip. grok-build-0.1 answers
            // `reasoning_effort` with "HTTP 400: Model grok-build-0.1 does not
            // support parameter reasoningEffort"; the catalog describes exactly
            // that state as `"reasoning": true` with `"reasoning_options": []`
            // (also true of grok-4.20-0309-reasoning).
            //
            // DELIBERATELY NOT data-driven across all vendors. The same
            // empty-tier shape appears on 1292 catalog entries — relay-hosted
            // Claude, GPT-5, Qwen and others — and honouring it everywhere
            // would change the wire format for all of them in one go. Omitting
            // the field is arguably more correct for those too (Anthropic uses
            // `thinking.budget_tokens`, not effort), but none of those routes
            // has been verified, so the skip stays at the vendor where the 400
            // was actually observed. Widening it later is a one-line change to
            // this condition, backed by whatever new evidence justifies it.
            //
            // Ordered AFTER the family list on purpose: that list keys on
            // "declares nothing" and must keep firing for relay-hosted
            // deepseek/glm/kimi/minimax ids the catalog is silent about.
            // Unified-effort gateways are exempt for the same reason as above —
            // they normalize the field and own their model list.
            if ctx.isXAI, !ctx.usesUnifiedReasoningEffort,
               ctx.declaresNoEffortTiers, !declaresEffort {
                gateEvents.append(ThinkingGateEvent(
                    id: "xai-no-effort-tiers", evidence: .endpointIdentity, verdict: "emitNothing"))
                return (nil, nil)
            }
            guard ctx.supportsReasoning != false else {
                gateEvents.append(ThinkingGateEvent(
                    id: "non-reasoning-model", evidence: .modelCapability, verdict: "emitNothing"))
                return (nil, nil)
            }
            if !ctx.level.isEnabled {
                // Deliberately NOT clamped: clampEffort walks UP when nothing at or below
                // is declared, so a ["high","max"] model would turn an OFF request into
                // "high" — inverting the user's intent.
                if let offEffort, tiers?.contains(offEffort) ?? true {
                    body["reasoning_effort"] = offEffort
                    return (offEffort, offEffort)
                }
                // [T-thinking-vision-diag] Distinguish the two ways an off tier can vanish
                // here. If G1/G2 already nil'd `offEffort` they logged their own reason and
                // this is just the consequence; only the SURVIVING case — an off value the
                // model simply does not declare — is a separate finding worth recording.
                if ctx.offEffort != nil, offEffort != nil {
                    gateEvents.append(ThinkingGateEvent(
                        id: "off-tier-not-in-declared-set", evidence: .catalogHeuristic,
                        verdict: "suppressOffTier"))
                }
                return (nil, nil)
            }
            let requested = Self.wireEffort(for: ctx.level)
            let clamped = Self.clampEffort(requested, to: tiers)
            body["reasoning_effort"] = clamped
            return (requested, clamped)

        case .deepSeekSibling:
            if ctx.level.isEnabled {
                let requested = Self.wireEffort(for: ctx.level)
                // DeepSeek's documented ladder is ["high","max"]; it is the vendor's own
                // contract for this wire shape, so it applies even without a catalog hit.
                let clamped = Self.clampEffort(requested, to: tiers ?? Self.deepSeekLadder)
                body["thinking"] = ["type": "enabled"]
                body["reasoning_effort"] = clamped
                return (requested, clamped)
            }
            body["thinking"] = ["type": "disabled"]
            return (nil, nil)

        case .qwenDual:
            let enabled = ctx.level.isEnabled
            let budget = Self.qwenThinkingBudget(for: ctx)
            body["enable_thinking"] = enabled
            if budget > 0 { body["thinking_budget"] = budget }
            body["extra_body"] = [
                "enable_thinking": enabled,
                "thinking_budget": budget > 0 ? budget : NSNull(),
            ] as [String: Any]
            return (nil, nil)

        case .qwenRootOnly:
            // [T-ios-qwen-extra-body-400] `enable_thinking` ONLY — no `extra_body`
            // envelope and no `thinking_budget`. Device probing against a real
            // relay showed it accepts `enable_thinking` but 400s on
            // `thinking_budget` just as it does on `extra_body`; see the
            // wire-format doc comment for the per-field measurements.
            body["enable_thinking"] = ctx.level.isEnabled
            return (nil, nil)

        case .booleanToggle(let path):
            // [T-thinking-rules-phase2] A plain on/off switch with no tiers. Written at a
            // dotted path so `thinking` and `extra.thinking` are the same code path.
            // OFF still writes `false` rather than omitting: a vendor whose switch we are
            // explicitly modelling defaults to ON when the key is absent (the DeepSeek V4
            // /  Qwen3 lesson), so silence is not the same as "off".
            setValue(true, at: path, in: &body, when: ctx.level.isEnabled, otherwiseWrite: false)
            return (nil, nil)

        case .extraBodyToggle(let path):
            // Same shape, but conventionally nested under extra_body. Kept as its own case
            // because that is how users think about it (GH OpenMinis#171: DeepSeek's real
            // switch is extra_body.thinking.enabled and Minis never sent it).
            setValue(true, at: path, in: &body, when: ctx.level.isEnabled, otherwiseWrite: false)
            return (nil, nil)

        case .customPath(let path, let values, let offValue):
            // The escape hatch (design §5.1). Deliberately limited to "write this value at
            // this dotted path" — no JSONPath, no templates — so every rule stays
            // statically checkable and explainable in a trace.
            if ctx.level.isEnabled {
                guard let v = values[ctx.level] ?? values[.high] else { return (nil, nil) }
                setValue(v, at: path, in: &body, when: true, otherwiseWrite: nil)
                return (v, v)
            }
            guard let off = offValue else { return (nil, nil) }
            setValue(off, at: path, in: &body, when: true, otherwiseWrite: nil)
            return (off, off)

        case .anthropicThinking, .geminiBudget, .geminiThinkingLevel:
            // Declared for vocabulary completeness, never emitted on the OpenAI path. A
            // persisted rule naming one sends nothing rather than a wrong shape.
            return (nil, nil)
        }
    }

    /// [T-ios-qwen-extra-body-400] The Qwen thinking budget for this level, already
    /// clamped against `maxTokens`.
    ///
    /// Shared by `.qwenDual` and `.qwenRootOnly` so the two shapes cannot drift on the
    /// inequality rule: the budget must be STRICTLY below `max_completion_tokens` —
    /// equal values are rejected too ("[16384] must be greater than [16384]",
    /// issues #35/#641) — and the ceiling varies per model, so it is computed relative
    /// to maxTokens rather than against a fixed threshold (a5a0de20).
    private static func qwenThinkingBudget(for ctx: ThinkingResolveContext) -> Int {
        var budget: Int = switch ctx.level {
        case .off: 0
        case .low: 4096
        case .medium: 16384
        case .high: 32768
        case .xhigh, .max, .ultra: 65536
        }
        guard budget > 0, ctx.maxTokens > 0 else { return budget }
        if ctx.maxTokens < 2 { return 0 }
        let margin = max(2048, ctx.maxTokens / 8)
        let ceiling = max(1, min(ctx.maxTokens - margin, ctx.maxTokens - 1))
        if budget >= ceiling { budget = ceiling }
        return budget
    }

    /// Write `value` at a dotted `path` inside `body`, creating intermediate objects.
    ///
    /// `when == false` writes `otherwiseWrite` instead, or nothing when that is nil — the
    /// distinction between "send false" and "send nothing at all", which is load-bearing
    /// for vendors whose switch defaults to ON when the key is absent.
    ///
    /// Nesting is done by rebuilding the dictionaries on the way out rather than mutating
    /// in place, because `[String: Any]` is a value type and a naive in-place write to a
    /// nested dictionary silently updates a COPY.
    private static func setValue(
        _ value: Any,
        at path: String,
        in body: inout [String: Any],
        when condition: Bool,
        otherwiseWrite fallback: Any?
    ) {
        let toWrite: Any? = condition ? value : fallback
        guard let toWrite else { return }
        let parts = path.split(separator: ".").map(String.init)
        guard !parts.isEmpty else { return }
        body = Self.inserting(toWrite, parts: parts, into: body)
    }

    private static func inserting(_ value: Any, parts: [String], into dict: [String: Any]) -> [String: Any] {
        var out = dict
        guard let head = parts.first else { return out }
        if parts.count == 1 {
            out[head] = value
            return out
        }
        let child = out[head] as? [String: Any] ?? [:]
        out[head] = Self.inserting(value, parts: Array(parts.dropFirst()), into: child)
        return out
    }


    // MARK: - Effort vocabulary

    /// DeepSeek V4's documented `reasoning_effort` tiers.
    static let deepSeekLadder = ["high", "max"]

    /// [T-thinking-levels-data-driven] The wire effort string for a UI level, before any
    /// per-model clamp. `.off` maps to "low" so callers can use it unconditionally — every
    /// caller guards on `level.isEnabled`. [T-ios-ultra-effort-clamp] `.ultra` is a
    /// client-side orchestration concept; on the wire it tops out at "max".
    static func wireEffort(for level: ThinkingLevel) -> String {
        switch level {
        case .off, .low: "low"
        case .medium: "medium"
        case .high: "high"
        case .xhigh: "xhigh"
        case .max, .ultra: "max"
        }
    }

    /// OpenAI-native effort (o-series / gpt-4/5): only for a model that affirmatively
    /// reasons, never for OFF (the OFF value is chosen by `explicitOffEffort`).
    static func nativeEffort(supportsReasoning: Bool?, level: ThinkingLevel) -> String? {
        guard supportsReasoning ?? false, level.isEnabled else { return nil }
        return wireEffort(for: level)
    }

    /// [T-reasoning-effort-data-driven] Snap an effort onto the declared tiers: nearest
    /// tier at or below the request, else the lowest declared one. `values == nil`
    /// passes the string through untouched.
    static func clampEffort(_ effort: String, to values: [String]?) -> String {
        guard let values, !values.isEmpty else { return effort }
        if values.contains(effort) { return effort }
        let ladder = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
        guard let want = ladder.firstIndex(of: effort) else { return effort }
        let declared = values.compactMap { v in ladder.firstIndex(of: v).map { ($0, v) } }
            .sorted { $0.0 < $1.0 }
        guard !declared.isEmpty else { return effort }
        if let below = declared.last(where: { $0.0 <= want }) { return below.1 }
        return declared[0].1
    }
}
