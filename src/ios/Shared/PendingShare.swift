import Foundation

/// Describes content shared into the app via the Share Extension.
/// Encoded to JSON and stored in the App Group UserDefaults.
struct PendingShare: Codable, Equatable {
    let items: [Item]
    let timestamp: Date
    /// User-authored/default action prompt. Kept separate from Treasury data so
    /// selected material cannot masquerade as the user's instruction.
    let instruction: String?
    /// Structured, bounded, explicitly untrusted Treasury reference material.
    let treasuryContext: String?

    init(items: [Item], timestamp: Date,
         instruction: String? = nil, treasuryContext: String? = nil) {
        self.items = items
        self.timestamp = timestamp
        self.instruction = instruction
        self.treasuryContext = treasuryContext
    }

    /// Merge buffered optional text fields without allowing repeated shares or
    /// a corrupt App Group record to grow the next model request without bound.
    /// Newer values win when the budget cannot hold every complete field; fields
    /// are never cut mid-structure (important for Treasury XML boundaries).
    static func boundedMerge(_ values: [String?], maxTotalChars: Int) -> String? {
        let budget = max(0, maxTotalChars)
        guard budget > 0 else { return nil }
        var seen = Set<String>()
        var selectedNewestFirst: [String] = []
        var used = 0
        for raw in values.reversed() {
            guard let value = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !value.isEmpty, seen.insert(value).inserted else { continue }
            let separator = selectedNewestFirst.isEmpty ? 0 : 1
            guard used + separator + value.count <= budget else { continue }
            selectedNewestFirst.append(value)
            used += separator + value.count
        }
        guard !selectedNewestFirst.isEmpty else { return nil }
        return selectedNewestFirst.reversed().joined(separator: "\n")
    }

    struct Item: Codable, Equatable {
        let kind: Kind
        /// For `.inlineText`: the text/URL content. For `.attachment`: the filename in the shared container.
        let value: String

        enum Kind: String, Codable {
            case inlineText
            case attachment
        }
    }
}
