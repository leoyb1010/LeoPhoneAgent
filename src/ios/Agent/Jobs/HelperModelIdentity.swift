// Ported from upstream iOS 1.14 (OpenMinis) — pure part; app-coupled
// construction lives in ModelTierResolver.swift.
import Foundation

// [T-agent-model-identity] Which model an agent (helper / child session) is
// running on, kept as THREE distinct facts that must never be conflated:
//
//   1. origin    — [T-sub-agents-v1] "pinned" (the sub agent definition names a
//                  Model Group) or "inherited" (it runs on the parent
//                  conversation's binding). Replaces the old requested/used
//                  tier pair: the delegating model no longer picks a tier, so
//                  there is nothing to compare a request against.
//   1b. legacy tier — `tierRequested`/`tierUsed` are what the delegating model asked for
//                  (`model_tier: primary|sub`); `tierUsed` is what actually
//                  ran (a `sub` request degrades to `primary` when no Sub
//                  group is usable — ModelTierResolver).
//   2. resolved  — the configured entry ModelTierResolver picked for the
//                  child's binding: provider instance label + user-readable
//                  model name (e.g. "Anthropic (53) · Claude Sonnet 5").
//                  Known the moment the child is created.
//   3. effective — what the child's requests REALLY ran on. Two sources,
//                  both from the live run, never copied from `resolved`:
//                    · request side: the entry the send loop's
//                      `activeEntryId` pointed at when a turn was served
//                      (group fallback moves it) → `effectiveEntryId`,
//                      `effectiveModelId` (the id written into the body);
//                    · response side: the model name the API REPORTED
//                      (`message.model`, chunk `model`, `modelVersion`) →
//                      `responseModel`.
//                  `effectiveSource` says which of the two the displayed
//                  effective value comes from; nil = nothing confirmed yet.
//
// One value type travels everywhere: the AgentJob (live), the parent's
// delegate_task block (UI), the tool_result JSON payload (persisted, what a
// reload / app restart reads back), the `<agent_callback>` attributes (what
// a background completion or a scheduled child hands the parent), and the
// debug / agent_status projections.
struct HelperModelIdentity: Equatable, Codable {
    // 1. tier
    /// [T-sub-agents-v1] Legacy: only ever set on payloads written before sub
    /// agents replaced the tier mechanism. Read so old transcripts still render;
    /// never written by current code.
    var tierRequested: String?
    var tierUsed: String?
    /// [T-sub-agents-v1] "pinned" / "inherited". The current field.
    var modelOrigin: String?
    // 2. resolved (ModelTierResolver)
    var resolvedEntryId: String?
    var resolvedProviderLabel: String?
    var resolvedProviderType: String?
    var resolvedModelId: String?
    var resolvedModelName: String?
    // 3. effective — request side
    var effectiveEntryId: String?
    var effectiveProviderLabel: String?
    var effectiveProviderType: String?
    var effectiveModelId: String?
    var effectiveModelName: String?
    // 3. effective — response side
    var responseModel: String?
    /// "response" | "request" | nil (not confirmed yet / never reported).
    var effectiveSource: String?
    // 4. honesty
    /// [T-subagent-ui-honesty] True when the sub agent PINNED a model group
    /// that could not be routed, so the run fell back to inheriting the
    /// parent's model. The resolver has always computed this and the result
    /// JSON has always carried it as `model_group_unavailable`; it stops here
    /// so the card can say the pin did not apply. Without it the card printed
    /// only the model name, and an ignored pin was indistinguishable from a
    /// working one.
    var modelGroupUnavailable: Bool = false
    /// [T-subagent-model-strategy] Name of the Model Group the strategy chose
    /// (a pinned group, or the user's Default / Sub group). nil when the child
    /// simply inherited the conversation's model, which names no group. Shown
    /// so "Default 分组" reads as the group the user actually configured
    /// rather than an opaque internal label.
    var modelGroupName: String?

