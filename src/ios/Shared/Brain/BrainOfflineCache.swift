//
//  BrainOfflineCache.swift
//  MinisApp
//
//  [T-brain] 资料库离线缓存:知识卡全文 + 最近打开的 50 页正文片段(连同文件元数据)。
//  存原始响应字节,读出时按契约再解码。放在 App 容器 Library/Application Support/BrainOffline 下,
//  整个目录不进备份。私密资料不落盘(调用方负责不传进来)。
//

import CryptoKit
import Foundation

final class BrainOfflineCache: @unchecked Sendable {
    static let defaultChunkPageLimit = 50

    let root: URL
    let chunkPageLimit: Int
    private let lock = NSLock()
    private let fm = FileManager.default

    init(root: URL, chunkPageLimit: Int = BrainOfflineCache.defaultChunkPageLimit) {
        self.root = root
        self.chunkPageLimit = max(1, chunkPageLimit)
    }

    static func defaultRoot() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("BrainOffline", isDirectory: true)
    }

    // MARK: Keys

    static func chunkPageKey(fileId: String, offset: Int, locator: String?) -> String {
        "chunks|\(fileId)|\(offset)|\(locator ?? "")"
    }

    static func fileMetaKey(_ fileId: String) -> String { "file|\(fileId)" }
    static func cardKey(_ id: String) -> String { "card|\(id)" }
    static let cardListKey = "cards|list"

    // MARK: Cards (kept until disconnect)

    func storeCard(id: String, data: Data) { write(data, key: Self.cardKey(id), dir: "cards") }
    func card(id: String) -> Data? { read(key: Self.cardKey(id), dir: "cards") }
    func storeCardList(_ data: Data) { write(data, key: Self.cardListKey, dir: "cards") }
    func cardList() -> Data? { read(key: Self.cardListKey, dir: "cards") }

    // MARK: Chunk pages (LRU, at most `chunkPageLimit`)

    func storeChunkPage(fileId: String, offset: Int, locator: String?, data: Data) {
        let key = Self.chunkPageKey(fileId: fileId, offset: offset, locator: locator)
        lock.lock(); defer { lock.unlock() }
        writeUnlocked(data, key: key, dir: "pages")
        var order = loadOrderUnlocked().filter { $0 != key }
        order.append(key)
        while order.count > chunkPageLimit {
            let evicted = order.removeFirst()
            try? fm.removeItem(at: fileURL(key: evicted, dir: "pages"))
        }
        saveOrderUnlocked(order)
    }

    func chunkPage(fileId: String, offset: Int, locator: String?) -> Data? {
        let key = Self.chunkPageKey(fileId: fileId, offset: offset, locator: locator)
        lock.lock(); defer { lock.unlock() }
        guard let data = try? Data(contentsOf: fileURL(key: key, dir: "pages")) else { return nil }
        var order = loadOrderUnlocked().filter { $0 != key }
        order.append(key)
        saveOrderUnlocked(order)
        return data
    }

    var cachedChunkPageCount: Int {
        lock.lock(); defer { lock.unlock() }
        return loadOrderUnlocked().count
    }

    // MARK: File metadata (bounded alongside pages)

    func storeFileMeta(id: String, data: Data) {
        write(data, key: Self.fileMetaKey(id), dir: "files")
        // 元数据随页一起淘汰:只留仍有缓存页的文件,再多留一个余量。
        lock.lock(); defer { lock.unlock() }
        let dir = root.appendingPathComponent("files", isDirectory: true)
        guard let entries = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey]),
              entries.count > chunkPageLimit else { return }
        let sorted = entries.sorted {
            let a = (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            let b = (try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return a < b
        }
        for url in sorted.prefix(entries.count - chunkPageLimit) { try? fm.removeItem(at: url) }
    }

    func fileMeta(id: String) -> Data? { read(key: Self.fileMetaKey(id), dir: "files") }

    // MARK: Housekeeping

    func clearAll() {
        lock.lock(); defer { lock.unlock() }
        try? fm.removeItem(at: root)
    }

    static func isExcludedFromBackup(_ url: URL) -> Bool {
        let fresh = URL(fileURLWithPath: url.path)
        return (try? fresh.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup) == true
    }

    // MARK: Private

    private func write(_ data: Data, key: String, dir: String) {
        lock.lock(); defer { lock.unlock() }
        writeUnlocked(data, key: key, dir: dir)
    }

    private func read(key: String, dir: String) -> Data? {
        lock.lock(); defer { lock.unlock() }
        return try? Data(contentsOf: fileURL(key: key, dir: dir))
    }

    private func writeUnlocked(_ data: Data, key: String, dir: String) {
        ensureRootUnlocked()
        let folder = root.appendingPathComponent(dir, isDirectory: true)
        try? fm.createDirectory(at: folder, withIntermediateDirectories: true)
        try? data.write(to: fileURL(key: key, dir: dir), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func ensureRootUnlocked() {
        if !fm.fileExists(atPath: root.path) {
            try? fm.createDirectory(at: root, withIntermediateDirectories: true)
        }
        var url = root
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }

    private func fileURL(key: String, dir: String) -> URL {
        let digest = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
        return root.appendingPathComponent(dir, isDirectory: true).appendingPathComponent(digest + ".json")
    }

    private var orderURL: URL { root.appendingPathComponent("pages-order.json") }

    private func loadOrderUnlocked() -> [String] {
        guard let data = try? Data(contentsOf: orderURL),
              let arr = try? JSONDecoder().decode([String].self, from: data) else { return [] }
        return arr
    }

    private func saveOrderUnlocked(_ order: [String]) {
        ensureRootUnlocked()
        if let data = try? JSONEncoder().encode(order) { try? data.write(to: orderURL, options: .atomic) }
    }
}
