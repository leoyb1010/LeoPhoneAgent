//  TextFadeAnimator.swift
//  LeoPhoneAgent
//
//  Word-by-word fade-in animation for streaming Markdown output.
//
//  When the renderer appends new tokens to a message's textStorage via the
//  `[AttachHotPath]` append-only fast path in SelectableMarkdownView, instead
//  of the new glyphs popping in instantly we fade each word from alpha 0 → 1
//  with a small per-word stagger, producing a "ripple" reveal.
//
//  Design constraints (see /tmp/task_word_fade_animation.md):
//   - Display-layer only. Does NOT touch MinisMarkdownParser / AST /
//     MarkdownNSRenderer. We mutate the live NSTextStorage's `.foregroundColor`
//     attribute and rely on TextKit 1's behaviour that a foregroundColor change
//     does NOT invalidate layout (no `ensureLayout` reflow) — only a redraw.
//   - O(new words), never O(full text). Only the appended NSRange is scanned.
//   - A single CADisplayLink drives ALL in-flight words; it stops itself once
//     every word has settled, so an idle (non-streaming) view costs nothing.
//
//  This file deliberately owns no parsing or rendering logic; it is a pure
//  per-word alpha scheduler over an existing NSTextStorage.

import UIKit

/// Drives word-by-word alpha fade-in for newly appended text in an
/// NSTextStorage. Lives on the SelectableMarkdownView Coordinator; one
/// instance per on-screen textView.
@MainActor
final class TextFadeAnimator {

    // MARK: - Tunables

    /// How long a single word takes to fade from alpha 0 → 1. Matches
    /// Microsoft SwiftStreamingMarkdown's 0.5s; slightly shorter reads as more
    /// responsive on a phone without losing the smooth settle.
    private static let wordFadeDuration: CFTimeInterval = 0.45

    /// Hard cap on how many reveal units (words + inter-word gaps) a single
    /// schedule call will animate. A large paste (or a big non-streaming
    /// append) would otherwise schedule hundreds of fades on one frame; above
    /// this we skip the animation entirely and let the text appear instantly.
    /// Streaming appends are only a handful of units per call, so this never
    /// trips during normal output. Raised from 80 since each word now also
    /// contributes its trailing-gap unit (~2× the count for the same text).
    private static let maxAnimatedWords = 160

    /// Whether a streamed append should fade at all. Reduce Motion means a
    /// plain cut (not a shorter animation); on iOS 27 the system can also ask
    /// apps to go easy on resources, and a per-frame display link is the first
    /// thing to give up.
    static var isEnabled: Bool {
        if UIAccessibility.isReduceMotionEnabled { return false }
        if UIApplication.shared.systemPrefersReducedResourceUsage { return false }
        return true
    }

    // MARK: - State

    private struct FadeWord {
        let range: NSRange
        let startTime: CFTimeInterval
        let duration: CFTimeInterval
        /// Original (fully-opaque) foreground color to restore on completion.
        let originalColor: UIColor
    }

    /// The storage we mutate. Weak — the textView (and its storage) outlives
    /// us via the Coordinator, but we never want to keep it alive ourselves.
    private weak var storage: NSTextStorage?
    /// Called after each frame's attribute mutation so the textView repaints.
    /// Weak capture lives in the closure the owner supplies.
    private let requestRedraw: () -> Void

    private var words: [FadeWord] = []
    private var displayLink: CADisplayLink?
    /// [output-render] Spreads each batch over the gap until the next flush (see StreamRevealPacer).
    private var pacer = StreamRevealPacer()

    // MARK: - Init

    /// - Parameter requestRedraw: invoked on the main thread after each frame's
    ///   alpha mutation. The owner should call `textView.setNeedsDisplay()`.
    init(requestRedraw: @escaping () -> Void) {
        self.requestRedraw = requestRedraw
    }

    deinit {
        // CADisplayLink retains its target; we invalidate in cancelAll, but
        // guard here too in case the owner is torn down mid-animation.
        displayLink?.invalidate()
    }

    // MARK: - Scheduling