    init(tierRequested: String? = nil, tierUsed: String? = nil, modelOrigin: String? = nil) {
        self.tierRequested = tierRequested
        self.tierUsed = tierUsed
        self.modelOrigin = modelOrigin
    }

    // MARK: - Derived views

    /// "Anthropic (53) · Claude Sonnet 5" — provider instance label + model
    /// display name; falls back to whichever half is known.
    var resolvedLabel: String? {
        Self.joinLabel(provider: resolvedProviderLabel, model: resolvedModelName ?? resolvedModelId)
    }

    /// The effective model as ONE id-like string: the API-reported name when
    /// the response carried one, else the request-side model id, else nil.
    var effectiveModel: String? {
        if let r = responseModel, !r.isEmpty { return r }
        if let m = effectiveModelId, !m.isEmpty { return m }
        return nil
    }

    /// Provider label + display name of the effective entry (request side) —
    /// what a Provider fallback shows in the detail card.
    var effectiveLabel: String? {
        Self.joinLabel(provider: effectiveProviderLabel, model: effectiveModelName ?? effectiveModelId)
    }

    /// True when the tier the run used differs from the one requested.
    var tierDegraded: Bool {
        guard let r = tierRequested, let u = tierUsed else { return false }
        return r != u
    }

    /// True when the run served turns on a different configured entry than
    /// the resolver picked (group fallback / provider fallback).
    var entryFellBack: Bool {
        guard let r = resolvedEntryId, let e = effectiveEntryId else { return false }
        return r != e
    }

    /// True when a confirmed effective model is, after normalisation, the
    /// same model the resolver picked — the "no surprise" case the compact
    /// surfaces collapse into one name.
    var effectiveMatchesResolved: Bool {
        guard let e = effectiveModel, let r = resolvedModelId else { return false }
        return Self.normalizedModelId(e) == Self.normalizedModelId(r)
    }

    var hasEffective: Bool { effectiveModel != nil }

    // MARK: - Merging live facts

    /// Fold in what the child's send loop recorded for its latest turn.
    /// Request-side facts always update (fallback can move mid-run); the
    /// response-reported name is kept once seen unless a newer one arrives.
    mutating func merge(_ live: EffectiveModelRecord?) {
        guard let live else { return }
        if let eid = live.entryId, !eid.isEmpty {
            effectiveEntryId = eid
            effectiveProviderLabel = live.providerLabel
            effectiveProviderType = live.providerType
            effectiveModelId = live.modelId
            effectiveModelName = live.modelName
        }
        if let rm = live.responseModel, !rm.isEmpty {
            responseModel = rm
        }
        if responseModel != nil { effectiveSource = "response" }
        else if effectiveModelId != nil { effectiveSource = "request" }
    }

    // MARK: - JSON payload (tool_result / agent_status / debug)

    static let payloadKeys: [String] = [
        "tier_requested", "tier_used", "model_origin",
        "model_resolved", "model_resolved_entry_id", "model_resolved_provider", "model_resolved_provider_type",
        "model_resolved_id", "model_resolved_name",
        "model_effective", "model_effective_entry_id", "model_effective_provider", "model_effective_provider_type",
        "model_effective_id", "model_effective_name", "model_effective_source", "model_response",
        "model_group_unavailable",
    ]

    /// Snake_case keys, nil fields omitted. `model_resolved` / `model_effective`
    /// are the one-line human forms the model reads; the `_id` / `_entry_id`
    /// keys are what the UI re-derives fallback and equality from.
    func payload() -> [String: Any] {
        var d: [String: Any] = [:]
        func put(_ k: String, _ v: String?) { if let v, !v.isEmpty { d[k] = v } }
        put("tier_requested", tierRequested)
        put("tier_used", tierUsed)
        put("model_origin", modelOrigin)
        put("model_resolved", resolvedLabel)
        put("model_resolved_entry_id", resolvedEntryId)
        put("model_resolved_provider", resolvedProviderLabel)
        put("model_resolved_provider_type", resolvedProviderType)
        put("model_resolved_id", resolvedModelId)
        put("model_resolved_name", resolvedModelName)
        put("model_effective", effectiveModel)
        put("model_effective_entry_id", effectiveEntryId)
        put("model_effective_provider", effectiveProviderLabel)
        put("model_effective_provider_type", effectiveProviderType)
        put("model_effective_id", effectiveModelId)
        put("model_effective_name", effectiveModelName)
        put("model_effective_source", effectiveSource)
        put("model_response", responseModel)
        // Emitted only when true, matching HelperRunner's envelope: an
        // ordinary result stays byte-identical to before this feature.
        if modelGroupUnavailable { d["model_group_unavailable"] = true }
        put("model_group_name", modelGroupName)
        return d
    }

