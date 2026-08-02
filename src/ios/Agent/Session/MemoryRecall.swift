//
//  MemoryRecall.swift
//  MinisApp
//
//  [T-memory-recall] 2.0 pillar 2 MVP: semantic search over the user's own
//  memory (GLOBAL.md, daily logs, corrections) with on-device embeddings —
//  zero API cost, offline, private. When the contextual-embedding assets
//  aren't available the tool degrades to keyword scoring and SAYS so.
//
//  Index is lazy: rebuilt only when a source file's mtime changes. Vectors
//  cached as JSON next to the memory files.
//

import Foundation
import NaturalLanguage

private let logger = AppLogger(category: "MemoryRecall")

actor MemoryRecallIndex {
    static let shared = MemoryRecallIndex()

    struct Chunk: Codable {
        let source: String     // e.g. "GLOBAL.md", "2026-07-29.md", "corrections"
        let text: String
        var vector: [Float]?
    }

    private struct CacheFile: Codable {
        var sourceStamp: String
        var chunks: [Chunk]
    }

    private var embedding: NLContextualEmbedding?
    private var loadedStamp: String = ""
    private var chunks: [Chunk] = []

    private var memoryDir: URL { AIChatViewModel.minisMemoryPersistentDir }
    private var cacheURL: URL { memoryDir.appendingPathComponent("recall-index.json") }

    // MARK: - Public

    /// Top-k semantically similar chunks; falls back to keyword scoring when
    /// embeddings are unavailable (returns `usedEmbeddings=false` so the tool
    /// output can be honest about quality).
    func query(_ query: String, topK: Int = 6) async -> (results: [Chunk], usedEmbeddings: Bool) {
        await refreshIfNeeded()
        guard !chunks.isEmpty else { return ([], false) }
        if let qv = await embed(query) {
            let scored = chunks.compactMap { chunk -> (Chunk, Float)? in
                guard let v = chunk.vector else { return nil }
                return (chunk, Self.cosine(qv, v))
            }
            if !scored.isEmpty {
                return (Array(scored.sorted { $0.1 > $1.1 }.prefix(topK).map(\.0)), true)
            }
        }
        // Keyword fallback: score by shared terms.
        let terms = query.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
        let scored = chunks.map { chunk -> (Chunk, Int) in
            let lowered = chunk.text.lowercased()
            return (chunk, terms.reduce(0) { $0 + (lowered.contains($1) ? 1 : 0) })
        }.filter { $0.1 > 0 }
        return (Array(scored.sorted { $0.1 > $1.1 }.prefix(topK).map(\.0)), false)
    }

    // MARK: - Index build

    private func refreshIfNeeded() async {
        let stamp = Self.sourceStamp(dir: memoryDir)
        if stamp == loadedStamp, !chunks.isEmpty { return }
        // Try the cache first.
        if let data = try? Data(contentsOf: cacheURL),
           let cache = try? JSONDecoder().decode(CacheFile.self, from: data),
           cache.sourceStamp == stamp {
            chunks = cache.chunks
            loadedStamp = stamp
            return
        }
        var fresh: [Chunk] = []
        let fm = FileManager.default
        if let files = try? fm.contentsOfDirectory(at: memoryDir, includingPropertiesForKeys: nil) {
            for file in files where file.pathExtension == "md" {
                guard let text = try? String(contentsOf: file, encoding: .utf8) else { continue }
                for piece in Self.chunk(text) {
                    fresh.append(Chunk(source: file.lastPathComponent, text: piece, vector: nil))
                }
            }
        }
        // Embed (best effort — nil vectors keep keyword fallback working).
        for index in fresh.indices {
            fresh[index].vector = await embed(fresh[index].text)
        }
        chunks = fresh
        loadedStamp = stamp
        if let data = try? JSONEncoder().encode(CacheFile(sourceStamp: stamp, chunks: fresh)) {
            try? data.write(to: cacheURL)
        }
        logger.info("recall index rebuilt: \(fresh.count) chunks, embedded=\(fresh.filter { $0.vector != nil }.count)")
    }

    private static func sourceStamp(dir: URL) -> String {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey]) else { return "" }
        return files.filter { $0.pathExtension == "md" }
            .compactMap { url -> String? in
                let date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
                return "\(url.lastPathComponent):\(date?.timeIntervalSince1970 ?? 0)"
            }
            .sorted().joined(separator: "|")
    }

    /// ~300-char paragraphs, split on blank lines first.
    private static func chunk(_ text: String) -> [String] {
        var out: [String] = []
        for para in text.components(separatedBy: "\n\n") {
            let trimmed = para.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmed.count > 10 else { continue }
            if trimmed.count <= 300 {
                out.append(trimmed)
            } else {
                var rest = Substring(trimmed)
                while !rest.isEmpty {
                    out.append(String(rest.prefix(300)))
                    rest = rest.dropFirst(300)
                }
            }
        }
        return Array(out.prefix(400))   // hard cap: this is memory, not a corpus
    }

    // MARK: - Embedding

    private func embed(_ text: String) async -> [Float]? {
        if embedding == nil {
            let candidate = NLContextualEmbedding(language: .simplifiedChinese)
                ?? NLContextualEmbedding(language: .english)
            if let candidate, candidate.hasAvailableAssets {
                try? candidate.load()
                embedding = candidate
            }
        }
        guard let embedding, embedding.hasAvailableAssets else { return nil }
        guard let result = try? embedding.embeddingResult(for: String(text.prefix(300)), language: nil) else { return nil }
        // Mean-pool token vectors.
        var sum = [Float](repeating: 0, count: embedding.dimension)
        var count = 0
        result.enumerateTokenVectors(in: text.startIndex..<text.endIndex) { vector, _ in
            for (i, value) in vector.enumerated() where i < sum.count { sum[i] += Float(value) }
            count += 1
            return true
        }
        guard count > 0 else { return nil }
        return sum.map { $0 / Float(count) }
    }

    private static func cosine(_ a: [Float], _ b: [Float]) -> Float {
        guard a.count == b.count, !a.isEmpty else { return 0 }
        var dot: Float = 0, na: Float = 0, nb: Float = 0
        for i in a.indices { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
        let denom = (na.squareRoot() * nb.squareRoot())
        return denom > 0 ? dot / denom : 0
    }
}
