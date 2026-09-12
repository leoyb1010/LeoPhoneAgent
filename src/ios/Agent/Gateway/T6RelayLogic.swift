import Foundation

enum T6RelayLogic {
    struct Resume {
        let status: String
        let after: Int
        let minAfter: Int

        var isGap: Bool { status == "gap" }
    }

    static func resumeEnvelope(after: Int, minAfter: Int) -> Resume {
        let safeAfter = max(0, after)
        let safeMin = max(0, minAfter)
        if safeAfter < safeMin {
            return Resume(status: "gap", after: safeAfter, minAfter: safeMin)
        }
        return Resume(status: "ok", after: safeAfter, minAfter: safeMin)
    }

    static func parseResume(_ obj: [String: Any]) -> Resume? {
        let kind = (obj["type"] as? String) == "resume" || (obj["event"] as? String) == "resume"
        guard kind else { return nil }
        guard let status = obj["status"] as? String, status == "ok" || status == "gap" else { return nil }
        let after = obj["after"] as? Int ?? 0
        let minAfter = obj["min_after"] as? Int ?? 0
        return resumeEnvelope(after: after, minAfter: minAfter)
    }

    static func minAfter(from raw: String) -> Int? {
        guard let data = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        if let resume = parseResume(obj) { return resume.minAfter }
        return obj["min_after"] as? Int
    }

    /// Gap jumps forward. Duplicates and rewinds are ignored.
    static func advance(current: Int, minAfter: Int) -> Int {
        max(current, minAfter)
    }
}


struct HarnessJournalStatus: Equatable, Sendable {
    var state: String = "unknown"
    var durableSeq: Int = 0
    var latestSeq: Int = 0
    var missingRanges: Int = 0

    var label: String {
        switch state {
        case "pending": return "日志保存中"
        case "durable": return "日志已保存"
        case "degraded": return "日志保存异常，历史可能不完整"
        default: return "日志保存状态未知"
        }
    }

    static func parse(_ object: [String: Any]) -> HarnessJournalStatus? {
        guard object["type"] as? String == "durability",
              let state = object["state"] as? String,
              ["pending", "durable", "degraded"].contains(state),
              let durable = object["durable_seq"] as? Int,
              let latest = object["latest_seq"] as? Int,
              durable >= 0, latest >= durable else { return nil }
        let missing = (object["missing_ranges"] as? [[String: Any]])?.count ?? 0
        // A contradictory server frame must never paint an incomplete journal green.
        let resolved = state == "durable" && (missing > 0 || durable < latest) ? "degraded" : state
        return HarnessJournalStatus(state: resolved, durableSeq: durable, latestSeq: latest, missingRanges: missing)
    }
}