    /// nil when the payload carries none of the `model_*` identity keys (a
    /// pre-identity build's result, a rejection) — the tier keys alone are
    /// not an identity, every older payload has `tier_used`.
    init?(payload obj: [String: Any]) {
        func s(_ k: String) -> String? { (obj[k] as? String).flatMap { $0.isEmpty ? nil : $0 } }
        guard Self.payloadKeys.contains(where: { $0.hasPrefix("model_") && obj[$0] != nil }) else { return nil }
        tierRequested = s("tier_requested")
        tierUsed = s("tier_used")
        modelOrigin = s("model_origin")
        modelGroupName = s("model_group_name")
        if let b = obj["model_group_unavailable"] as? Bool {
            modelGroupUnavailable = b
        } else if let n = obj["model_group_unavailable"] as? NSNumber {
            modelGroupUnavailable = n.boolValue
        } else {
            modelGroupUnavailable = (s("model_group_unavailable")?.lowercased() == "true")
        }
        resolvedEntryId = s("model_resolved_entry_id")
        resolvedProviderLabel = s("model_resolved_provider")
        resolvedProviderType = s("model_resolved_provider_type")
        resolvedModelId = s("model_resolved_id")
        resolvedModelName = s("model_resolved_name")
        // A payload from a build that only wrote the one-line label.
        if resolvedModelName == nil, resolvedProviderLabel == nil, let line = s("model_resolved") {
            resolvedModelName = line
        }
        effectiveEntryId = s("model_effective_entry_id")
        effectiveProviderLabel = s("model_effective_provider")
        effectiveProviderType = s("model_effective_provider_type")
        effectiveModelId = s("model_effective_id")
        effectiveModelName = s("model_effective_name")
        responseModel = s("model_response")
        effectiveSource = s("model_effective_source")
        if effectiveModelId == nil, responseModel == nil, let line = s("model_effective") {
            // Older / minimal payload (callback attrs): the one-line value is
            // all we have; treat it as the effective id.
            effectiveModelId = line
            if effectiveSource == nil { effectiveSource = "request" }
        }
    }

    // MARK: - Compact text (inline block / thumbnail / nav bar)

    /// The short model text for one-line surfaces. Never nil once resolved:
    ///   · confirmed & same as resolved  → "Claude Sonnet 5 ✓"
    ///   · confirmed & different         → "Claude Sonnet 5 → claude-sonnet-5-2"
    ///   · not confirmed yet             → "Claude Sonnet 5"
    /// `maxModel` bounds each half (middle-ellipsised) so the status, tier
    /// and elapsed stay visible; the caller still applies lineLimit(1).
    func compactLine(maxModel: Int = 18) -> String? {
        let resolvedShort = Self.shortName(resolvedModelName ?? resolvedModelId ?? "", max: maxModel)
        guard let eff = effectiveModel else {
            return resolvedShort.isEmpty ? nil : resolvedShort
        }
        if resolvedShort.isEmpty { return Self.shortName(eff, max: maxModel) }
        if effectiveMatchesResolved { return resolvedShort + " ✓" }
        return resolvedShort + " → " + Self.shortName(eff, max: maxModel)
    }

