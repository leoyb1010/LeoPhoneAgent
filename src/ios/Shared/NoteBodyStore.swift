//
//  NoteBodyStore.swift
//  MinisApp
//
//  [T-notes] 笔记正文的读写与版本快照。
//
//  为什么正文不进 items.json:一篇长笔记几万字,塞进索引文件后每次读写
//  收藏库都拖着它走 —— 列表打开、增删改、同步全都变慢。正文一篇一个
//  .md 文件,列表只读标题;这和"全文索引单独进 SQLite"是同一个道理。
//
//  IO 全部走后台线程。编辑器里打字是每秒几十次的事,主线程碰磁盘就是卡。
//
//  版本快照:每次保存前把旧内容复制一份到 versions/,只保最近 10 版。
//  几 KB 的文件复制换"手滑清空了能找回来";不做 diff 系统 —— 那是给
//  多人协作准备的,个人笔记用不上。
//

import Foundation

enum NoteBodyStore {
    private static let maxVersions = 10

    /// 后台串行队列:同一篇笔记的写入必须有序,否则慢的那次会覆盖新的。
    private static let queue = DispatchQueue(label: "leo.note.body", qos: .userInitiated)

    // MARK: - 读

    static func load(_ fileName: String) async -> String {
        await withCheckedContinuation { cont in
            queue.async {
                guard let dir = CollectionStore.notesDirectory,
                      let text = try? String(contentsOf: dir.appendingPathComponent(fileName),
                                             encoding: .utf8) else {
                    cont.resume(returning: "")
                    return
                }
                cont.resume(returning: text)
            }
        }
    }

    /// 列表用的摘要行:正文首个非空行,去掉 Markdown 标记。
    static func previewLine(_ fileName: String, limit: Int = 80) async -> String {
        let body = await load(fileName)
        let line = body.split(separator: "\n")
            .first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? ""
        let cleaned = line.replacingOccurrences(of: #"^[#>\-\*\s]+"#, with: "",
                                                options: .regularExpression)
        return String(cleaned.prefix(limit))
    }

    // MARK: - 写

    /// 保存正文。写之前先给旧内容留一份快照。
    static func save(_ text: String, to fileName: String) async {
        await withCheckedContinuation { cont in
            queue.async {
                guard let dir = CollectionStore.notesDirectory else {
                    cont.resume()
                    return
                }
                let target = dir.appendingPathComponent(fileName)
                snapshotIfNeeded(existing: target, fileName: fileName)
                // 原子写:写一半掉电不会留半截文件
                try? text.data(using: .utf8)?.write(to: target, options: .atomic)
                cont.resume()
            }
        }
    }

    static func delete(_ fileName: String) {
        queue.async {
            if let dir = CollectionStore.notesDirectory {
                try? FileManager.default.removeItem(at: dir.appendingPathComponent(fileName))
            }
            for url in versionURLs(of: fileName) {
                try? FileManager.default.removeItem(at: url)
            }
        }
    }

    // MARK: - 版本

    struct Version: Identifiable {
        let id: String       // 文件名
        let savedAt: Date
        let url: URL
    }

    static func versions(of fileName: String) -> [Version] {
        versionURLs(of: fileName).compactMap { url in
            let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
            let date = (attrs?[.modificationDate] as? Date) ?? Date.distantPast
            return Version(id: url.lastPathComponent, savedAt: date, url: url)
        }
        .sorted { $0.savedAt > $1.savedAt }
    }

    static func readVersion(_ version: Version) -> String {
        (try? String(contentsOf: version.url, encoding: .utf8)) ?? ""
    }

    // MARK: - 内部

    private static func versionURLs(of fileName: String) -> [URL] {
        guard let dir = CollectionStore.versionsDirectory,
              let all = try? FileManager.default.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: [.contentModificationDateKey]) else { return [] }
        let stem = (fileName as NSString).deletingPathExtension
        return all.filter { $0.lastPathComponent.hasPrefix(stem + "@") }
    }

    /// 把当前磁盘上的内容存成一版。内容没变就不存 —— 否则每次自动保存
    /// 都刷一版,十版全是同一句话,等于没有历史。
    private static func snapshotIfNeeded(existing: URL, fileName: String) {
        guard let old = try? Data(contentsOf: existing), !old.isEmpty,
              let versionDir = CollectionStore.versionsDirectory else { return }
        let existingVersions = versions(of: fileName)
        if let newest = existingVersions.first,
           let newestData = try? Data(contentsOf: newest.url), newestData == old {
            return
        }
        let stem = (fileName as NSString).deletingPathExtension
        let stamp = Int(Date().timeIntervalSince1970)
        let dest = versionDir.appendingPathComponent("\(stem)@\(stamp).md")
        try? old.write(to: dest, options: .atomic)

        // 只保最近 maxVersions 版
        let all = versions(of: fileName)
        if all.count > maxVersions {
            for old in all.dropFirst(maxVersions) {
                try? FileManager.default.removeItem(at: old.url)
            }
        }
    }
}
