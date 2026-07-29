//
//  CorrectionStore.swift
//  MinisApp
//
//  [T-correction-memory] Corrections as a first-class memory type (absorbed
//  from Cindy's "learn once, apply always").
//
//  The existing memory is a recency-tiered stream — old entries fade. A user
//  CORRECTION must never fade: "I told you once already" is exactly the
//  failure this prevents. Corrections live in their own file, are injected
//  with a fixed high-priority label, and never enter the aging tiers.
//
//  Additive guarantee: no corrections recorded → `promptFragment()` returns
//  nil → the system prompt is byte-identical to before this feature existed.
//

import Foundation

enum CorrectionStore {
    static let fileName = "CORRECTIONS.md"
    /// Keep the prompt cost bounded: newest N entries survive.
    private static let maxEntries = 30

    private static var fileURL: URL {
        AIChatViewModel.minisMemoryPersistentDir.appendingPathComponent(fileName)
    }

    /// Append one correction. Entries are single markdown bullets with a date.
    static func append(_ content: String) -> Bool {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let fm = FileManager.default
        try? fm.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd"
        let oneLine = trimmed.replacingOccurrences(of: "\n", with: " ")
        var entries = load()
        entries.append("- [\(fmt.string(from: Date()))] \(oneLine)")
        if entries.count > maxEntries { entries = Array(entries.suffix(maxEntries)) }
        let body = entries.joined(separator: "\n") + "\n"
        do {
            try body.data(using: .utf8)?.write(to: fileURL)
            NotificationCenter.default.post(name: .memoryFilesDidChange, object: nil)
            return true
        } catch {
            return false
        }
    }

    static func load() -> [String] {
        guard let text = try? String(contentsOf: fileURL, encoding: .utf8) else { return [] }
        return text.split(separator: "\n").map(String.init).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    static func delete(at index: Int) {
        var entries = load()
        guard entries.indices.contains(index) else { return }
        entries.remove(at: index)
        let body = entries.isEmpty ? "" : entries.joined(separator: "\n") + "\n"
        try? body.data(using: .utf8)?.write(to: fileURL)
        NotificationCenter.default.post(name: .memoryFilesDidChange, object: nil)
    }

    /// The prompt fragment, or nil when there is nothing to say.
    static func promptFragment() -> String? {
        let entries = load()
        guard !entries.isEmpty else { return nil }
        return "⚠️ Corrections the user has explicitly made (permanent, highest priority — never repeat these mistakes):\n"
            + entries.joined(separator: "\n")
    }
}
