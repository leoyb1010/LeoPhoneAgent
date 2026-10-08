import Foundation

/// [T-responses-orphan-tool-output] Last gate before a Responses request goes out: every
/// `function_call_output` must have a `function_call` with the same `call_id` EARLIER in
/// the array, and vice versa.
///
/// Field report: the upstream answered `No tool call found for function call output with
/// call_id call_…` and, because the request array is rebuilt deterministically, it
/// repeated on every retry and every fallback model until the session was cleared. Chat
/// Completions has `sanitizeToolCallAdjacency` for exactly this; the Responses builder
/// had no pairing pass, so pruned rows / per-record sync merges / retries that strand a
/// tool result reached the wire unchecked.
///
/// Repair:
///   * orphaned `function_call_output` → DROP (its call is gone);
///   * duplicate output for one call_id (retry / resume / sync merge) → keep the FIRST
///     [T-responses-dedupe-tool-output];
///   * unanswered `function_call` → synthesize an error output, placed once the run of
///     calls closes so outputs stay contiguous. The TRAILING run is exempt: a request
///     ending on calls is exactly what the API expects mid-round.
///
/// Order is otherwise preserved (no re-splicing), so the buffered image carriers keep
/// their place right after the output run. Pure, so the logic tests compile it.
enum ResponsesToolPairing {

    static let placeholderOutput = "Tool execution result is unavailable (history was truncated or interrupted)."

    /// Returns the repaired items plus a short report when anything changed (nil when
    /// the input was already well-formed — the common case returns it untouched).
    static func sanitize(_ items: [[String: Any]]) -> ([[String: Any]], String?) {
        func callId(_ item: [String: Any], _ type: String) -> String? {
            guard (item["type"] as? String) == type else { return nil }
            return item["call_id"] as? String
        }

        var callIds: Set<String> = []
        var answeredIds: Set<String> = []
        var duplicateOutputs = 0
        for item in items {
            if let id = callId(item, "function_call") { callIds.insert(id) }
            if let id = callId(item, "function_call_output"), !answeredIds.insert(id).inserted {
                duplicateOutputs += 1
            }
        }

        var trailingCallIds: Set<String> = []
        for item in items.reversed() {
            let type = item["type"] as? String
            if type == "function_call" {
                if let id = item["call_id"] as? String { trailingCallIds.insert(id) }
                continue
            }
            if type == "reasoning" { continue }
            break
        }

        let orphanedOutputs = answeredIds.subtracting(callIds)
        let unansweredCalls = callIds.subtracting(answeredIds).subtracting(trailingCallIds)
        guard !orphanedOutputs.isEmpty || !unansweredCalls.isEmpty || duplicateOutputs > 0 else {
            return (items, nil)
        }

        var out: [[String: Any]] = []
        out.reserveCapacity(items.count)
        var pendingPlaceholders: [[String: Any]] = []
        func flushPlaceholders() {
            guard !pendingPlaceholders.isEmpty else { return }
            out.append(contentsOf: pendingPlaceholders)
            pendingPlaceholders.removeAll()
        }

        var emittedOutputIds: Set<String> = []
        for item in items {
            if let id = callId(item, "function_call_output") {
                if orphanedOutputs.contains(id) { continue }
                if !emittedOutputIds.insert(id).inserted { continue }
            }
            // A real output closes the call run as well as a placeholder does, so the
            // placeholders land before it to keep the turn's outputs contiguous.
            if (item["type"] as? String) != "function_call" { flushPlaceholders() }
            out.append(item)
            if let id = callId(item, "function_call"), unansweredCalls.contains(id) {
                pendingPlaceholders.append([
                    "type": "function_call_output",
                    "call_id": id,
                    "output": placeholderOutput,
                ])
            }
        }
        flushPlaceholders()
        let report = "duplicateOutputs=\(duplicateOutputs) orphanedOutputs=\(orphanedOutputs.count) "
            + "unansweredCalls=\(unansweredCalls.count) itemCount=\(items.count)"
        return (out, report)
    }
}
