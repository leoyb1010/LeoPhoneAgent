import Foundation

/// Thinking intensity shared by the app and the dependency-light logic tests.
enum ThinkingLevel: String, Codable, Hashable, CaseIterable, Comparable, Sendable {
    case off
    case low
    case medium
    case high
    case xhigh
    case max
    case ultra

    static func < (lhs: ThinkingLevel, rhs: ThinkingLevel) -> Bool {
        allCases.firstIndex(of: lhs)! < allCases.firstIndex(of: rhs)!
    }

    var displayName: String {
        switch self {
        case .off: return String(localized: "Off")
        case .low: return String(localized: "Low")
        case .medium: return String(localized: "Med")
        case .high: return String(localized: "High")
        case .xhigh: return String(localized: "XHigh")
        case .max: return String(localized: "Max")
        case .ultra: return String(localized: "Ultra")
        }
    }

    var isEnabled: Bool { self != .off }

    static func decoded(_ raw: String) -> ThinkingLevel {
        ThinkingLevel(rawValue: raw) ?? .xhigh
    }
}

/// Per-session inference settings (thinking toggle, etc.).
struct SessionInferenceConfig: Codable, Hashable {
    var thinkingLevel: ThinkingLevel = .off
    /// User's last explicit pick. Survives a clamp when switching to a
    /// weaker model so switching back restores High instead of the clamped Medium.
    var preferredThinkingLevel: ThinkingLevel?

    var thinkingEnabled: Bool { thinkingLevel.isEnabled }
    var preferredOrStored: ThinkingLevel { preferredThinkingLevel ?? thinkingLevel }

    // Backward-compatible decode: handle both old `thinkingEnabled: Bool` and new `thinkingLevel` key.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let raw = try container.decodeIfPresent(String.self, forKey: .thinkingLevel) {
            thinkingLevel = ThinkingLevel.decoded(raw)
        } else if let enabled = try container.decodeIfPresent(Bool.self, forKey: .thinkingEnabled) {
            thinkingLevel = enabled ? .medium : .off
        } else {
            thinkingLevel = .off
        }
        if let raw = try container.decodeIfPresent(String.self, forKey: .preferredThinkingLevel) {
            preferredThinkingLevel = ThinkingLevel.decoded(raw)
        } else {
            preferredThinkingLevel = nil
        }
    }

    init() { thinkingLevel = .off }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(thinkingLevel, forKey: .thinkingLevel)
        try container.encodeIfPresent(preferredThinkingLevel, forKey: .preferredThinkingLevel)
    }

    private enum CodingKeys: String, CodingKey {
        case thinkingLevel, thinkingEnabled, preferredThinkingLevel
    }
}
