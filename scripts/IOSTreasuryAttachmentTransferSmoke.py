#!/usr/bin/env python3
"""Execute actual Treasury send-to-agent code with real temporary file failures.
No app group, network, simulator or existing collection data is used.
"""
from pathlib import Path
import importlib.util, subprocess, tempfile
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('audit_generator',root/'scripts/native-model-audit/generate.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
source=(root/'src/ios/Views/CollectionsView.swift').read_text()
source=source[source.index('    private func sendToAgent(_ selectedItems:'):]
method=module.extract_swift_method(source,'sendToAgent').replace('private func','func')
helper=module.extract_swift_method(source,'stageAgentAttachments') if 'func stageAgentAttachments' in source else ''
swift=r'''
import Foundation
struct CollectedItem {enum Kind{case file,text};let id:String;let kind:Kind;let value:String;var title:String?{value}}
struct PendingShare {struct Item {enum Kind{case attachment};let kind:Kind;let value:String};let items:[Item];let timestamp:Date;let instruction:String;let treasuryContext:String}
enum CollectionStore {static var directory:URL!;static func fileURL(named name:String)->URL? {directory.appendingPathComponent(name)}}
enum SharedContainerStore {static var directory:URL!;static func sharedFileURL(named name:String)->URL? {directory.appendingPathComponent(name)}}
enum TreasuryContextBuilder {static func build(items:[CollectedItem]) async ->String {"untrusted fixture"}}
@MainActor final class ShareCoordinator {static let shared=ShareCoordinator();var shares:[PendingShare]=[];func storeBuffer(_ share:PendingShare){shares.append(share)}}
extension Notification.Name {static let newChatRequested=Notification.Name("test.newChat")}
@MainActor final class Harness {
 enum Mode{case active,inactive}
 struct FailedAgentShare {let items:[CollectedItem];let prompt:String?;let message:String}
 var selection:Set<String>=["first","second"];var editMode=Mode.active
 var isSendingToAgent=false;var failedAgentShare:FailedAgentShare?;var dismissals=0
 func dismiss(){dismissals+=1}
 func flash(_ message:String,autoHide:Bool=true,isError:Bool=false){}
''' + method+'\n'+helper+r'''
}
func expect(_ c:Bool,_ m:String){if !c{print("FAIL: "+m);exit(1)}}
@main struct Runner {
 @MainActor static func settle() async throws {for _ in 0..<20 {try await Task.sleep(nanoseconds:5_000_000)}}
 @MainActor static func main() async throws {
  let fm=FileManager.default;let root=fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  defer{try?fm.removeItem(at:root)}
  let originals=root.appendingPathComponent("originals");let shared=root.appendingPathComponent("shared")
  try fm.createDirectory(at:originals,withIntermediateDirectories:true)
  CollectionStore.directory=originals;SharedContainerStore.directory=shared
  let source=originals.appendingPathComponent("doc.txt");try Data("original bytes".utf8).write(to:source)
  try Data("blocked staging directory".utf8).write(to:shared)
  let items=[CollectedItem(id:"first",kind:.file,value:"doc.txt")]
  let harness=Harness();harness.sendToAgent(items,prompt:"summarize");try await settle()
  expect(ShareCoordinator.shared.shares.isEmpty && harness.dismissals==0,"failed attachment copy published share or navigated away")
  expect(harness.failedAgentShare != nil && harness.selection.contains("first"),"failure not visible or selection was cleared")
  expect(try String(contentsOf:source,encoding:.utf8)=="original bytes","failure damaged original attachment")
  try fm.removeItem(at:shared);try fm.createDirectory(at:shared,withIntermediateDirectories:true)
  let existing=shared.appendingPathComponent("doc.txt");try Data("older pending transfer".utf8).write(to:existing)
  harness.sendToAgent(items,prompt:"summarize");try await settle()
  expect(ShareCoordinator.shared.shares.count==1 && harness.dismissals==1,"retry did not deliver exactly once")
  let staged=ShareCoordinator.shared.shares[0].items[0].value
  expect(try String(contentsOf:shared.appendingPathComponent(staged),encoding:.utf8)=="original bytes","published attachment bytes missing")
  expect(try String(contentsOf:existing,encoding:.utf8)=="older pending transfer","retry overwrote another pending share")
  let before=Set(try fm.contentsOfDirectory(atPath:shared.path));ShareCoordinator.shared.shares=[]
  let batch=Harness();batch.sendToAgent(items+[CollectedItem(id:"second",kind:.file,value:"missing.txt")],prompt:nil);try await settle()
  expect(ShareCoordinator.shared.shares.isEmpty && batch.dismissals==0,"partial batch was misreported as fully attached")
  expect(Set(try fm.contentsOfDirectory(atPath:shared.path))==before,"failed batch leaked partial staging files")
  print("PASS production Treasury transfer: copy failure, retry, original/pending preservation, missing batch rollback")
 }
}
'''
with tempfile.TemporaryDirectory(prefix='leo-treasury-transfer-') as folder:
 code=Path(folder)/'Smoke.swift';code.write_text(swift);binary=Path(folder)/'smoke'
 subprocess.run(['swiftc','-parse-as-library',str(code),'-o',str(binary)],check=True)
 subprocess.run([str(binary)],check=True)
