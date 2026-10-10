import Foundation

/// [V-vad] 有上限的环形缓冲:VAD 的「全部原始音频」兜底缓冲。
///
/// 旧实现是 `[Float]` + `removeFirst(n)`:录满 5 分钟后,实时音频线程上每个 tap 回调都要把
/// 1440 万个采样整体前移(≈58 MB memmove),越录越卡。这里追加和裁剪都是 O(本次写入量),
/// 与已缓冲的总量无关;只有取出全部(`drain`)或取尾部(`suffix`)时才拷贝。
///
/// 存储按需增长(短语音不会一上来就占满 5 分钟的 58 MB),长到上限后改为循环覆盖最旧的数据。
struct FloatRingBuffer: Sendable {
    private var storage: [Float] = []
    /// 存满之后,下一个写入位置(也是最旧数据的位置)。
    private var head = 0
    private(set) var capacity: Int

    init(capacity: Int) {
        self.capacity = max(1, capacity)
    }

    var count: Int { storage.count }
    var isEmpty: Bool { storage.isEmpty }

    /// 追加;超过上限时最旧的数据被覆盖。
    mutating func append<C: Collection>(contentsOf samples: C) where C.Element == Float {
        var incoming = samples.count
        guard incoming > 0 else { return }
        var source = samples.startIndex
        // 一次写入比上限还大:只有最后 capacity 个有意义。
        if incoming > capacity {
            source = samples.index(source, offsetBy: incoming - capacity)
            incoming = capacity
        }
        // 还没长满:直接接在后面(摊还 O(1))。
        let room = capacity - storage.count
        if room > 0 {
            let take = min(room, incoming)
            let end = samples.index(source, offsetBy: take)
            storage.append(contentsOf: samples[source..<end])
            source = end
            incoming -= take
            head = 0
            guard incoming > 0 else { return }
        }
        // 已满:覆盖最旧的。
        let cap = storage.count
        var h = head
        storage.withUnsafeMutableBufferPointer { buf in
            var idx = source
            for _ in 0..<incoming {
                buf[h] = samples[idx]
                idx = samples.index(after: idx)
                h += 1
                if h == cap { h = 0 }
            }
        }
        head = h
    }

    /// 最近的 `n` 个采样(按时间顺序)。
    func suffix(_ n: Int) -> [Float] {
        let total = storage.count
        let take = max(0, min(n, total))
        guard take > 0 else { return [] }
        // 未满时 head == 0,最新的数据在末尾;已满时最新的在 head 之前。
        let newestEnd = storage.count < capacity ? total : head
        let start = (newestEnd - take + total) % total
        if start + take <= total {
            return Array(storage[start..<(start + take)])
        }
        return Array(storage[start..<total]) + Array(storage[0..<(take - (total - start))])
    }

    /// 全部内容(按时间顺序)。
    var contents: [Float] { suffix(count) }

    mutating func removeAll() {
        storage.removeAll(keepingCapacity: true)
        head = 0
    }

    /// 取出全部并清空。
    mutating func drain() -> [Float] {
        let out = contents
        removeAll()
        return out
    }

    /// 上限改变(采样率变了):保留最近的数据。
    mutating func resize(capacity newCapacity: Int) {
        let cap = max(1, newCapacity)
        guard cap != capacity else { return }
        let keep = suffix(min(count, cap))
        capacity = cap
        storage = []
        head = 0
        append(contentsOf: keep)
    }
}
