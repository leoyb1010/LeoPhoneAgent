#!/usr/bin/env python3
"""Run the actual enqueue method and UI readiness predicate with delayed-photo fixtures.
No iOS app, simulator, network, credentials or user files are touched.
"""
from pathlib import Path
import importlib.util
import subprocess
import tempfile
root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('audit_generator', root / 'scripts/native-model-audit/generate.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
source = (root / 'src/ios/Agent/Chat/AIChatViewModel+Misc.swift').read_text()
method = module.extract_swift_method(source, 'enqueuePrompt')
view = (root / 'src/ios/Views/Chat/AIChatView.swift').read_text()
predicate = view[view.index('    private var canEnqueue: Bool {'):view.index('    /// Whether the composer actually holds', view.index('    private var canEnqueue: Bool {'))].replace('private var', 'var')
models = (root / 'src/ios/Agent/Chat/ChatModels.swift').read_text()
start = models.index('struct QueuedPrompt:')
queued_type = models[start:models.index('\n}', start) + 2]
vm_source = (root / 'src/ios/Agent/Chat/AIChatViewModel.swift').read_text()
start = vm_source.index('            var combinedParts: [AgentContentPart] = []')
completed_wire = vm_source[start:vm_source.index('            let queueAgentMsg', start)]
start = vm_source.index('        var qCombinedParts: [AgentContentPart] = []')
interrupted_wire = vm_source[start:vm_source.index('        // Guard: if every queued prompt', start)]
start = vm_source.index('            if let treasuryContext, !treasuryContext.isEmpty {')
normal_wire = vm_source[start:vm_source.index('\n            }', vm_source.index('            if !text.isEmpty {', start)) + 14]
start = vm_source.index('        pendingTreasuryContext = nil', vm_source.index('        userDidCancel = false', vm_source.index('    func send()')))
normal_clear = vm_source[start:vm_source.index('        // If editing a previous message', start)]
swift = r'''
import Foundation
struct InputAttachment {
 enum State { case loading, ready, failed }
 enum Kind { case image, document }
 var loadState: State; var kind: Kind = .image
}
''' + queued_type + r'''
enum AgentContentPart: Equatable {case text(String)}
final class ChatMessage {
 enum Role { case user }
 var queuedPromptId: UUID?; var inputAttachments: [InputAttachment] = []; var attachments: [String] = []
 init(role: Role, content: String, isQueued: Bool) {}
}
struct Signal { func send() {} }
struct Logger { func info(_ text: String) {} }
let logger = Logger()
enum LeoHaptics { enum Weight { case light }; static func impact(_ weight: Weight) {} }
enum AgentChatCorrectness { static func shouldBlockImageAttachments(hasImages: Bool, supportsImageInput: Bool, visionGroupConfigured: Bool = false) -> Bool { hasImages && !supportsImageInput && !visionGroupConfigured } }
enum VisionGroupResolver { static var isConfigured: Bool { false } }
final class Harness {
 var inputText = "follow up"; var attachments: [InputAttachment] = []
 var isProcessing = true; var currentModelSupportsImageInput = true
 var imageUnsupportedNotice = "unsupported"
 var pendingTreasuryContext: String?
 var promptQueue: [QueuedPrompt] = []; var messages: [ChatMessage] = []; var pastedBlocks: [String] = []
 let scrollToBottomSignal = Signal()
 var hasLoadingAttachments: Bool { attachments.contains { $0.loadState == .loading } }
 func interceptModelCommand(_ text: String) -> Bool { false }
 var askUserWaiting = false
 func routeComposerToAskUser(text: String, hasAttachments: Bool) -> Bool { askUserWaiting && !hasAttachments }
 func syncSelectedModelFromBinding() {}
 func expandPastedBlocks(in text: String) -> String { text }
 func appendSystemInfo(_ text: String, icon: String) {}
 func dumpQueueSnapshot(_ text: String) {}
 static func cleanupAttachmentFiles(_ items: [InputAttachment]) {}
 func processAttachments(_ items: [InputAttachment], uploadsDir: URL, nowStr: String) -> ([AgentContentPart], [String]) { ([],[]) }
 func completedWire(_ queued: [QueuedPrompt]) -> [AgentContentPart] {
  let uploadsDir = URL(fileURLWithPath:"/fixture"); let nowStr = "fixture"
''' + completed_wire + r'''
  return combinedParts
 }
 func interruptedWire(_ queued: [QueuedPrompt]) -> [AgentContentPart] {
  let qUploadsDir = URL(fileURLWithPath:"/fixture"); let qNowStr = "fixture"
''' + interrupted_wire + r'''
  return qCombinedParts
 }
 func normalWire() -> [AgentContentPart] {
  let text = inputText; let treasuryContext = pendingTreasuryContext
  var userParts: [AgentContentPart] = []
''' + normal_clear + normal_wire + r'''
  return userParts
 }
''' + method + r'''
}
struct UIHarness { let vm: Harness
''' + predicate + r'''
}
func expect(_ condition: Bool, _ message: String) { if !condition { print("FAIL: " + message); exit(1) } }
let delayed = Harness(); delayed.attachments = [.init(loadState: .loading)]
expect(!UIHarness(vm: delayed).canEnqueue, "UI offered enqueue before picked photo finished loading")
delayed.enqueuePrompt()
expect(delayed.promptQueue.isEmpty && delayed.attachments.count == 1 && delayed.inputText == "follow up", "method lost loading photo or draft")
delayed.attachments[0].loadState = .ready
delayed.enqueuePrompt()
expect(delayed.promptQueue.count == 1 && delayed.promptQueue[0].attachments.count == 1 && delayed.inputText.isEmpty, "settled photo cannot be queued")
let partial = Harness(); partial.attachments = [.init(loadState: .ready), .init(loadState: .failed)]
partial.enqueuePrompt()
expect(partial.promptQueue.first?.attachments.count == 1, "failed photo placeholder entered queue")
let failedOnly = Harness(); failedOnly.inputText = ""; failedOnly.attachments = [.init(loadState: .failed)]
failedOnly.enqueuePrompt()
expect(failedOnly.promptQueue.isEmpty, "failed-only attachment queued an empty turn")
let treasury = Harness(); treasury.pendingTreasuryContext = "<treasury_context>queued material</treasury_context>"
treasury.enqueuePrompt()
expect(treasury.pendingTreasuryContext == nil && treasury.promptQueue.first?.treasuryContext != nil, "queued material stayed on composer instead of its prompt")
let expected: [AgentContentPart] = [.text("<treasury_context>queued material</treasury_context>"), .text("follow up")]
expect(treasury.completedWire(treasury.promptQueue) == expected, "post-run drain lost material or mixed it into the editable instruction")
expect(treasury.interruptedWire(treasury.promptQueue) == expected, "tool-boundary drain lost material")
let answering = Harness(); answering.askUserWaiting = true
answering.enqueuePrompt()
expect(answering.promptQueue.isEmpty && answering.messages.isEmpty && answering.inputText.isEmpty, "typed answer to a waiting question was queued as a new turn")
let ordinary = Harness(); ordinary.pendingTreasuryContext = "<treasury_context>normal material</treasury_context>"
expect(ordinary.normalWire() == [.text("<treasury_context>normal material</treasury_context>"), .text("follow up")], "normal wire lost context")
ordinary.inputText = "unrelated next question"
expect(ordinary.normalWire() == [.text("unrelated next question")], "normal send reused prior context")
print("PASS production enqueue and wire blocks: loading gates, normal send, queued context, both drains, no next-turn reuse, typed answer to a waiting question")
'''
with tempfile.TemporaryDirectory(prefix='leo-composer-queue-') as folder:
    code = Path(folder) / 'main.swift'; code.write_text(swift)
    binary = Path(folder) / 'smoke'
    subprocess.run(['swiftc', str(code), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
