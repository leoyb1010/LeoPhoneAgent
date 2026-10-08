import XCTest

/// [T-ctx-incremental-trim] Send-time, reversible trimming of old history.
final class IncrementalContextTrimmerTests: XCTestCase {

    private let bigOutput = String(repeating: "line of tool output 0123456789\n", count: 400)   // ~12.4K chars
    private let reasoning = String(repeating: "让我想一想这个问题。", count: 200)               // 2000 CJK

    /// N user turns; each: user text → assistant(tool call, reasoning) →
    /// user(tool result) → assistant(text, reasoning).
    private func history(turns: Int) -> [AgentMessage] {
        var h: [AgentMessage] = []
        for t in 0..<turns {
            h.append(AgentMessage(role: .user, parts: [.text("question \(t)")], dbMessageId: "u\(t)"))
            h.append(AgentMessage(role: .assistant,
                                  parts: [.toolUse(id: "call_\(t)|fc_\(t)", name: "shell_execute",
                                                   input: ["command": "cat big.log", "content": String(repeating: "w", count: 600)])],
                                  reasoningContent: reasoning, dbMessageId: "a\(t)"))
            h.append(AgentMessage(role: .user,
                                  parts: [.toolResult(id: "call_\(t)|fc_\(t)", name: "shell_execute", content: bigOutput, isError: false)],
                                  dbMessageId: "r\(t)"))
            h.append(AgentMessage(role: .assistant, parts: [.text("answer \(t)")],
                                  reasoningContent: t % 2 == 0 ? reasoning : nil, dbMessageId: "b\(t)"))
        }
        return h
    }

    private func trimmed(_ h: [AgentMessage], plan: IncrementalContextTrimmer.Plan) -> [AgentMessage] {
        IncrementalContextTrimmer.apply(h, boundary: plan.boundary, foldBoundary: plan.foldBoundary)
    }

    private func toolResultContent(_ m: AgentMessage) -> String? {
        for p in m.parts { if case .toolResult(_, _, let c, _, _, _, _, _) = p { return c } }
        return nil
    }

    // MARK: Plan

    func testShortSessionIsUntouched() {
        let h = history(turns: 2)
        let plan = IncrementalContextTrimmer.plan(history: h, previousKey: nil, underPressure: true)
        XCTAssertEqual(plan, .none, "current + previous user turn are always kept verbatim")
    }

    func testWatermarkSitsOnPreviousUserTurn() {
        let h = history(turns: 6)
        let plan = IncrementalContextTrimmer.plan(history: h, previousKey: nil, underPressure: false)
        XCTAssertTrue(plan.advanced)
        XCTAssertEqual(plan.boundary, 16, "user turn 4 starts at 4*4")
        XCTAssertEqual(plan.watermarkKey, "u4")
        XCTAssertEqual(plan.foldBoundary, 0, "fold lags the watermark by 4 user turns")
        XCTAssertGreaterThan(plan.savedTokens, 0)
    }

    func testFoldBoundaryLagsWatermark() {
        let h = history(turns: 9)
        let plan = IncrementalContextTrimmer.plan(history: h, previousKey: nil, underPressure: false)
        XCTAssertEqual(plan.boundary, 28)      // user turn 7
        XCTAssertEqual(plan.foldBoundary, 12)  // user turn 3
    }

    // MARK: Chunked advancement (prompt-cache alignment)

    func testWatermarkDoesNotMoveForSmallGain() {
        // The previous request trimmed up to u4; one new turn later the desired
        // boundary is u5, but moving frees less than a chunk → stay at u4 so
        // the request prefix (and the provider cache) is unchanged.
        let h = history(turns: 7)
        var config = IncrementalContextTrimmer.Config.standard
        config.chunkMinTokens = 1_000_000
        let plan = IncrementalContextTrimmer.plan(history: h, previousKey: "u4", underPressure: false, config: config)
        XCTAssertFalse(plan.advanced)
        XCTAssertEqual(plan.boundary, 16)
        XCTAssertEqual(plan.watermarkKey, "u4")
    }

    func testPressureAdvancesRegardlessOfChunk() {
        let h = history(turns: 7)
        var config = IncrementalContextTrimmer.Config.standard
        config.chunkMinTokens = 1_000_000
        let plan = IncrementalContextTrimmer.plan(history: h, previousKey: "u4", underPressure: true, config: config)
        XCTAssertTrue(plan.advanced)
        XCTAssertEqual(plan.watermarkKey, "u5")
    }

