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

    static func fileName(for date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        return "\(formatter.string(from: date)).md"
    }

    static func entry(_ content: String, at date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return "<!-- \(formatter.string(from: date)) -->\n\(content)\n\n"
    }

    /// 把一条记忆插到当天日志最前面,返回写入的文件名(如 2026-10-06.md)。
    @discardableResult
    static func prepend(_ content: String, in directory: URL, at date: Date = Date()) throws -> String {
        let fm = FileManager.default
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let name = fileName(for: date)
        let url = directory.appendingPathComponent(name)
        let existing = fm.fileExists(atPath: url.path)
            ? ((try? String(contentsOf: url, encoding: .utf8)) ?? "") : ""
        guard let data = (entry(content, at: date) + existing).data(using: .utf8) else { throw WriteError.notUTF8 }
        try data.write(to: url)
        return name
    }
}
