import CryptoKit
import Foundation

/// [T-ios-listsessions-perf] Send-path caches for the Anthropic provider.
enum ProviderSendPathCache {
    /// Cheap pre-check for the tool-patching injectors: each of them parses the
    /// ENTIRE request body (system prompt, full history, every tool schema) and
    /// re-serialises it, but does nothing unless a "tools" key exists. A byte
    /// scan cannot produce a false NEGATIVE (a real top-level "tools" key puts
    /// these exact bytes in the body); a false positive (the string inside
    /// message text) merely falls through to the parse that ran anyway.
    static func bodyMentionsTools(_ body: Data) -> Bool {
        let needle = Array("\"tools\"".utf8)
        let n = needle.count
        guard body.count >= n else { return false }
        return body.withUnsafeBytes { raw -> Bool in
            guard let base = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return true }
            let limit = body.count - n
            var i = 0
            while i <= limit {
                if base[i] == needle[0] {
                    var k = 1
                    while k < n, base[i + k] == needle[k] { k += 1 }
                    if k == n { return true }
                }
                i += 1
            }
            return false
        }
    }

    /// Memo of image downscale results. `convertMessages` runs over the WHOLE
    /// history every turn, so an image sent in turn 1 was decoded, redrawn and
    /// re-JPEG'd again on every later turn for a byte-identical result
    /// (upstream: 2.7 G cycles per turn, growing with the conversation).
    /// NSCache so multi-MB values are evicted under pressure. `NSNull` memoises
    /// "measured, no downscale needed" — otherwise every small image would miss
    /// forever and pay a full decode per turn.
    ///
    /// Keyed by SHA-256 of the FULL bytes, not `Data`'s Hashable: Foundation's
    /// Data hash only digests the length and the first 80 bytes, and two
    /// same-size screenshots share their headers — a collision there would send
    /// the model the wrong image.
    // NSCache is documented thread-safe; the static is immutable after init.
    nonisolated(unsafe) private static let downscaleCache: NSCache<NSString, AnyObject> = {
        let cache = NSCache<NSString, AnyObject>()
        cache.countLimit = 32
        return cache
    }()

    static func downscaleKey(_ data: Data, maxLongEdge: CGFloat) -> String {
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return "\(digest):\(Int(maxLongEdge))"
    }

    static func memoizedDownscale(_ data: Data, maxLongEdge: CGFloat, compute: (Data) -> Data?) -> Data? {
        let key = downscaleKey(data, maxLongEdge: maxLongEdge) as NSString
        if let hit = downscaleCache.object(forKey: key) {
            return (hit as? NSData) as Data?
        }
        let result = compute(data)
        downscaleCache.setObject((result as NSData?) ?? NSNull(), forKey: key)
        return result
    }

    static func clearDownscaleCache() { downscaleCache.removeAllObjects() }
}
