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
        // [B7] One correction is one short line in every future prompt.
        let oneLine = MemoryDailyLog.capped(
            trimmed.replacingOccurrences(of: "\r", with: " ").replacingOccurrences(of: "\n", with: " "),
            maxBytes: MemoryDailyLog.maxCorrectionBytes)
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

    /// [F2-memory-undo] 撤销一条纠错:只删记录这段内容的最新那一行。
    static func remove(_ content: String) -> Bool {
        guard let kept = MemoryWriteUndo.removingCorrection(from: load(), content: content) else { return false }
        let body = kept.isEmpty ? "" : kept.joined(separator: "\n") + "\n"
        do {
            try body.data(using: .utf8)?.write(to: fileURL, options: .atomic)
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


    /// The prompt fragment, or nil when there is nothing to say.
    static func promptFragment() -> String? {
        let entries = load()
        guard !entries.isEmpty else { return nil }
        // [B7] Entries written before the cap existed are capped here too.
        let body = entries.map { MemoryDailyLog.capped($0, maxBytes: MemoryDailyLog.maxCorrectionBytes) }
            .joined(separator: "\n")
        return "⚠️ Corrections the user has explicitly made (permanent, highest priority — never repeat these mistakes):\n"
            + MemoryDailyLog.capped(body, maxBytes: MemoryDailyLog.maxCorrectionsFragmentBytes)
    }
}
