//
//  MemoryDailyLog.swift
//  MinisApp
//
//  [C3] memory_write 的落盘部分,抽出来不依赖 AIChatViewModel:
//  Agent 的 memory_write 工具和「记住这个」快捷指令动作共用。
//  每天一个 yyyy-MM-dd.md,新条目带时间戳注释插在最前面。
//

import Foundation

enum MemoryDailyLog {
    enum WriteError: Error { case notUTF8 }

    // [B7] Memory is injected into every future system prompt, so a single
    // memory_write must not be able to put megabytes there.
    /// One daily-log entry.
    static let maxEntryBytes = 8 * 1024
    /// One correction (CORRECTIONS.md line).
    static let maxCorrectionBytes = 1024
    /// One day's log as injected into the system prompt.
    static let maxDailyFragmentBytes = 16 * 1024
    /// GLOBAL.md as injected into the system prompt.
    static let maxGlobalFragmentBytes = 32 * 1024
    /// All corrections together as injected into the system prompt.
    static let maxCorrectionsFragmentBytes = 8 * 1024

    /// `text` cut to at most `maxBytes` UTF-8 bytes on a character boundary,
    /// with a visible marker when anything was dropped.
    static func capped(_ text: String, maxBytes: Int, marker: String = " …[truncated]") -> String {
        guard text.utf8.count > maxBytes else { return text }
        let budget = max(0, maxBytes - marker.utf8.count)
        var used = 0
        var end = text.startIndex
        for ch in text {
            let n = ch.utf8.count
            if used + n > budget { break }
            used += n
            end = text.index(after: end)
        }
        return String(text[..<end]) + marker
    }

    /// The first `maxBytes` of a file decoded as UTF-8 (a split multi-byte
    /// character at the cut is dropped), read with a FileHandle so a huge
    /// file is never loaded whole. nil when the file cannot be read.
    static func readPrefix(of url: URL, maxBytes: Int) -> (text: String, truncated: Bool)? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        guard var data = try? handle.read(upToCount: maxBytes + 1) else { return nil }
        let truncated = data.count > maxBytes
        if truncated { data = data.prefix(maxBytes) }
        for trim in 0...3 {
            if let s = String(data: data.dropLast(trim), encoding: .utf8) { return (s, truncated) }
        }
        return nil
    }

    static func fileName(for date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        return "\(formatter.string(from: date)).md"
    }

    /// `source` 非空时在正文前标出来源(例如锁屏时经快捷指令写入),以后读记忆的人和模型都看得到它不是对话里记下的。
    static func entry(_ content: String, at date: Date, source: String? = nil) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        let body = capped(source.map { "[来源:\($0)] \(content)" } ?? content, maxBytes: maxEntryBytes)
        return "<!-- \(formatter.string(from: date)) -->\n\(body)\n\n"
    }

    /// memory_write 工具与「记住这个」快捷指令可能同时写同一天的文件:读-改-写串行化,免得后写的吞掉先写的。
    private static let writeLock = NSLock()

    /// 把一条记忆插到当天日志最前面,返回写入的文件名(如 2026-10-06.md)。
    /// 已有文件读不出来(锁屏数据保护、编码损坏)时报错,绝不拿空串覆盖掉当天已有的记忆。
    @discardableResult
    static func prepend(_ content: String, in directory: URL, at date: Date = Date(), source: String? = nil) throws -> String {
        writeLock.lock(); defer { writeLock.unlock() }
        let fm = FileManager.default
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let name = fileName(for: date)
        let url = directory.appendingPathComponent(name)
        let existing = fm.fileExists(atPath: url.path) ? try String(contentsOf: url, encoding: .utf8) : ""
        guard let data = (entry(content, at: date, source: source) + existing).data(using: .utf8) else { throw WriteError.notUTF8 }
        try data.write(to: url, options: .atomic)
        return name
    }

    /// [F2-memory-undo] 删掉 `fileName` 里正文等于 `content` 的最新一条;返回是否删到了。
    /// 与 prepend 共用一把锁,不会和同时进行的写入互相吞掉。
    static func removeEntry(matching content: String, fileName: String, in directory: URL) throws -> Bool {
        writeLock.lock(); defer { writeLock.unlock() }
        let url = directory.appendingPathComponent(fileName)
        guard FileManager.default.fileExists(atPath: url.path) else { return false }
        let existing = try String(contentsOf: url, encoding: .utf8)
        guard let updated = MemoryWriteUndo.removingDailyEntry(from: existing, content: content),
              let data = updated.data(using: .utf8) else { return false }
        try data.write(to: url, options: .atomic)
        return true
    }
}
