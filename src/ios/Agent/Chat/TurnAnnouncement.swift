//
//  TurnAnnouncement.swift
//  MinisApp
//
//  [F2-voiceover] One concise VoiceOver announcement when a turn ends —
//  never per token. Pure logic so the logic-test target compiles it.
//

import Foundation

enum TurnAnnouncement {
    static let summaryLimit = 80

    /// What VoiceOver says when a turn ends. Errors win over the reply.
    static func text(replyText: String, error: String?) -> String {
        if let error = error?.trimmingCharacters(in: .whitespacesAndNewlines), !error.isEmpty {
            return String(localized: "出错了:") + clip(firstLine(error))
        }
        let plain = MarkdownStripper.plainText(String(replyText.prefix(4_000)))
        let summary = clip(firstSentence(plain))
        return summary.isEmpty ? String(localized: "回复完成") : String(localized: "回复完成:") + summary
    }

    private static func firstLine(_ text: String) -> String {
        text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
    }

    private static func firstSentence(_ text: String) -> String {
        let line = firstLine(text.trimmingCharacters(in: .whitespacesAndNewlines))
        let enders: Set<Character> = ["。", "！", "？", "!", "?", "."]
        var out = ""
        for ch in line {
            out.append(ch)
            if enders.contains(ch), out.count >= 4 { break }
        }
        return out.trimmingCharacters(in: .whitespaces)
    }

    private static func clip(_ text: String) -> String {
        text.count > summaryLimit ? String(text.prefix(summaryLimit)) + "…" : text
    }

    /// Announce each finished turn once: the same message (and error) twice is
    /// the same turn seen by a second isProcessing flip, not a new one.
    struct Gate {
        private(set) var lastKey: String?

        mutating func shouldAnnounce(messageId: String, error: String?) -> Bool {
            let key = messageId + "|" + (error ?? "")
            guard key != lastKey else { return false }
            lastKey = key
            return true
        }
    }
}
