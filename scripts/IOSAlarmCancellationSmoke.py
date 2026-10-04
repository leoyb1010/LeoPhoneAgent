#!/usr/bin/env python3
"""Run actual alarm-list mutation methods with deferred success/failure callbacks.
The AlarmKit bridge is an in-memory adapter; no system alarms are accessed.
"""
from pathlib import Path
import subprocess,tempfile
root=Path(__file__).resolve().parents[1]
source=(root/'src/ios/Views/Alarms/AlarmListView.swift').read_text()
start=source.index('class AlarmListViewModel:')
source=source[start:source.index('    /// Group alarms by week',start)]+'}\n'
swift=r'''
import Foundation
import Combine
struct AlarmItem {let id:String;init(_ id:String){self.id=id};init(dict:[String:Any]){id=dict["id"] as! String}}
enum AlarmOffloadBridge {
 static var pending:[String:(Bool,Error?)->Void]=[:];static var calls:[String:Int]=[:]
 static func listAlarms(_ completion:(Any?,Error?)->Void){completion([],nil)}
 static func cancelAlarm(withId id:String,completion:@escaping(Bool,Error?)->Void){calls[id,default:0]+=1;pending[id]=completion}
 static func finish(_ id:String,_ success:Bool){pending.removeValue(forKey:id)?(success,success ? nil : CocoaError(.fileWriteNoPermission))}
}
''' + source+r'''
func expect(_ c:Bool,_ m:String){if !c{print("FAIL: "+m);exit(1)}}
@main struct Runner {
 @MainActor static func settle() async {try?await Task.sleep(nanoseconds:15_000_000)}
 @MainActor static func main() async {
  let vm=AlarmListViewModel();vm.alarms=[AlarmItem("one"),AlarmItem("two")]
  vm.delete(id:"one")
  expect(vm.alarms.map(\.id)==["one","two"],"alarm disappeared before cancellation was confirmed")
  vm.delete(id:"one")
  expect(AlarmOffloadBridge.calls["one"]==1,"repeated delete dispatched duplicate system cancellation")
  AlarmOffloadBridge.finish("one",false);await settle()
  expect(vm.alarms.map(\.id)==["one","two"] && vm.error != nil,"failed cancellation hid a still-scheduled alarm")
  vm.delete(id:"one");AlarmOffloadBridge.finish("one",true);await settle()
  expect(vm.alarms.map(\.id)==["two"],"successful retry did not remove the alarm")
  vm.alarms=[AlarmItem("three"),AlarmItem("four")];vm.clearAll()
  expect(vm.alarms.count==2,"clear-all removed pending alarms before confirmation")
  AlarmOffloadBridge.finish("three",true);AlarmOffloadBridge.finish("four",false);await settle()
  expect(vm.alarms.map(\.id)==["four"] && vm.error != nil,"partial clear-all did not retain/report failure")
  vm.clearAll();AlarmOffloadBridge.finish("four",true);await settle()
  expect(vm.alarms.isEmpty,"remaining failed alarm could not be retried")
  print("PASS actual alarm cancellation: pending rows, duplicate admission, failure retention, retry, partial clear-all")
 }
}
'''
with tempfile.TemporaryDirectory(prefix='leo-alarm-cancel-') as folder:
 code=Path(folder)/'Smoke.swift';code.write_text(swift);binary=Path(folder)/'smoke'
 subprocess.run(['swiftc','-parse-as-library',str(code),'-o',str(binary)],check=True)
 subprocess.run([str(binary)],check=True)
