#!/usr/bin/env python3
"""Run the actual automation dispatch method with failed/missing/successful runners.
No real automation, system notification, location or model request is triggered.
"""
from pathlib import Path
import importlib.util,subprocess,tempfile
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('audit_generator',root/'scripts/native-model-audit/generate.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
source=(root/'src/ios/Agent/Intents/AutomationEngine.swift').read_text()
rule=source[source.index('struct AutomationRule:'):source.index('@MainActor\nfinal class AutomationStore')]
method=module.extract_swift_method(source,'fire').replace('private func','func')
swift='import Foundation\n'+rule+r'''
struct Logger {func info(_ text:String){}}
let logger=Logger()
@MainActor final class AutomationStore {
 static let shared=AutomationStore();var rules:[AutomationRule]=[];var attempts=0
 func markFired(id:String){attempts+=1;if let i=rules.firstIndex(where:{$0.id==id}){rules[i].lastFiredAt=Date()}}
}
@MainActor final class BackgroundKeepAliveManager {
 static let shared=BackgroundKeepAliveManager();func armEagerlyForShortcut(sessionId:String,caller:String)->Bool {true}
}
@MainActor enum QuickTaskWidgetRunner {
 static var outcomes:[String:Bool]=[:];static var calls:[String]=[]
 static func run(taskId:String) async ->Bool {calls.append(taskId);return outcomes[taskId] ?? false}
}
@MainActor enum ScheduledTaskRunner {
 struct Notice {let title:String;let body:String}
 static var notices:[Notice]=[]
 static func notify(title:String,body:String,sessionId:String?,gated:Bool){notices.append(.init(title:title,body:body))}
}
@MainActor enum WatchAskRunner {static var prompts:[String]=[];static func run(requestId:String,prompt:String,sessionId:String?) async {prompts.append(prompt)}}
@MainActor final class Harness {
''' + method+r'''
}
func expect(_ c:Bool,_ m:String){if !c{print("FAIL: "+m);exit(1)}}
@main struct Runner {
 @MainActor static func main() async {
  let engine=Harness();let store=AutomationStore.shared
  var missing=AutomationRule(name:"Missing template",trigger:.nightCharging);missing.quickTaskId="deleted"
  store.rules=[missing]
  await engine.fire(missing,context:nil)
  expect(ScheduledTaskRunner.notices.last?.title=="Automation failed to start","missing quick task was announced as started")
  expect(store.rules.count==1 && store.rules[0].isEnabled && !store.rules[0].canFire(now:Date()),"failed attempt deleted rule or lost cooldown")
  var failure=AutomationRule(name:"Provider rejected",trigger:.beforeEvent(minutes:15));failure.quickTaskId="fails"
  store.rules.append(failure);QuickTaskWidgetRunner.outcomes["fails"]=false
  await engine.fire(failure,context:nil)
  expect(ScheduledTaskRunner.notices.last?.title=="Automation failed to start","runner failure was announced as started")
  var success=AutomationRule(name:"Accepted",trigger:.nightCharging);success.quickTaskId="works"
  store.rules.append(success);QuickTaskWidgetRunner.outcomes["works"]=true
  await engine.fire(success,context:nil)
  expect(ScheduledTaskRunner.notices.last?.title=="Automation started","accepted run lost started notification")
  expect(store.attempts==3 && QuickTaskWidgetRunner.calls==["deleted","fails","works"],"dispatch duplicated or failed attempts skipped throttle")
  var custom=AutomationRule(name:"Custom",trigger:.nightCharging);custom.prompt="do task"
  await engine.fire(custom,context:"calendar context")
  expect(WatchAskRunner.prompts==["calendar context\n\ndo task"],"custom action context was changed")
  print("PASS actual automation dispatch: missing/failed/accepted quick task, preserved rule and cooldown, unchanged custom prompt")
 }
}
'''
with tempfile.TemporaryDirectory(prefix='leo-automation-start-') as folder:
 code=Path(folder)/'Smoke.swift';code.write_text(swift);binary=Path(folder)/'smoke'
 subprocess.run(['swiftc','-parse-as-library',str(code),'-o',str(binary)],check=True)
 subprocess.run([str(binary)],check=True)
