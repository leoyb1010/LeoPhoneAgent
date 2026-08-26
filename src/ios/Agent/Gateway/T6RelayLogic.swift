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
