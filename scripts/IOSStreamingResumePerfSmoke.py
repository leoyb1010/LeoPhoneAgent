#!/usr/bin/env python3
"""Execute production resume/cache control flow with frame/render adapters.
No model, database or network. Renderer adapter counts work, not measured UI time.
"""
from pathlib import Path
import importlib.util
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("generator", root / "scripts/native-model-audit/generate.py")
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)
lifecycle = (root / "src/ios/Agent/Chat/ChatLifecycleSupport.swift").read_text()
vm = (root / "src/ios/Agent/Chat/AIChatViewModel.swift").read_text()
models = (root / "src/ios/Agent/Chat/ChatModels.swift").read_text()
methods = "\n".join(generator.extract_swift_method(lifecycle, name) for name in [
    "suspendAllStreamingUI", "resumeAllStreamingUI", "scheduleNextStreamingResume", "resumeNextStreamingUI"])
cache_method = generator.extract_swift_method(vm, "cacheAttributedString")
vm_methods = "\n".join(generator.extract_swift_method(vm, name) for name in [
    "setStreamingUIUpdatesSuspended", "flushDeferredStreamingTextUpdateIfNeeded",
    "clearStreamingUIUpdatesSuspended", "applyStreamingTextBlockContent", "cacheAttributedString"])

properties = []
for name in ["cachedMarkdown", "cachedAttributedString"]:
    start = models.index("    var " + name + ":")
    end = models.index("\n    }", start) + 6
    properties.append(models[start:end])