    /// Begin fading the words inside `range` of `targetStorage` from alpha 0 → 1.
    ///
    /// Call this from the append-only fast path AFTER `replaceCharacters`, with
    /// the NSRange of the freshly-appended tail. Safe to call repeatedly while
    /// streaming — each call adds its words to the shared in-flight set.
    func scheduleAnimation(for range: NSRange, in targetStorage: NSTextStorage) {
        guard range.length > 0 else { return }
        let storageLen = targetStorage.length
        // Defensive clamp: the caller computed `range` from the same storage,
        // but a racing edit could have shrunk it. Never index out of bounds.
        guard range.location >= 0, range.location < storageLen else { return }
        let safeRange = NSRange(
            location: range.location,
            length: min(range.length, storageLen - range.location)
        )
        guard safeRange.length > 0 else { return }

        self.storage = targetStorage

        // Split the appended tail into reveal units. Unlike a bare
        // `.byWords` enumeration (which omits the punctuation / whitespace /
        // symbols / emoji BETWEEN words, leaving them to pop in instantly),
        // this also emits the inter-word gaps + leading/trailing separators so
        // EVERY character in the new range fades — matching Microsoft
        // SwiftStreamingMarkdown's `splitIntoWords`. We collect ranges first
        // (cheap, read-only) so we can bail before mutating on a huge paste.
        let nsString = targetStorage.string as NSString
        // Code (monospaced) and attachments (images, tables, formulas) appear
        // as they are: fading code leaves its background box empty for half a
        // second, and attachment views ignore the text color anyway.
        let wordRanges = Self.revealUnits(in: nsString, within: safeRange, cap: Self.maxAnimatedWords)
            .filter { !Self.isStatic($0, in: targetStorage) }

        // Word count over the cap → skip the animation for this batch. The
        // text is already in the storage at full opacity, so it just appears.
        guard !wordRanges.isEmpty, wordRanges.count <= Self.maxAnimatedWords else { return }

        let now = CACurrentMediaTime()
        // [output-render] The batch's ripple is spread over ~85% of the gap since the previous
        // flush (0.1–0.42 s) rather than a fixed 0.1 s, so a 300–500 ms flush reads as a steady
        // flow instead of a sentence popping in and then sitting still. Each batch starts after
        // the previous batch's last word (reading order) but never more than 0.2 s past now,
        // so a burst cannot queue up a growing tail.
        let plan = pacer.plan(unitCount: wordRanges.count, now: now)
        let step = plan.step
        let baseStart = plan.base

        // Batch all alpha-0 writes inside one begin/endEditing so TextKit only
        // posts a single processEditing pass for the whole appended tail.
        targetStorage.beginEditing()
        for (i, wr) in wordRanges.enumerated() {
            let original = currentForegroundColor(at: wr.location, in: targetStorage)
            let start = baseStart + CFTimeInterval(i) * step
            words.append(FadeWord(
                range: wr,
                startTime: start,
                duration: Self.wordFadeDuration,
                originalColor: original
            ))
            // Seed at alpha 0.
            targetStorage.addAttribute(
                .foregroundColor,
                value: original.withAlphaComponent(0),
                range: wr
            )
        }
        targetStorage.endEditing()

        requestRedraw()
        startDisplayLinkIfNeeded()
    }

    /// Cancel every in-flight fade and restore full opacity immediately. Called
    /// on a new message, rotation/width change, or any non-append update — the
    /// ranges we hold are no longer valid against the rebuilt storage.
    func cancelAll() {
        stopDisplayLink()
        pacer.reset()
        // Snap any partially-faded words to their final color so nothing is
        // left stuck translucent. Only safe while `storage` still holds the
        // ranges we recorded; on a full replace the caller has already swapped
        // storage, in which case the ranges are stale and we simply drop them.
        if let storage, !words.isEmpty {
            let len = storage.length
            storage.beginEditing()
            for w in words where w.range.location + w.range.length <= len {
                storage.addAttribute(.foregroundColor, value: w.originalColor, range: w.range)
            }
            storage.endEditing()
            requestRedraw()
        }
        words.removeAll(keepingCapacity: true)
    }

    // MARK: - Diff support

    /// 淡入中的词在 storage 里是半透明色，updateUIView 的「前缀不变→只追加」比较会因此失败，
    /// 每次 flush 都退化成整段重新赋值。比较前先把这些词恢复成原色，比较/追加完再调用
    /// `reapplyInFlightAlpha()` 写回当前透明度（同一个 runloop 内，不会画出全不透明的一帧）。
    func restoreOriginalColorsForDiff() {
        guard let storage, !words.isEmpty else { return }
        let len = storage.length
        storage.beginEditing()
        for w in words where NSMaxRange(w.range) <= len {
            storage.addAttribute(.foregroundColor, value: w.originalColor, range: w.range)
        }
        storage.endEditing()
    }

    func reapplyInFlightAlpha() {
        guard let storage, !words.isEmpty else { return }
        let now = CACurrentMediaTime()
        let len = storage.length
        storage.beginEditing()
        for w in words where NSMaxRange(w.range) <= len {
            let t = max(0, min(1, (now - w.startTime) / w.duration))
            storage.addAttribute(.foregroundColor,
                                 value: w.originalColor.withAlphaComponent(CGFloat(Self.easeOutCubic(t))),
                                 range: w.range)
        }
        storage.endEditing()
    }

    // MARK: - Frame loop

