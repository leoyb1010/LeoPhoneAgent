import CoreGraphics
import Foundation

// MARK: - Height cache [T-ios-listsessions-perf]

/// Cache key for a measured text-block height.
///
/// Built from the MARKDOWN SOURCE (`block.content`), not the rendered string
/// or the NSAttributedString's identity. The rendered plain text has markup
/// stripped (`**bold**` and `bold` collide while measuring differently), and
/// an `ObjectIdentifier` key misses on every re-render of identical text
/// (stream finalize, compaction re-parse, session reload) — and can even HIT
/// for a different string that reused a freed object's address.
///
/// `width` and `fontSize` are part of the key rather than reasons to clear:
/// the LRU survives session change, so rotation and Dynamic Type must MISS
/// rather than serve a stale height. Stored at 0.01 pt precision: a wrap can
/// turn on a fraction of a point, and two widths that merely round to the
/// same integer must not share a height.
///
/// UTF-8 length (O(1) on native strings) is kept beside the hash so an
/// accidental hash collision between two bodies is vanishingly unlikely.
struct HeightCacheKey: Hashable {
    let contentLength: Int
    let contentHash: Int
    let width: Int
    let fontSize: Int

    init(content: String, width: CGFloat, fontSize: CGFloat) {
        self.contentLength = content.utf8.count
        self.contentHash = content.hashValue
        self.width = Int((width * 100).rounded())
        self.fontSize = Int((fontSize * 100).rounded())
    }
}

/// Small insertion-ordered cache for measured heights, bounded because it
/// outlives session change. 300 entries covers several screens of several
/// sessions (the reopen-a-session-you-were-just-in window that matters) while
/// staying negligible in memory. Reads do not reorder (that would make every
/// hit an O(n) array removal on the main thread), so eviction is FIFO — for a
/// snapshot pass sweeping a page of blocks that is equivalent to LRU.
struct HeightLRU {
    private var storage: [HeightCacheKey: CGFloat] = [:]
    private var order: [HeightCacheKey] = []
    private let capacity: Int

    init(capacity: Int) {
        self.capacity = max(1, capacity)
        storage.reserveCapacity(self.capacity)
        order.reserveCapacity(self.capacity)
    }

    var count: Int { storage.count }

    subscript(key: HeightCacheKey) -> CGFloat? {
        get { storage[key] }
        set {
            guard let newValue else {
                if storage.removeValue(forKey: key) != nil {
                    order.removeAll { $0 == key }
                }
                return
            }
            if storage.updateValue(newValue, forKey: key) == nil {
                order.append(key)
                while order.count > capacity {
                    storage.removeValue(forKey: order.removeFirst())
                }
            }
        }
    }

    mutating func removeAll() {
        storage.removeAll(keepingCapacity: true)
        order.removeAll(keepingCapacity: true)
    }
}
