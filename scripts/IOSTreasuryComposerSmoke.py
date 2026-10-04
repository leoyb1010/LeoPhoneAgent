#!/usr/bin/env python3
"""Actual draft codecs/lifecycle and transfer methods with disposable storage.
Only app-support/cache directory locations are redirected; no user's draft is read.
"""
from pathlib import Path
import importlib.util,subprocess,tempfile
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('audit_generator',root/'scripts/native-model-audit/generate.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
source=(root/'src/ios/Agent/Chat/AIChatViewModel+Attachments.swift').read_text()
store=source[source.index('struct ComposerDraftSnapshot {'):source.index('extension AIChatViewModel {',source.index('struct ComposerDraftSnapshot {'))]
store=store.replace('FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]', 'fixtureRoot')
store=store.replace('FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]', 'fixtureRoot')
start=source.index('    var currentComposerDraft:')
properties=source[start:source.index('    func scheduleComposerDraftSave()',start)]
methods='\n'.join(module.extract_swift_method(source,n) for n in ['scheduleComposerDraftSave','flushComposerDraft','restoreComposerDraftIfNeeded','stashComposerDraftForEdit','restoreStashedComposerDraft','withComposerSetAside'])
for n in ['takeComposerForTransfer','appendTransferredComposer','movePendingSendToNewChatDraft']:
 if 'func '+n+'(' in source: methods+='\n'+module.extract_swift_method(source,n)
life=(root/'src/ios/Agent/Chat/ChatLifecycleSupport.swift').read_text()
start=life.index('    struct PendingTransfer {')
transfer=life[start:life.index('\n    }',start)+6]
compact=(root/'src/ios/Agent/Chat/AIChatViewModel+Compaction.swift').read_text()
methods+='\n'+module.extract_swift_method(compact,'cancelCompactBeforeSend')+'\n'+module.extract_swift_method(compact,'compactAndSend')
models=(root/'src/ios/Agent/Chat/ChatModels.swift').read_text()
qstart=models.index('struct QueuedPrompt:')
queued=models[qstart:models.index('\n}',qstart)+2]
vm=(root/'src/ios/Agent/Chat/AIChatViewModel.swift').read_text()
start=vm.index('    var pendingTreasuryContext:')
context_property=vm[start:vm.index('    /// Caret position',start)]
extra=r'''
  let source=Harness();source.inputText="moved instruction";source.pendingTreasuryContext="<treasury_context>B</treasury_context>"
  let loading=InputAttachment(fileName:"loading",cacheURL:fixtureRoot,kind:.image,loadState:.loading)
  source.attachments=[loading]
  expect(source.takeComposerForTransfer()==nil && source.inputText=="moved instruction" && source.pendingTreasuryContext != nil,"failed/loading transfer consumed source")
  source.attachments=[]
  let moved=source.takeComposerForTransfer()!
  expect(source.inputText.isEmpty && source.pendingTreasuryContext==nil,"successful move left source context behind")
  let target=Harness();target.inputText="existing instruction";target.pendingTreasuryContext="<treasury_context>A</treasury_context>"
  target.appendTransferredComposer(moved)
  expect(target.inputText=="existing instruction\nmoved instruction","target text was replaced")
  expect(target.pendingTreasuryContext=="<treasury_context>A</treasury_context>\n<treasury_context>B</treasury_context>","target or incoming context was silently dropped")
  let combined=target.pendingTreasuryContext
  enum Stop:Error {case requested}
  do {try target.withComposerSetAside {
   expect(target.pendingTreasuryContext==nil,"headless/watch call inherited user's Treasury material")
   target.inputText="watch question";throw Stop.requested
  }} catch {}
  expect(target.pendingTreasuryContext==combined && target.inputText=="existing instruction\nmoved instruction","headless failure did not restore complete composer")
  target.stashComposerDraftForEdit();target.pendingTreasuryContext=nil;target.inputText="edit old turn";target.restoreStashedComposerDraft()
  expect(target.pendingTreasuryContext==combined,"cancelled message edit lost selected Treasury context")
''' if 'func takeComposerForTransfer(' in source else ''
swift=r'''
import Foundation
let fixtureRoot=URL(fileURLWithPath:CommandLine.arguments[1])
struct InputAttachment {
 enum Kind {case image,video,document};enum State {case ready,loading,failed}
 var id=UUID();let fileName:String;let cacheURL:URL;let kind:Kind;var loadState:State = .ready
}
struct PastedBlock {let id:UUID;let index:Int;let text:String;let preview:String;let charCount:Int}
''' + queued + r'''
final class ChatMessage {
 enum Role {case user,assistant,compactDivider,systemInfo}
 let id=UUID();let role:Role;var isQueued:Bool;var isCompactedHistory=false
 var queuedPromptId:UUID?;var inputAttachments:[InputAttachment]=[]
 init(role:Role,content:String,isQueued:Bool=false){self.role=role;self.isQueued=isQueued}
}
struct Signal {func send(){}}
struct Logger {func info(_ text:String){}}
let logger=Logger()
enum UIApplication {static let didEnterBackgroundNotification=Notification.Name("fixture.background")}
enum ViewModelCache {
''' + transfer+'\n}\n'+store+r'''
@MainActor final class Harness {
 var inputText="";var attachments:[InputAttachment]=[];var pastedBlocks:[PastedBlock]=[]
 var draftStashedForEdit:ComposerDraftSnapshot?;var composerDraftSaveTask:Task<Void,Never>?
 var composerDraftPersistenceEnabled=false;var composerDraftBackgroundObserver:NSObjectProtocol?
 var editingMessageIndex:Int?;let vmInstanceId="fixture";var composerDraftKey="new"
 var transientNotice:String?;var hasLoadingAttachments:Bool {attachments.contains{$0.loadState == .loading}}
 var pendingSendText:String?;var pendingSendRawText:String?;var pendingSendTreasuryContext:String?
 var pendingSendAttachments:[InputAttachment]=[];var pendingSendPastedBlocks:[PastedBlock]=[]
 var showCompactBeforeSendPrompt=false;var showContextExhaustedPrompt=false;var skipCompactCheck=false
 var promptQueue:[QueuedPrompt]=[];var messages:[ChatMessage]=[];let scrollToBottomSignal=Signal()
 var compactTask:Task<Void,Never>?;var compactAndSendRequestId:UUID?;var sentTreasuryContexts:[String?]=[]
 func compactBefore(_ id:UUID) async {}
 func schedulePostCompactDrain(){sentTreasuryContexts += promptQueue.map(\.treasuryContext);promptQueue=[]}
 func send(){sentTreasuryContexts.append(pendingTreasuryContext);pendingTreasuryContext=nil;inputText="";attachments=[]}
 func expandPastedBlocks(in text:String)->String {text}
 static func cleanupAttachmentFiles(_ items:[InputAttachment]){}
''' + context_property+properties+methods+r'''
}
func expect(_ c:Bool,_ m:String){if !c{print("FAIL: "+m);exit(1)}}
@main struct Runner {
 @MainActor static func main() async throws {
  let vm=Harness();vm.restoreComposerDraftIfNeeded()
  vm.inputText="use selected note";vm.pendingTreasuryContext="<treasury_context>selected note body</treasury_context>"
  vm.flushComposerDraft()
  let file=fixtureRoot.appendingPathComponent("ComposerDrafts/new.json")
  let json=try JSONSerialization.jsonObject(with:Data(contentsOf:file)) as! [String:Any]
  expect(json["treasuryContext"] as? String==vm.pendingTreasuryContext,"persisted draft omitted Treasury body")
  let reopened=Harness();reopened.restoreComposerDraftIfNeeded()
  expect(reopened.inputText==vm.inputText && reopened.pendingTreasuryContext==vm.pendingTreasuryContext,"relaunch restored instruction without Treasury body")
  let legacy=fixtureRoot.appendingPathComponent("ComposerDrafts/legacy.json")
  try Data(#"{"text":"old draft","attachments":[],"pasted":[]}"#.utf8).write(to:legacy)
  let old=Harness();old.composerDraftKey="legacy";old.restoreComposerDraftIfNeeded()
  expect(old.inputText=="old draft" && old.pendingTreasuryContext==nil,"legacy draft compatibility broken")
  let contextOnly=Harness();contextOnly.composerDraftKey="context-only";contextOnly.restoreComposerDraftIfNeeded()
  contextOnly.pendingTreasuryContext="<treasury_context>body only</treasury_context>";contextOnly.flushComposerDraft()
  expect(ComposerDraftStore.load(key:"context-only") != nil,"context-only draft was treated as empty")
''' + extra+r'''
  let parked=Harness();parked.inputText="new draft";parked.pendingTreasuryContext="new context"
  parked.pendingSendText="parked prompt";parked.pendingSendTreasuryContext="parked context"
  parked.cancelCompactBeforeSend()
  expect(parked.pendingTreasuryContext=="new context\nparked context" && parked.pendingSendTreasuryContext==nil,"compact cancel lost either context")
  let fallback=Harness();fallback.inputText="untouched draft";fallback.pendingTreasuryContext="untouched context"
  fallback.pendingSendText="send parked";fallback.pendingSendTreasuryContext="send context"
  fallback.compactAndSend()
  expect(fallback.sentTreasuryContexts==["send context"] && fallback.pendingTreasuryContext=="untouched context","compact direct-send mixed the borrowed draft")
  let compacted=Harness();compacted.messages=[ChatMessage(role:.user,content:"old"),ChatMessage(role:.assistant,content:"old")]
  compacted.pendingSendText="after compact";compacted.pendingSendTreasuryContext="compact context"
  compacted.compactAndSend();await compacted.compactTask?.value
  expect(compacted.sentTreasuryContexts==["compact context"] && compacted.pendingSendTreasuryContext==nil,"post-compact queue lost or retained context")
  ComposerDraftStore.save(.init(text:"earlier draft",attachments:[],pastedBlocks:[],treasuryContext:"earlier context"),key:ComposerDraftStore.newChatKey)
  let overflow=Harness();overflow.pendingSendText="move parked";overflow.pendingSendTreasuryContext="overflow context"
  overflow.movePendingSendToNewChatDraft()
  expect(ComposerDraftStore.load(key:ComposerDraftStore.newChatKey)?.treasuryContext=="earlier context\noverflow context" && overflow.pendingSendTreasuryContext==nil,"new-chat overflow dropped context")
  print("PASS actual Treasury composer: persisted roundtrip, legacy decode, context-only, loading-transfer rejection, source clear, target merge, headless failure/edit restoration")
 }
}
'''
with tempfile.TemporaryDirectory(prefix='leo-treasury-composer-') as folder:
 code=Path(folder)/'Smoke.swift';code.write_text(swift);binary=Path(folder)/'smoke';data=Path(folder)/'data';data.mkdir()
 subprocess.run(['swiftc','-parse-as-library',str(code),'-o',str(binary)],check=True)
 subprocess.run([str(binary),str(data)],check=True)
