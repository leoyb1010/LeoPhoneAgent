// Ported from upstream iOS 1.14 (OpenMinis) and adapted to LeoBot's sub agent port.
import XCTest

// [T-agent-model-identity] Locks the three-fact contract (tier / resolved /
// effective) on every path it travels through: the tool_result JSON payload,
// the <agent_callback> attributes, the parent block the UI parses, and the
// compact one-line formats the inline block / thumbnail / nav bar draw.
// None of this is verifiable from a screenshot — a lookalike string from the
// wrong fact would pass a visual check — so the semantics are pinned here.
final class HelperModelIdentityTests: XCTestCase {

    private func resolved() -> HelperModelIdentity {
        var id = HelperModelIdentity(tierRequested: "sub", tierUsed: "primary")
        id.resolvedEntryId = "inst-53/claude-sonnet-5"
        id.resolvedProviderLabel = "Anthropic (53)"
        id.resolvedProviderType = "anthropic"
        id.resolvedModelId = "claude-sonnet-5"
        id.resolvedModelName = "Claude Sonnet 5"
        return id
    }

    private func served(entry: String = "inst-53/claude-sonnet-5", model: String = "claude-sonnet-5",
                        name: String = "Claude Sonnet 5", provider: String = "Anthropic (53)",
                        response: String? = nil) -> EffectiveModelRecord {
        var r = EffectiveModelRecord()
        r.entryId = entry; r.modelId = model; r.modelName = name; r.providerLabel = provider
        r.responseModel = response
        return r
    }

    // MARK: Semantics

    func testResolvedIsNotCopiedIntoEffective() {
        let id = resolved()
        XCTAssertEqual(id.resolvedLabel, "Anthropic (53) · Claude Sonnet 5")
        XCTAssertNil(id.effectiveModel, "effective must stay unknown until a served turn is recorded")
        XCTAssertFalse(id.hasEffective)
        XCTAssertNil(id.effectiveSource)
        XCTAssertTrue(id.tierDegraded)
    }

    func testMergeRequestSideThenResponseSide() {
        var id = resolved()
        id.merge(served())
        XCTAssertEqual(id.effectiveModel, "claude-sonnet-5")
        XCTAssertEqual(id.effectiveSource, "request")
        XCTAssertTrue(id.effectiveMatchesResolved)
        XCTAssertFalse(id.entryFellBack)

        id.merge(served(response: "claude-sonnet-5-20260601"))
        XCTAssertEqual(id.effectiveModel, "claude-sonnet-5-20260601", "the API-reported name wins over the request id")
        XCTAssertEqual(id.effectiveSource, "response")
        XCTAssertTrue(id.effectiveMatchesResolved, "a dated snapshot of the same model normalises equal")
    }

    func testProviderFallbackIsVisibleAsDifferentEntry() {
        var id = resolved()
        id.merge(served(entry: "inst-7/anthropic/claude-sonnet-5", model: "anthropic/claude-sonnet-5",
                        name: "Sonnet 5", provider: "OpenRouter", response: "anthropic/claude-sonnet-5"))
        XCTAssertTrue(id.entryFellBack)
        XCTAssertEqual(id.effectiveLabel, "OpenRouter · Sonnet 5")
        XCTAssertTrue(id.effectiveMatchesResolved, "same model via another provider still counts as the same model")

        var other = resolved()
        other.merge(served(entry: "inst-53/claude-haiku-4-5", model: "claude-haiku-4-5", name: "Claude Haiku 4.5",
                           response: "claude-haiku-4-5-20251001"))
        XCTAssertTrue(other.entryFellBack)
        XCTAssertFalse(other.effectiveMatchesResolved)
        XCTAssertEqual(other.compactLine(), "Claude Sonnet 5 → claude-ha…20251001", "each half is bounded to 18 chars")
        XCTAssertEqual(other.compactLine(maxModel: 40), "Claude Sonnet 5 → claude-haiku-4-5-20251001")
    }

    func testEntryChangeDropsStaleResponseModel() {
        // Mirrors AIChatViewModel.noteEffectiveEntry: a fallback to another
        // entry must not keep the previous provider's reported model.
        var id = resolved()
        id.merge(served(response: "claude-sonnet-5-20260601"))
        var moved = served(entry: "inst-9/gpt-5", model: "gpt-5", name: "GPT-5", provider: "OpenAI")
        moved.responseModel = nil
        var fresh = HelperModelIdentity(tierRequested: id.tierRequested, tierUsed: id.tierUsed)
        fresh.resolvedEntryId = id.resolvedEntryId; fresh.resolvedModelId = id.resolvedModelId
        fresh.resolvedModelName = id.resolvedModelName; fresh.resolvedProviderLabel = id.resolvedProviderLabel
        fresh.merge(moved)
        XCTAssertEqual(fresh.effectiveModel, "gpt-5")
        XCTAssertEqual(fresh.effectiveSource, "request")
    }

    func testNormalization() {
        let n = HelperModelIdentity.normalizedModelId
        XCTAssertEqual(n("claude-sonnet-5"), n("Claude-Sonnet-5-20260101"))
        XCTAssertEqual(n("anthropic/claude-sonnet-5"), n("claude-sonnet-5"))
        XCTAssertNotEqual(n("gpt-5"), n("gpt-5-mini"))
        XCTAssertNotEqual(n("gemini-2.5-pro"), n("gemini-2.5-flash"))
    }