source = r'''
import Foundation
import CoreFoundation
@MainActor enum UIApplication {
    static let shared = Application()
    final class Application { var applicationState = State.active }
    enum State { case active, inactive }
}
@MainActor enum NotificationCenter {
    static let `default` = Center()
    final class Center { var ids: [String] = []; func post(name: String, object: String) { ids.append(object) } }
}
extension String { static let sessionDidUpdate = "update" }
@MainActor enum LeoPerf {
    static var frames: [@MainActor () -> Void] = []
    static func afterNextFrame(_ work: @escaping @MainActor () -> Void) { frames.append(work) }
    static func record(_ event: String, ms: Double, extra: [String: Any]) {}
    static func pump() { let work = frames.removeFirst(); work() }
}
struct Logger { func info(_ message: String) {} }
let logger = Logger()
@MainActor final class AIChatViewModel {
    static var activeSessionId: String? = "front"
    var streamingUIUpdatesSuspended = true
    var isProcessing = true
    var resumed = 0
    var sessionId: String? = "fixture"
    var isNearBottom = true
    var needsSnapshotReloadOnResume = true
    var events: [String] = []
    var messages = [Message()]
    var onStreamingUIUpdatesResumed: (() -> Void)?
    let retrySnapshotReloadSignal = VoidSignal()
    let objectWillChange = VoidSignal()
    let scrollToBottomSignal = VoidSignal()
    let blockContentFilledSignal = FillSignal()
    private struct DeferredStreamingTextUpdate {
        let messageId: UUID; let blockId: UUID; let text: String
        let parsedMarkdown: MarkdownContent?; let cacheAttributedString: Bool
    }
    private var deferredStreamingTextUpdates: [DeferredStreamingTextUpdate] = []
    init() {
        onStreamingUIUpdatesResumed = { [weak self] in
            guard let self else { return }
            self.resumed += 1; self.events.append("hook:" + self.messages[0].blocks[0].content)
        }
        retrySnapshotReloadSignal.action = { [weak self] in self?.events.append("snapshot") }
        objectWillChange.action = { [weak self] in self?.events.append("publish") }
    }
    func queueFinal(_ text: String) {
        let message = messages[0]; let block = message.blocks[0]
        deferredStreamingTextUpdates = [DeferredStreamingTextUpdate(messageId: message.id,
            blockId: block.id, text: text, parsedMarkdown: nil, cacheAttributedString: true)]
    }
''' + vm_methods + r'''
}
@MainActor final class ResumeHost {
    var cache: [String: AIChatViewModel] = ["front": AIChatViewModel(), "back": AIChatViewModel(), "other": AIChatViewModel()]
    var lruOrder = ["front", "other", "back"]
    private var streamingResumeGeneration = 0
    private var pendingStreamingResume: [String] = []
    private var resumedStreamingCount = 0
''' + methods + r'''
}
var parseCount = 0
var renderCount = 0
@MainActor final class VoidSignal { var action: (() -> Void)?; func send() { action?() } }
@MainActor final class FillSignal { func send(_ value: (messageId: UUID, blockId: UUID)) {} }
struct Message { let id = UUID(); var blocks = [AssistantBlock()] }
enum Kind { case text; var logTag: String { "text" } }
struct MarkdownContent { let blocks: [String]; init(_ text: String) { parseCount += 1; blocks = [text] } }
enum MarkdownRenderCap { static func head(_ text: String) -> String { text } }
func prepareMarkdownForRender(_ text: String) -> String { text }
func renderMarkdownBlocksForDisplay(_ blocks: [String], source: String) -> NSAttributedString {
    renderCount += 1; return NSAttributedString(string: source)
}
final class AssistantBlock {
    let id = UUID()
    let kind = Kind.text
    var content = "first"
    var isStreamingText = true
    var cachedMarkdownSource: String?
    var cachedAttributedSource: String?
    func publishChange() {}
    func applyBatched(_ work: () -> Void) { work() }
''' + "\n".join(properties) + r'''
}
@MainActor final class CacheHost {
''' + cache_method + r'''
}
@main struct Regression {
    @MainActor static func main() {
        let host = ResumeHost()
        host.resumeAllStreamingUI()
        precondition(host.cache.values.allSatisfy { $0.streamingUIUpdatesSuspended })
        LeoPerf.pump()
        precondition(host.cache["front"]!.resumed == 1)
        precondition(host.cache["back"]!.resumed == 0 && host.cache["other"]!.resumed == 0)
        host.suspendAllStreamingUI()
        LeoPerf.pump() // stale callback cannot drain or mutate the new suspension
        precondition(host.cache.values.allSatisfy { $0.streamingUIUpdatesSuspended })
        host.resumeAllStreamingUI()
        while !LeoPerf.frames.isEmpty { LeoPerf.pump() }
        precondition(host.cache.values.allSatisfy { !$0.streamingUIUpdatesSuspended })
        precondition(Set(NotificationCenter.default.ids) == Set(["front", "back", "other"]))
        let completed = ResumeHost()
        completed.cache["front"]!.isProcessing = false // completed while suspended
        completed.cache["front"]!.queueFinal("final-before-resume")
        completed.resumeAllStreamingUI()
        LeoPerf.pump()
        let front = completed.cache["front"]!
        precondition(front.messages[0].blocks[0].content == "final-before-resume")
        precondition(front.events == ["hook:final-before-resume", "snapshot", "publish"])
        precondition(!front.messages[0].blocks[0].isStreamingText)
        completed.cache["back"]!.isProcessing = false // completed while queued
        completed.cache["back"]!.queueFinal("final-while-queued")
        while !LeoPerf.frames.isEmpty { LeoPerf.pump() }
        let back = completed.cache["back"]!
        precondition(back.messages[0].blocks[0].content == "final-while-queued")
        precondition(back.events == ["hook:final-while-queued", "snapshot", "publish"])
        parseCount = 0; renderCount = 0
        let block = AssistantBlock(); let cache = CacheHost()
        cache.cacheAttributedString(for: block)
        for _ in 0..<100 { cache.cacheAttributedString(for: block) }
        precondition(parseCount == 1 && renderCount == 1)
        block.content = "changed"
        cache.cacheAttributedString(for: block)
        precondition(parseCount == 2 && renderCount == 2 && block.cachedAttributedString!.string == "changed")
        block.cachedAttributedString = nil // theme / typography invalidation
        cache.cacheAttributedString(for: block)
        precondition(parseCount == 2 && renderCount == 3)
        precondition(!block.isStreamingText)
        print("PASS: production resume is frame-bounded, active-first and cancellation-safe; list notifications retained")
        print("PASS: actual production deferred flush, resume hook, snapshot signal and publication preserve text completed before/during the queue")
        print("PASS: production cache parses/renders once for 101 unchanged calls; changed source and theme still invalidate")
    }
}
'''
with tempfile.TemporaryDirectory(prefix="leo-resume-perf-") as tmp:
    tmp = Path(tmp)
    (tmp / "Regression.swift").write_text(source)
    subprocess.run(["xcrun", "swiftc", "-swift-version", "5", "-parse-as-library", str(tmp / "Regression.swift"), "-o", str(tmp / "regression")], check=True, timeout=120)
    subprocess.run([str(tmp / "regression")], check=True, timeout=30)