    private func startDisplayLinkIfNeeded() {
        guard displayLink == nil, !words.isEmpty else { return }
        let link = CADisplayLink(target: self, selector: #selector(tick))
        // 降频到 30Hz：每帧都要改 textStorage（iOS 的 NSLayoutManager 没有 temporary attributes），
        // 0.45s 的淡入 30Hz 已经够平滑，60/120Hz 只是多一倍 processEditing。
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 20, maximum: 60, preferred: 30)
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    private func stopDisplayLink() {
        displayLink?.invalidate()
        displayLink = nil
    }

    @objc private func tick() {
        guard let storage else {
            stopDisplayLink()
            words.removeAll(keepingCapacity: true)
            return
        }
        let now = CACurrentMediaTime()
        let storageLen = storage.length

        var completed: [Int] = []
        storage.beginEditing()
        for (i, w) in words.enumerated() {
            // Stale range guard — a racing edit could have invalidated it.
            guard w.range.location + w.range.length <= storageLen else {
                completed.append(i)
                continue
            }
            let elapsed = now - w.startTime
            if elapsed <= 0 {
                continue // not started yet (still inside its stagger delay)
            }
            let t = min(1, elapsed / w.duration)
            let eased = Self.easeOutCubic(t)
            let color = w.originalColor.withAlphaComponent(CGFloat(eased))
            storage.addAttribute(.foregroundColor, value: color, range: w.range)
            if t >= 1 {
                // Restore the exact original (avoids float-rounding leaving a
                // hair under full opacity) and retire the word.
                storage.addAttribute(.foregroundColor, value: w.originalColor, range: w.range)
                completed.append(i)
            }
        }
        storage.endEditing()

        if !completed.isEmpty {
            // Remove from the back so earlier indices stay valid.
            for i in completed.reversed() {
                words.remove(at: i)
            }
        }

        requestRedraw()

        if words.isEmpty {
            stopDisplayLink()
        }
    }

    // MARK: - Helpers

    /// ease-out cubic: `1 - (1 - t)³`. Fast start, gentle settle.
    private static func easeOutCubic(_ t: CFTimeInterval) -> CFTimeInterval {
        let inv = 1 - t
        return 1 - inv * inv * inv
    }

    /// Split `range` of `string` into contiguous reveal units that together
    /// cover EVERY character — words PLUS the punctuation / whitespace /
    /// symbol / emoji gaps between and around them. A bare `.byWords`
    /// enumeration skips those gaps, so they'd pop in at full opacity instead
    /// of fading; this mirrors Microsoft SwiftStreamingMarkdown's
    /// `splitIntoWords`, which appends leading / inter-word / trailing gaps as
    /// their own ranges. Returns empty if the unit count would exceed `cap`
    /// (caller then skips the animation for that oversized batch). Falls back
    /// to the whole range as a single unit when no word boundary is found
    /// (e.g. a pure-symbol / emoji-only tail).
    private static func revealUnits(in string: NSString, within range: NSRange, cap: Int) -> [NSRange] {
        var units: [NSRange] = []
        var overflow = false
        let appendGap = { (start: Int, end: Int) in
            if end > start { units.append(NSRange(location: start, length: end - start)) }
        }
        string.enumerateSubstrings(in: range, options: [.byWords, .localized, .substringNotRequired]) { _, wordRange, _, stop in
            // Gap before this word: trailing edge of the previous unit (or the
            // range start) up to the word's start.
            let gapStart = units.last.map { NSMaxRange($0) } ?? range.location
            appendGap(gapStart, wordRange.location)
            units.append(wordRange)
            if units.count > cap { overflow = true; stop.pointee = true }
        }
        if overflow { return [] }
        // Trailing separators after the last word (or the whole range if there
        // were no words at all — pure punctuation / emoji).
        let tailStart = units.last.map { NSMaxRange($0) } ?? range.location
        appendGap(tailStart, NSMaxRange(range))
        if units.count > cap { return [] }
        return units
    }

    private static func isStatic(_ range: NSRange, in storage: NSTextStorage) -> Bool {
        guard range.location < storage.length else { return true }
        if storage.attribute(.attachment, at: range.location, effectiveRange: nil) != nil { return true }
        if let font = storage.attribute(.font, at: range.location, effectiveRange: nil) as? UIFont,
           font.fontDescriptor.symbolicTraits.contains(.traitMonoSpace) { return true }
        return false
    }

    /// The foreground color a glyph currently carries, defaulting to label.
    /// We read it (rather than assuming `.label`) so colored inline spans —
    /// links, syntax-highlighted code, custom-styled runs — fade back to their
    /// real color rather than to black.
    private func currentForegroundColor(at location: Int, in storage: NSTextStorage) -> UIColor {
        guard location >= 0, location < storage.length else { return .label }
        if let c = storage.attribute(.foregroundColor, at: location, effectiveRange: nil) as? UIColor {
            return c
        }
        return .label
    }
}
