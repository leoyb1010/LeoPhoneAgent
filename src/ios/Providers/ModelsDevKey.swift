import Foundation

/// [T-modelsdev-id-normalization] Pure catalog-lookup helpers for `ModelsDevAPI`, kept in
/// their own file so the logic tests compile them directly.
enum ModelsDevKey {

    /// Relays publish one model under many spellings — `glm-5.2`, `z-ai/glm-5.2`,
    /// `zai-org/GLM-5.2`. Conservative: drop the namespace path, lowercase, unify `.`/`_`
    /// to `-`; distinct families (`glm-5.2` vs `glm-5.1`) stay distinct.
    static func normalized(_ id: String) -> String {
        let bare = id.split(separator: "/").last.map(String.init) ?? id
        return bare.lowercased()
            .replacingOccurrences(of: ".", with: "-")
            .replacingOccurrences(of: "_", with: "-")
    }

    /// Fewest segments a prefix may shrink to: two segments (`gpt-5`) name a family.
    static let minPrefixSegments = 2

    /// [T-modelsdev-suffix-alias] Segment-boundary prefixes of a normalized key, longest
    /// first, never shorter than `minPrefixSegments` + 1 segments: for
    /// `glm-5-3-flash-cpa` → `glm-5-3-flash`, `glm-5-3`. A bare `hasPrefix` would let
    /// `gpt-5` claim `gpt-51`; only `-`-delimited prefixes count.
    static func prefixCandidates(of normalizedKey: String) -> [String] {
        var segments = normalizedKey.split(separator: "-").map(String.init)
        var out: [String] = []
        // Never shrink to a bare family (`glm-5`): stop once the next cut would leave
        // only `minPrefixSegments` segments.
        while segments.count > minPrefixSegments + 1 {
            segments.removeLast()
            out.append(segments.joined(separator: "-"))
        }
        return out
    }

    /// Index of the candidate whose effort set wins the majority vote (ties: first seen).
    /// Candidates declaring nothing (nil) never win unless nobody declares anything, in
    /// which case the first candidate is returned. Publishers genuinely disagree (129 bare
    /// names carry conflicting declarations); relays mostly copy the vendor, so the mode
    /// converges on the vendor's own set.
    static func majorityIndex(_ effortSets: [[String]?]) -> Int? {
        guard !effortSets.isEmpty else { return nil }
        var counts: [[String]: Int] = [:]
        for case let set? in effortSets { counts[set, default: 0] += 1 }
        guard !counts.isEmpty else { return 0 }
        var bestIndex: Int?
        var bestCount = 0
        for (i, set) in effortSets.enumerated() {
            guard let set, let c = counts[set] else { continue }
            if c > bestCount { bestCount = c; bestIndex = i }
        }
        return bestIndex
    }
}