    // MARK: Payload round-trip (what the tool_result persists)

    func testPayloadRoundTrip() throws {
        var id = resolved()
        id.merge(served(response: "claude-sonnet-5-20260601"))
        let payload = id.payload()
        XCTAssertEqual(payload["tier_requested"] as? String, "sub")
        XCTAssertEqual(payload["tier_used"] as? String, "primary")
        XCTAssertEqual(payload["model_resolved"] as? String, "Anthropic (53) · Claude Sonnet 5")
        XCTAssertEqual(payload["model_effective"] as? String, "claude-sonnet-5-20260601")
        XCTAssertEqual(payload["model_effective_source"] as? String, "response")
        // Through JSON, exactly as ChatStore stores the tool_result text.
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        let back = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let parsed = try XCTUnwrap(HelperModelIdentity(payload: back))
        XCTAssertEqual(parsed, id)
    }

    func testPayloadWithoutIdentityKeysIsNil() {
        XCTAssertNil(HelperModelIdentity(payload: ["ok": true, "status": "completed", "model_used": "Claude Sonnet 5"]))
    }

    func testMinimalPayloadOneLineEffective() throws {
        let parsed = try XCTUnwrap(HelperModelIdentity(payload: ["tier_used": "primary", "model_effective": "gpt-5"]))
        XCTAssertEqual(parsed.effectiveModel, "gpt-5")
        XCTAssertEqual(parsed.effectiveSource, "request")
    }

    // MARK: Callback XML (background completion / scheduled child)

    func testCallbackXMLCarriesIdentity() throws {
        var id = resolved()
        id.merge(served(response: "claude-sonnet-5-20260601"))
        let cb = AgentCallback(kind: .finished, jobId: "job-1", childSessionId: "child-1", title: "Summarise",
                               status: "done", tier: "pinned", elapsed: "1m02s",
                               summary: "tools none yet · turns 1", body: "the answer",
                               modelIdentity: id)
        let xml = cb.xml
        XCTAssertTrue(xml.contains("model_resolved=\"Anthropic (53) · Claude Sonnet 5\""))
        XCTAssertTrue(xml.contains("model_effective=\"claude-sonnet-5-20260601\""))
        let parsed = try XCTUnwrap(AgentCallback.parse(xml))
        let pid = try XCTUnwrap(parsed.modelIdentity)
        XCTAssertEqual(pid.modelOrigin, "pinned", "LeoBot carries the model origin (pinned/inherited), not the retired tier")
        XCTAssertEqual(pid.resolvedLabel, "Anthropic (53) · Claude Sonnet 5")
        XCTAssertEqual(pid.resolvedModelId, "claude-sonnet-5")
        XCTAssertEqual(pid.effectiveModel, "claude-sonnet-5-20260601")
        XCTAssertEqual(pid.effectiveSource, "response")
        XCTAssertTrue(pid.effectiveMatchesResolved)
        XCTAssertEqual(parsed.body, "the answer")
    }

    func testCallbackWithoutIdentityStillParses() throws {
        let cb = AgentCallback(kind: .finished, jobId: "job-2", childSessionId: nil, title: "t", status: "done",
                               tier: "inherited", elapsed: "3s", summary: nil, body: "x")
        let parsed = try XCTUnwrap(AgentCallback.parse(cb.xml))
        XCTAssertEqual(parsed.modelIdentity?.modelOrigin, "inherited", "the origin attribute alone still names where the model came from")
        XCTAssertEqual(parsed.tier, "inherited")
        XCTAssertNil(parsed.modelIdentity?.effectiveModel)
    }

    // MARK: Compact formats

    func testCompactLineBoundsEachHalf() {
        var id = HelperModelIdentity(tierRequested: "primary", tierUsed: "primary")
        id.resolvedModelId = "a-very-long-model-name-with-many-parts-v2"
        id.resolvedModelName = "A Very Long Model Display Name Indeed"
        XCTAssertEqual(id.compactLine(maxModel: 18)?.count, 18)
        id.merge(served(entry: "x/other", model: "another-extremely-long-effective-model-identifier",
                        name: "Other", response: "another-extremely-long-effective-model-identifier"))
        let line = id.compactLine(maxModel: 18)!
        XCTAssertTrue(line.contains(" → "))
        XCTAssertLessThanOrEqual(line.count, 18 + 3 + 18)
        XCTAssertEqual(id.thumbnailLine(max: 16)?.count, 16)
    }

    func testThumbnailLinePrefersDisplayNameWhenSame() {
        var id = resolved()
        XCTAssertEqual(id.thumbnailLine(), "Claude Sonnet 5")
        id.merge(served(response: "claude-sonnet-5-20260601"))
        XCTAssertEqual(id.thumbnailLine(), "Claude Sonnet 5")
        id.merge(served(entry: "inst-53/claude-haiku-4-5", model: "claude-haiku-4-5", name: "Haiku", response: "claude-haiku-4-5"))
        XCTAssertEqual(id.thumbnailLine(), "claude-haiku-4-5")
    }
}
