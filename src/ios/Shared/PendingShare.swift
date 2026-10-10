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

    // MARK: - Bounds (share extension, "Open in", App Group record)

    /// Most items one share (or merged unconsumed shares) can carry.
    static let maxItems = 20
    /// Longest inline text item kept as text.
    static let maxInlineTextChars = 4000
    /// Largest file the share extension / "Open in" will copy in.
    static let maxAttachmentBytes: Int64 = 512 * 1024 * 1024
    /// Largest shared text staged as a .txt attachment.
    static let maxStagedTextBytes = 10 * 1024 * 1024

    /// Checked BEFORE copying: nil size (unknown) is allowed through; the
    /// copy itself is streamed.
    static func admitsAttachment(byteCount: Int64?) -> Bool {
        guard let byteCount else { return true }
        return byteCount >= 0 && byteCount <= maxAttachmentBytes
    }

    /// Newest `maxItems` items; inline text cut to `maxInlineTextChars`.
    static func bounded(_ items: [Item]) -> [Item] {
        items.suffix(maxItems).map { item in
            guard item.kind == .inlineText, item.value.count > maxInlineTextChars else { return item }
            return Item(kind: .inlineText, value: String(item.value.prefix(maxInlineTextChars)))
        }
    }

    /// The same record with its item list bounded (a corrupt or merged App
    /// Group record must not flood the composer).
    var bounded: PendingShare {
        PendingShare(items: Self.bounded(items), timestamp: timestamp,
                     instruction: instruction, treasuryContext: treasuryContext)
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
