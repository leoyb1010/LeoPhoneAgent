#!/usr/bin/env python3
"""Exercise actual VM session creation with delayed database adapters.
Models/skills/MCP callers keep their own follow-up actions; no user DB or network.
"""
from pathlib import Path
import importlib.util,subprocess,tempfile
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('audit_generator',root/'scripts/native-model-audit/generate.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
source=(root/'src/ios/Agent/Chat/AIChatViewModel+Persistence.swift').read_text()
methods=module.extract_swift_method(source,'ensureSession')+'\n'+module.extract_swift_method(source,'ensureSessionReturningId')
if 'func createDraftSession(' in source: methods+='\n'+module.extract_swift_method(source,'createDraftSession')
vm=(root/'src/ios/Agent/Chat/AIChatViewModel.swift').read_text()
field='var sessionCreationTask: Task<String, Never>?' if 'var sessionCreationTask: Task<String, Never>?' in vm else ''
swift=r'''
import Foundation
struct Model {let id:String}
struct Session {let id:String}
struct AppLogger {init(category:String){};func info(_ text:String){}}
let logger=AppLogger(category:"fixture")
actor ChatStore {
 static let shared=ChatStore();var creations=0;var models:[String]=[];var memory:[String:Bool]=[:]
 func createSession(modelId:String,source:String?) async ->Session {
  creations+=1;let id="session-\(creations)";models.append(modelId)
  try? await Task.sleep(nanoseconds:30_000_000)
  return Session(id:id)
 }
 func setMemoryEnabled(sessionId:String,enabled:Bool){memory[sessionId]=enabled}
 func getMemoryEnabled(sessionId:String) async ->Bool {
  try? await Task.sleep(nanoseconds:50_000_000)
  return memory[sessionId] ?? true
 }
}
enum SessionWorkspaceBind {static func setMount(_ mount:UUID,for sid:String){}}
@MainActor final class SessionActivityTracker {
 static let shared=SessionActivityTracker()
 func setDraftAlias(draft:String,real:String){};func setActive(_ sid:String,source:String){};func setInactive(_ sid:String,source:String){}
}
@MainActor final class ViewModelCache {
 static let shared=ViewModelCache();var cached=0
 func cacheDraft(_ vm:Harness,sessionId:String){cached+=1}
}
extension Notification.Name {static let sessionDidCreate=Notification.Name("fixture.created")}
@MainActor final class Harness {
 static var activeSessionId:String?
 var sessionId:String?;let vmInstanceId="fixture";var draftId:String?="draft";var sessionSource:String?="app"
 var pendingWorkspaceMountId:UUID?=UUID();var draftMemoryEnabledOverride:Bool?=false
 var memoryEnabled=true;var isProcessing=true;var selectedModel=Model(id:"placeholder")
 var bindingReady=false;var bindingCalls=0;var mounts=0;var thinkingFlushes=0
 var followups:[String:String]=[:]
 func syncSelectedModelFromBinding(){selectedModel=Model(id:"chosen-vision")}
 func flushPendingThinkingLevel()->Bool {thinkingFlushes+=1;return true}
 func mountMinis(for sid:String){mounts+=1}
 func createInitialBinding(for sid:String,preserveThinkingLevel:Bool) async {
  try?await Task.sleep(nanoseconds:20_000_000)
  bindingCalls+=1;bindingReady=preserveThinkingLevel
 }
''' + field+'\n'+methods+r'''
}
func expect(_ c:Bool,_ m:String){if !c{print("FAIL: "+m);exit(1)}}
@main struct Runner {
 @MainActor static func main() async {
  let vm=Harness()
  let callers=["model","skill","mcp"].map {action in Task {@MainActor in
   let sid=await vm.ensureSessionReturningId()
   expect(vm.bindingReady,"caller resumed before initial model binding was ready")
   vm.followups[action]=sid;return sid
  }}
  // Join after sessionId is assigned but while memory/binding initialization awaits.
  while vm.sessionId==nil {await Task.yield()}
  let underway=await ChatStore.shared.creations
  expect(underway==1,"concurrent model/skill/MCP ensure started \(underway) database creates")
  let late=Task {@MainActor in
   await vm.ensureSession()
   expect(vm.bindingReady,"ensureSession skipped the in-flight initialization")
  }
  let cancelled=Task {@MainActor in
   let sid=await vm.ensureSessionReturningId();return sid
  }
  cancelled.cancel()
  var ids:[String]=[]
  for task in callers {ids.append(await task.value)}
  await late.value
  ids.append(await cancelled.value)
  let count=await ChatStore.shared.creations
  expect(count==1 && Set(ids).count==1,"concurrent callers created different sessions")
  expect(vm.followups.count==3 && Set(vm.followups.values).count==1,"model/skill/MCP follow-ups were lost or split")
  expect(vm.bindingCalls==1 && vm.mounts==1 && vm.thinkingFlushes==1 && ViewModelCache.shared.cached==1,"initialization ran more than once")
  expect(!vm.memoryEnabled && vm.pendingWorkspaceMountId==nil,"draft memory/workspace preference lost")
  let selected=await ChatStore.shared.models
  expect(selected==["chosen-vision"],"selected draft model was not used")
  let existing=await vm.ensureSessionReturningId()
  let after=await ChatStore.shared.creations
  expect(existing==ids[0] && after==1,"existing session was recreated")
  print("PASS actual session creation: concurrent model/skill/MCP, late waiter, cancelled waiter, one initialization, model/memory/workspace preservation")
 }
}
'''
with tempfile.TemporaryDirectory(prefix='leo-session-creation-') as folder:
 code=Path(folder)/'Smoke.swift';code.write_text(swift);binary=Path(folder)/'smoke'
 subprocess.run(['swiftc','-parse-as-library',str(code),'-o',str(binary)],check=True)
 subprocess.run([str(binary)],check=True)
