import Foundation

/// [T-ios-openai-body-oom] Refuse a request body that would abort the process while
/// being serialized.
///
/// When NSJSONSerialization cannot grow its output buffer it calls
/// `_CFRaiseMemoryException` → `abort()`: a process abort, not a Swift error, so `try`
/// around `JSONSerialization.data` cannot catch it. The check has to happen BEFORE the
/// call. Serializing costs ~3x the body at peak (source dictionary + old buffer + the
/// doubled new buffer), and the crash population is exactly the long conversations with
/// inlined base64 images that have already eaten most of the footprint budget.
///
/// Pure (no logging, no globals) so the logic tests compile it directly.
enum RequestBodySizeGuard {

    /// Hard ceiling on the estimated serialized body. No legitimate text request comes
    /// close (200k tokens of text is under 1 MB); 32 MB means pathological history.
    static let maxRequestBodyBytes = 32 * 1024 * 1024

    /// Bodies below this skip the free-memory check, so a near-death transient dip never
    /// fails an ordinary request that would cost a few hundred KB to serialize.
    static let headroomFloorBytes = 4 * 1024 * 1024

    enum Verdict: Equatable {
        case ok
        /// Over the fixed ceiling: (estimated MB, limit MB).
        case tooLarge(estimatedMB: Int, limitMB: Int)
        /// Not enough free process memory to serialize: (needed MB, available MB).
        case insufficientMemory(neededMB: Int, availableMB: Int)
    }

    /// Approximate serialized JSON size WITHOUT serializing. Strings count utf8 bytes
    /// scaled up 25% (escape-heavy content measured ~0.79 of actual), so the estimate
    /// errs high. Pathological nesting returns the ceiling instead of recursing into a
    /// stack overflow, and walking stops as soon as the ceiling is reached.
    static func estimateSerializedSize(_ value: Any, depth: Int = 0) -> Int {
        if depth > 64 { return maxRequestBodyBytes }
        switch value {
        case let s as String:
            return (s.utf8.count * 5) / 4 + 2
        case let dict as [String: Any]:
            var total = 2
            for (k, v) in dict {
                total += k.utf8.count + 4
                total += estimateSerializedSize(v, depth: depth + 1)
                if total >= maxRequestBodyBytes { return total }
            }
            return total
        case let array as [Any]:
            var total = 2
            for v in array {
                total += estimateSerializedSize(v, depth: depth + 1) + 1
                if total >= maxRequestBodyBytes { return total }
            }
            return total
        case let data as Data:
            return data.count
        case is NSNull:
            return 4
        case let n as NSNumber:
            return CFGetTypeID(n) == CFBooleanGetTypeID() ? 5 : 20
        default:
            return 16
        }
    }

    /// `availableMemory` is `os_proc_available_memory()`; 0 means "unknown" (some
    /// extension/simulator contexts) and is never read as "no memory".
    static func verdict(estimated: Int, availableMemory: Int) -> Verdict {
        let mb = 1024 * 1024
        if estimated >= maxRequestBodyBytes {
            return .tooLarge(estimatedMB: estimated / mb, limitMB: maxRequestBodyBytes / mb)
        }
        if estimated > headroomFloorBytes, availableMemory > 0, estimated * 3 > availableMemory {
            return .insufficientMemory(neededMB: estimated * 3 / mb, availableMB: availableMemory / mb)
        }
        return .ok
    }

    /// User-facing message for a refusal; nil for `.ok`.
    static func message(for verdict: Verdict) -> String? {
        switch verdict {
        case .ok:
            return nil
        case .tooLarge(let est, let limit):
            return String(localized: "请求太大（约 \(est) MB，上限 \(limit) MB）。请新开会话，或移除较大的图片/附件后重试。")
        case .insufficientMemory(let needed, let available):
            return String(localized: "内存不足，无法发送这次请求（约需 \(needed) MB，剩余 \(available) MB）。请关闭其他会话或重启 App 后重试。")
        }
    }
}
