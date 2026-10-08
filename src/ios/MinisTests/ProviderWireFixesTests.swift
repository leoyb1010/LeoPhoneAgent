import XCTest

/// Pure-logic coverage for the provider-layer fixes ported from upstream: Responses tool
/// pairing, request-body OOM guard, models.dev id normalization, OpenCode session header.
final class ProviderWireFixesTests: XCTestCase {

    // MARK: - [T-responses-orphan-tool-output] Responses tool pairing

    private func call(_ id: String) -> [String: Any] { ["type": "function_call", "call_id": id, "name": "t", "arguments": "{}"] }
    private func output(_ id: String, _ text: String = "ok") -> [String: Any] { ["type": "function_call_output", "call_id": id, "output": text] }
    private func types(_ items: [[String: Any]]) -> [String] {
        items.map { "\($0["type"] as? String ?? ($0["role"] as? String ?? "?")):\($0["call_id"] as? String ?? "")" }
    }

    func testWellFormedRequestIsUntouched() {
        let items = [["role": "user", "content": "hi"], call("a"), output("a")]
        let (out, report) = ResponsesToolPairing.sanitize(items)
        XCTAssertNil(report)
        XCTAssertEqual(types(out), types(items))
    }

    func testOrphanOutputIsDropped() {
        let (out, report) = ResponsesToolPairing.sanitize([output("ghost"), ["role": "user", "content": "x"]])
        XCTAssertNotNil(report)
        XCTAssertEqual(types(out), ["user:"])
    }

    func testDuplicateOutputKeepsTheFirst() {
        let (out, _) = ResponsesToolPairing.sanitize([call("a"), output("a", "first"), output("a", "second")])
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out.last?["output"] as? String, "first")
    }

    /// Unanswered calls mid-history get a placeholder AFTER the call run, so parallel
    /// outputs stay contiguous; the trailing run is exempt (the model is mid-round).
    func testUnansweredCallsGetPlaceholderAfterRunButTrailingRunIsExempt() {
        let items = [call("a"), call("b"), output("a"), ["role": "user", "content": "next"], call("c")]
        let (out, _) = ResponsesToolPairing.sanitize(items)
        XCTAssertEqual(types(out), ["function_call:a", "function_call:b", "function_call_output:b",
                                    "function_call_output:a", "user:", "function_call:c"])
        XCTAssertEqual(out[2]["output"] as? String, ResponsesToolPairing.placeholderOutput)
    }

    // MARK: - [T-ios-openai-body-oom] Request body guard

    func testOrdinaryBodyPasses() {
        let body: [String: Any] = ["model": "gpt", "messages": [["role": "user", "content": String(repeating: "a", count: 10_000)]]]
        let est = RequestBodySizeGuard.estimateSerializedSize(body)
        XCTAssertGreaterThan(est, 10_000)
        XCTAssertEqual(RequestBodySizeGuard.verdict(estimated: est, availableMemory: 50 * 1024 * 1024), .ok)
    }

    func testOversizedBodyIsRefusedBeforeSerializing() {
        let huge = String(repeating: "A", count: RequestBodySizeGuard.maxRequestBodyBytes)
        let est = RequestBodySizeGuard.estimateSerializedSize(["input": [["image_url": huge]]])
        guard case .tooLarge = RequestBodySizeGuard.verdict(estimated: est, availableMemory: 0) else {
            return XCTFail("a 32MB+ body must be refused")
        }
        XCTAssertNotNil(RequestBodySizeGuard.message(for: RequestBodySizeGuard.verdict(estimated: est, availableMemory: 0)))
    }

    func testLowMemoryRefusesMidSizedBodyButUnknownMemoryDoesNot() {
        let est = 8 * 1024 * 1024
        guard case .insufficientMemory = RequestBodySizeGuard.verdict(estimated: est, availableMemory: 16 * 1024 * 1024) else {
            return XCTFail("needs ~3x the body free")
        }
        XCTAssertEqual(RequestBodySizeGuard.verdict(estimated: est, availableMemory: 0), .ok, "0 = unknown")
        XCTAssertEqual(RequestBodySizeGuard.verdict(estimated: 1024, availableMemory: 1024), .ok, "small bodies exempt")
    }

    func testPathologicalNestingDoesNotRecurseForever() {
        var nested: Any = "x"
        for _ in 0..<200 { nested = ["k": nested] }
        XCTAssertGreaterThanOrEqual(RequestBodySizeGuard.estimateSerializedSize(nested), RequestBodySizeGuard.maxRequestBodyBytes)
    }

    // MARK: - [T-modelsdev-id-normalization] models.dev keys

    func testRelaySpellingsNormaliseToOneKey() {
        let keys = ["glm-5.2", "z-ai/glm-5.2", "zai-org/GLM-5.2", "glm_5_2"].map(ModelsDevKey.normalized)
        XCTAssertEqual(Set(keys), ["glm-5-2"])
        XCTAssertNotEqual(ModelsDevKey.normalized("glm-5.2"), ModelsDevKey.normalized("glm-5.1"))
    }

    func testSuffixAliasPrefixesStopAtFamilyLevel() {
        XCTAssertEqual(ModelsDevKey.prefixCandidates(of: "glm-5-3-flash-cpa"), ["glm-5-3-flash", "glm-5-3"])
        XCTAssertEqual(ModelsDevKey.prefixCandidates(of: "gpt-5"), [], "two segments name a family")
    }

    func testMajorityVotePrefersTheCommonDeclaration() {
        let sets: [[String]?] = [nil, ["high", "xhigh"], ["high", "max"], ["high", "max"], ["low"]]
        XCTAssertEqual(ModelsDevKey.majorityIndex(sets), 2)
        XCTAssertEqual(ModelsDevKey.majorityIndex([nil, nil]), 0, "nobody declares → first candidate")
        XCTAssertEqual(ModelsDevKey.majorityIndex([["a"], ["b"]]), 0, "tie → first seen")
    }

    // MARK: - [T-opencode-dedicated-channel] OpenCode session header

    func testSessionIdIsReadLiveAndDraftsAreRejected() {
        let box = ConversationSessionBox()
        XCTAssertEqual(OpenCodeSessionHeader.resolve(live: box.value, fallback: "fb"), "fb")
        box.value = "__new__ABC"
        XCTAssertEqual(OpenCodeSessionHeader.resolve(live: box.value, fallback: "fb"), "fb",
                       "a draft placeholder must never key the upstream cache")
        box.value = "session-123"
        XCTAssertEqual(OpenCodeSessionHeader.resolve(live: box.value, fallback: "fb"), "session-123",
                       "promotion after construction is picked up by the next request")
        XCTAssertNil(OpenCodeSessionHeader.normalizedSessionId("   "))
    }
}