    /// The tightest form for the 100×65 thumbnail: the effective model when
    /// confirmed, otherwise the resolved display name.
    func thumbnailLine(max: Int = 22) -> String? {
        if let eff = effectiveModel {
            if effectiveMatchesResolved, let name = resolvedModelName { return Self.shortName(name, max: max) }
            return Self.shortName(eff, max: max)
        }
        if let name = resolvedModelName ?? resolvedModelId { return Self.shortName(name, max: max) }
        return nil
    }

    // MARK: - Normalisation

    /// Lower-case, alphanumerics only, trailing 8-digit date snapshot
    /// dropped — so "claude-sonnet-5" and "Claude-Sonnet-5-20260101" compare
    /// equal while "gpt-5" and "gpt-5-mini" do not.
    static func normalizedModelId(_ s: String) -> String {
        var t = s.lowercased()
        if let slash = t.lastIndex(of: "/") { t = String(t[t.index(after: slash)...]) }
        if t.count > 9, t.suffix(8).allSatisfy(\.isNumber), t.dropLast(8).last == "-" {
            t = String(t.dropLast(9))
        }
        return t.filter { $0.isLetter || $0.isNumber }
    }

    /// [T-subagent-model-strategy] "Which model was this sub agent told to
    /// use" in the user's terms — the first of the card's two model lines.
    ///
    /// The strategy is a USER-LEVEL choice (Auto and its three intents, or a
    /// group the user pinned), so it is named that way rather than by the wire
    /// value the tool schema carries. A group-backed strategy appends the
    /// group's own name, since that is what the user configured and recognises.
    var strategyLabel: String? {
        guard let origin = modelOrigin else { return nil }
        let named: (String) -> String = { base in
            guard let g = self.modelGroupName, !g.isEmpty else { return base }
            return "\(base) · \(g)"
        }
        switch origin {
        case "pinned":
            return named(String(localized: "固定模型组"))
        case "inherited":
            return String(localized: "自动 · 与本对话相同")
        case "default_group":
            return named(String(localized: "自动 · 默认模型组"))
        case "sub_group":
            return named(String(localized: "自动 · 轻量模型组"))
        default:
            return origin
        }
    }

    /// The concrete model this sub agent actually ran on, as
    /// "Gemini 3.8 Flash (Google Gemini API)" — model first, because that is
    /// what the user is looking for; provider in parentheses to disambiguate
    /// the same model served by two different accounts.
    ///
    /// Prefers the entry that ACTUALLY served a turn (which group fallback may
    /// have moved) over the one the strategy resolved, so the line never claims
    /// a model that did not run.
    var actualModelLabel: String? {
        let name = effectiveModelName ?? resolvedModelName ?? effectiveModelId ?? resolvedModelId
        guard let name, !name.isEmpty else { return nil }
        let provider = effectiveProviderLabel ?? resolvedProviderLabel
        guard let provider, !provider.isEmpty else { return name }
        return "\(name)（\(provider)）"
    }

    static func shortName(_ s: String, max: Int) -> String {
        guard s.count > max, max >= 5 else { return s }
        let head = max / 2
        let tail = max - head - 1
        return String(s.prefix(head)) + "…" + String(s.suffix(tail))
    }

    private static func joinLabel(provider: String?, model: String?) -> String? {
        switch (provider?.isEmpty == false ? provider : nil, model?.isEmpty == false ? model : nil) {
        case (let p?, let m?): return "\(p) · \(m)"
        case (nil, let m?): return m
        case (let p?, nil): return p
        default: return nil
        }
    }
}

/// What one served turn of an agent loop ran on — recorded by the send loop
/// on the vm (`lastEffectiveModel`) so the parent's HelperRunner / registry
/// can read it without reaching into the loop. Request side is known the
/// moment the stream opens; `responseModel` arrives with the first response
/// event that names the model.
struct EffectiveModelRecord: Equatable {
    var entryId: String?
    var providerLabel: String?
    var providerType: String?
    var modelId: String?
    var modelName: String?
    var responseModel: String?
}