    func testPrefixIsByteStableWhileWatermarkHolds() {
        // Same watermark, one more turn appended: everything before the new
        // turn must be identical to what the previous request sent.
        var config = IncrementalContextTrimmer.Config.standard
        config.chunkMinTokens = 1_000_000
        let h6 = history(turns: 6)
        let p6 = IncrementalContextTrimmer.plan(history: h6, previousKey: "u4", underPressure: false, config: config)
        let h7 = history(turns: 7)
        let p7 = IncrementalContextTrimmer.plan(history: h7, previousKey: p6.watermarkKey, underPressure: false, config: config)
        let a = trimmed(h6, plan: p6), b = trimmed(h7, plan: p7)
        XCTAssertEqual(p6.boundary, p7.boundary)
        for i in a.indices {
            XCTAssertEqual(fingerprint(a[i]), fingerprint(b[i]), "message \(i) changed while the watermark held")
        }
    }

    func testWatermarkAlwaysOnUserTurnStart() {
        for turns in 3...10 {
            let h = history(turns: turns)
            let plan = IncrementalContextTrimmer.plan(history: h, previousKey: nil, underPressure: true)
            guard plan.boundary > 0 else { continue }
            XCTAssertTrue(IncrementalContextTrimmer.startsUserTurn(h[plan.boundary]))
            if plan.foldBoundary > 0 { XCTAssertTrue(IncrementalContextTrimmer.startsUserTurn(h[plan.foldBoundary])) }
        }
    }

    func testUnknownWatermarkRestartsFromZero() {
        let h = history(turns: 6)
        let plan = IncrementalContextTrimmer.plan(history: h, previousKey: "gone-after-compaction", underPressure: false)
        XCTAssertEqual(plan.watermarkKey, "u4")
    }

    // MARK: Apply

    func testStoredHistoryIsNeverMutated() {
        let h = history(turns: 8)
        let before = h.map(fingerprint)
        let plan = IncrementalContextTrimmer.plan(history: h, previousKey: nil, underPressure: true)
        _ = trimmed(h, plan: plan)
        XCTAssertEqual(h.map(fingerprint), before)
    }

    func testIdempotent() {
        let h = history(turns: 9)
        let plan = IncrementalContextTrimmer.plan(history: h, previousKey: nil, underPressure: true)
        let once = trimmed(h, plan: plan)
        let twice = trimmed(once, plan: plan)
        XCTAssertEqual(once.map(fingerprint), twice.map(fingerprint))
    }

    func testReasoningFieldStaysPresentButEmpty() {
        let h = history(turns: 6)
        let plan = IncrementalContextTrimmer.plan(history: h, previousKey: nil, underPressure: true)
        let out = trimmed(h, plan: plan)
        for i in 0..<plan.boundary where h[i].role == .assistant {
            if h[i].reasoningContent == nil {
                XCTAssertNil(out[i].reasoningContent, "nil stays nil — no fabricated field")
            } else {
                XCTAssertEqual(out[i].reasoningContent, "",
                               "DeepSeek V4 / Mimo / Kimi need the field present on tool-call turns; empty is accepted")
            }
        }
        for i in plan.boundary..<h.count {
            XCTAssertEqual(out[i].reasoningContent, h[i].reasoningContent, "recent turns echo reasoning verbatim")
        }
    }

    func testLargeToolResultHeadTailWithHint() {
        let h = history(turns: 6)
        let plan = IncrementalContextTrimmer.plan(history: h, previousKey: nil, underPressure: true)
        let out = trimmed(h, plan: plan)
        let cut = toolResultContent(out[2 + 4 * 3])!          // turn 3 result, inside watermark, outside fold
        XCTAssertTrue(cut.contains(IncrementalContextTrimmer.truncationMarker))
        XCTAssertTrue(cut.contains("file_read"))
        XCTAssertTrue(cut.hasPrefix(String(bigOutput.prefix(200))))
        XCTAssertTrue(cut.hasSuffix(String(bigOutput.suffix(200))))
        XCTAssertLessThan(cut.count, IncrementalContextTrimmer.Config.standard.largeToolResultChars)
        XCTAssertEqual(toolResultContent(out[2 + 4 * 4]), bigOutput, "previous turn's result is untouched")
    }

