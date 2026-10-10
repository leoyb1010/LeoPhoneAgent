import Foundation

/// [P2] Memo for values a SwiftUI body derives from its inputs. Holds the last
/// `capacity` (key, value) pairs; `value(for:compute:)` recomputes only when
/// the key is new. Kept in `@State` as a reference so storing into it during a
/// body evaluation never triggers another update.
///
/// The key must capture every input of `compute` — including a coarse clock
/// bucket when the value depends on "now".
final class KeyedMemo<Key: Equatable, Value> {
    private var entries: [(key: Key, value: Value)] = []
    private let capacity: Int
    private(set) var computeCount = 0

    init(capacity: Int = 2) {
        self.capacity = max(1, capacity)
    }

    func value(for key: Key, compute: () -> Value) -> Value {
        if let index = entries.firstIndex(where: { $0.key == key }) {
            let hit = entries.remove(at: index)
            entries.append(hit)
            return hit.value
        }
        let value = compute()
        computeCount += 1
        entries.append((key, value))
        if entries.count > capacity { entries.removeFirst(entries.count - capacity) }
        return value
    }
}
