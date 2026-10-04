#!/usr/bin/env python3
"""Exercise actual Watch lifecycle callbacks and Remote Host probe updates.
Synthetic WC/TCP adapters; no paired devices, network, settings or credentials.
"""
from pathlib import Path
import importlib.util,subprocess,tempfile
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('audit_generator',root/'scripts/native-model-audit/generate.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
watch=(root/'src/ios/Shared/WatchBridge.swift').read_text()
start=watch.index('    var watchUnreachableReason: String? {')
reason=watch[start:watch.index('    /// [T-watch-standalone]',start)].replace('#if os(iOS)','').replace('#endif','')
start=watch.index('extension WatchBridge: WCSessionDelegate {')
callbacks=watch[start:watch.index('    /// [T-watch-native-voice]',start)]+'}\n'
callbacks=callbacks.replace('#if os(iOS)','').replace('#endif','')
refresh=module.extract_swift_method(watch,'refreshWatchState') if 'func refreshWatchState()' in watch else ''
publisher='@Published private(set) var connectionRevision: UInt = 0' if 'var connectionRevision: UInt = 0' in watch else ''
remote=(root/'src/ios/Views/Settings/RemoteHostSettingsView.swift').read_text()
if 'func refreshReachability(' in remote:
 probe=module.extract_swift_method(remote,'refreshReachability').replace('private func','func')
else:
 start=remote.index('        .task {')
 body=remote[start+len('        .task {'):remote.index('\n        .sheet(',start)]
 probe='func refreshReachability() async {'+body
swift=r'''
import Foundation
import Combine
protocol WCSessionDelegate {}
enum WCSessionActivationState:Int {case notActivated,activated}
final class WCSession {static let `default`=WCSession();var activationState=WCSessionActivationState.notActivated;var isPaired=false;var isWatchAppInstalled=false;var isReachable=false;func activate(){}}
struct Logger {func error(_ text:String){};func info(_ text:String){}}
let logger=Logger()
@MainActor final class WatchBridge:NSObject,ObservableObject {
 static let shared=WatchBridge()
 var session:WCSession?=WCSession.default
 func resetDedupe(){};func syncStandaloneConfigIfNeeded(force:Bool=false){};func pushStatus(){}
''' + publisher+'\n'+refresh+'\n'+reason+'\n}\n'+callbacks+r'''
struct RemoteHost:Equatable {let id:String;let host:String}
@MainActor final class Store {var hosts:[RemoteHost]=[]}
enum RemoteSSHExecutor {
 static func probe(host:RemoteHost) async ->Bool {
  // An old TCP callback can still complete after cancellation.
  await withCheckedContinuation { continuation in
   DispatchQueue.global().asyncAfter(deadline:.now()+(host.host=="old" ? 0.10 : 0.01)) {continuation.resume(returning:host.host=="old")}
  }
 }
}
@MainActor final class RemoteHarness {
 let store=Store();var reachability:[String:Bool]=[:]
''' + probe+r'''
}
func expect(_ c:Bool,_ m:String){if !c{print("FAIL: "+m);exit(1)}}
@main struct Runner {
 @MainActor static func main() async throws {
  let bridge=WatchBridge.shared;var events=0
  let subscription=bridge.objectWillChange.sink {events+=1}
  let session=WCSession.default
  expect(bridge.watchUnreachableReason != nil,"unactivated watch offered sync")
  session.activationState = .activated;session.isPaired=true;session.isWatchAppInstalled=true
  bridge.session(session,activationDidCompleteWith:.activated,error:nil)
  try await Task.sleep(nanoseconds:20_000_000)
  expect(events>0,"Watch activation did not publish a settings refresh")
  expect(bridge.watchUnreachableReason==nil,"offline watch incorrectly prevented queued sync")
  let before=events;session.isWatchAppInstalled=false
''' + ('  bridge.sessionWatchStateDidChange(session)\n' if 'sessionWatchStateDidChange' in callbacks else '') + r'''
  try await Task.sleep(nanoseconds:20_000_000)
  expect(events>before && bridge.watchUnreachableReason != nil,"watch installation change left settings stale")
  let failedBefore=events
  bridge.session(session,activationDidCompleteWith:.notActivated,error:CocoaError(.fileReadUnknown))
  try await Task.sleep(nanoseconds:20_000_000)
  expect(events>failedBefore,"failed activation did not refresh status")
  _ = subscription
  let remote=RemoteHarness();remote.store.hosts=[.init(id:"A",host:"old")]
  let old=Task {@MainActor in await remote.refreshReachability()}
  try await Task.sleep(nanoseconds:5_000_000)
  remote.store.hosts=[.init(id:"A",host:"new")];old.cancel()
  await remote.refreshReachability();await old.value
  expect(remote.reachability["A"]==false,"old probe overwrote edited endpoint status")
  let neverStarted=Task {@MainActor in await remote.refreshReachability()}
  neverStarted.cancel();await neverStarted.value
  expect(remote.reachability["A"]==false,"cancelled-before-start task cleared current status")
  remote.store.hosts=[];await remote.refreshReachability()
  expect(remote.reachability.isEmpty,"deleted host retained stale probe state")
  print("PASS actual Watch callbacks and host refresh: activation/install/failure, offline queue eligibility, edited/deleted host, stale callback")
 }
}
'''
with tempfile.TemporaryDirectory(prefix='leo-settings-status-') as folder:
 code=Path(folder)/'Smoke.swift';code.write_text(swift);binary=Path(folder)/'smoke'
 subprocess.run(['swiftc','-parse-as-library',str(code),'-o',str(binary)],check=True)
 subprocess.run([str(binary)],check=True)