    func testFoldedPairsKeepIdsAndPairing() {
        let h = history(turns: 9)
        let plan = IncrementalContextTrimmer.plan(history: h, previousKey: nil, underPressure: true)
        let out = trimmed(h, plan: plan)
        let folded = toolResultContent(out[2])!                // turn 0
        XCTAssertTrue(folded.hasPrefix(IncrementalContextTrimmer.foldMarker))
        XCTAssertFalse(folded.contains("\n"), "one line")
        if case .toolUse(let id, let name, let input) = out[1].parts[0] {
            XCTAssertEqual(id, "call_0|fc_0")
            XCTAssertEqual(name, "shell_execute")
            XCTAssertEqual(input["command"] as? String, "cat big.log", "short args kept")
            XCTAssertLessThan((input["content"] as? String)!.count, 600)
        } else { XCTFail("tool call must survive folding") }
        let repaired = OutgoingToolPairing.repair(out)
        XCTAssertEqual(repaired.orphanedCalls + repaired.orphanedResults, 0)
    }

    func testTokenEstimateDrops() {
        let h = history(turns: 10)
        let plan = IncrementalContextTrimmer.plan(history: h, previousKey: nil, underPressure: false)
        let before = ContextSizeMeter.estimateTokens(h)
        let after = ContextSizeMeter.estimateTokens(trimmed(h, plan: plan))
        XCTAssertLessThan(after, before / 2, "old reasoning + tool output dominate a long agent session")
        XCTAssertEqual(before - after, plan.savedTokens)
    }

    func testUserAndAssistantTextNeverChange() {
        let h = history(turns: 9)
        let plan = IncrementalContextTrimmer.plan(history: h, previousKey: nil, underPressure: true)
        let out = trimmed(h, plan: plan)
        for (a, b) in zip(h, out) {
            XCTAssertEqual(texts(a), texts(b))
        }
    }

    // MARK: Outgoing tool pairing

    func testOrphanResultDroppedAndOrphanCallAnswered() {
        let h: [AgentMessage] = [
            AgentMessage(role: .user, parts: [.toolResult(id: "gone", name: "x", content: "r", isError: false)]),
            AgentMessage(role: .user, parts: [.text("hi")]),
            AgentMessage(role: .assistant, parts: [.toolUse(id: "call_a|fc_a", name: "x", input: [:])]),
            AgentMessage(role: .user, parts: [.text("next")]),
            AgentMessage(role: .assistant, parts: [.toolUse(id: "live", name: "y", input: [:])]),
        ]
        let r = OutgoingToolPairing.repair(h)
        XCTAssertEqual(r.orphanedResults, 1)
        XCTAssertEqual(r.orphanedCalls, 1, "the trailing in-flight call is exempt")
        XCTAssertEqual(r.history.count, 5, "emptied message removed, placeholder result inserted")
        if case .toolResult(let id, _, let content, let isError, _, _, _, _) = r.history[2].parts[0] {
            XCTAssertEqual(id, "call_a|fc_a")
            XCTAssertTrue(isError)
            XCTAssertEqual(content, OutgoingToolPairing.interruptedPlaceholder)
        } else { XCTFail() }
    }

    func testResponsesCombinedIdsPairOnCallId() {
        let h: [AgentMessage] = [
            AgentMessage(role: .assistant, parts: [.toolUse(id: "call_1|fc_9", name: "x", input: [:])]),
            AgentMessage(role: .user, parts: [.toolResult(id: "call_1", name: "x", content: "ok", isError: false)]),
        ]
        let r = OutgoingToolPairing.repair(h)
        XCTAssertEqual(r.orphanedCalls + r.orphanedResults, 0)
    }

    // MARK: Helpers

    private func texts(_ m: AgentMessage) -> [String] {
        m.parts.compactMap { if case .text(let t) = $0 { return t }; return nil }
    }

    private func fingerprint(_ m: AgentMessage) -> String {
        var s = "\(m.role.rawValue)|\(m.reasoningContent ?? "<nil>")"
        for p in m.parts {
            switch p {
            case .text(let t): s += "|t:\(t)"
            case .toolUse(let id, let n, let input):
                s += "|u:\(id):\(n):" + input.keys.sorted().map { "\($0)=\(input[$0]!)" }.joined(separator: ",")
            case .toolResult(let id, let n, let c, let e, _, _, _, _): s += "|r:\(id):\(n):\(e):\(c)"
            case .imageData(let d, _, _): s += "|i:\(d.count)"
            }
        }
        return s
    }
}
