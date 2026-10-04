#!/usr/bin/env python3
"""Run actual Home send routing with group-free and unavailable-choice fixtures."""
from pathlib import Path
import importlib.util
import subprocess
import tempfile
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('audit_generator',root/'scripts/native-model-audit/generate.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
source=(root/'src/ios/Views/ContentView.swift').read_text()
method=module.extract_swift_method(source,'runHomePrompt').replace('private func','func')
swift=r'''
import Foundation
struct HomeDraft { var text="ordinary question"; var trimmed:String {text.trimmingCharacters(in:.whitespacesAndNewlines)} }
enum Target { case iphone; case mac(hostId:String,cliKey:String,cliName:String) }
struct ProviderStore { var modelGroups:[String]=[]; var instances=["fixture-provider"] }
enum ActionRouter {
 enum Route {case native,clarify,agent}
 struct Decision {var path:Route = .agent;func spoken()->String {"fixture"}}
 static func decide(text:String,imageCount:Int)->Decision {Decision()}
}
struct NativeResult {enum Outcome{case waitingForUser};let text:String;let outcome:Outcome}
struct Host{let id:String}
struct GatewayStore {let activeHosts:[Host]=[];func client(for host:Host)->String? {nil}}
enum LeoHaptics {enum Weight{case medium};enum Outcome{case error};static func impact(_ w:Weight){};static func notification(_ o:Outcome){}}
enum ChatLaunchAction {case sendPrompt(String)}
final class Harness {
 var homeDraft=HomeDraft();var homeExecutionTarget=Target.iphone;var providerStore=ProviderStore()
 var homeRoutingError:String?;var homeNativeResult:NativeResult?;var gatewayStore=GatewayStore()
 var showAddProvider=false;var showSelectModels=false;var launches=0
 var homeModelChoice:String?="vision";var availableChoices:Set<String>=["vision"]
 var homeHasAvailableModel:Bool {!availableChoices.isEmpty}
 var canRunHomePrompt:Bool {!homeDraft.trimmed.isEmpty}
 func homeChoiceIsAvailable(_ choice:String)->Bool {availableChoices.contains(choice)}
 func runHomeNative(_ decision:ActionRouter.Decision,clearingPrompt:String){}
 func startHomeChatAction(_ action:ChatLaunchAction){launches+=1}
 func openMacChat(_ host:Host,_ key:String,_ name:String,prompt:String){}
''' + method + r'''
}
func expect(_ c:Bool,_ m:String){if !c{print("FAIL: "+m);exit(1)}}
let direct=Harness();direct.runHomePrompt()
expect(direct.launches==1 && !direct.showSelectModels,"valid direct Home choice was blocked solely because groups are empty")
let empty=Harness();empty.providerStore.modelGroups=["empty"];empty.homeModelChoice="group:empty";empty.runHomePrompt()
expect(empty.launches==0 && empty.homeDraft.text=="ordinary question" && empty.homeRoutingError != nil,"unavailable explicit Home group dispatched or lost prompt")
let noModels=Harness();noModels.homeModelChoice=nil;noModels.availableChoices=[];noModels.runHomePrompt()
expect(noModels.launches==0 && noModels.showSelectModels && !noModels.homeDraft.text.isEmpty,"missing models did not preserve draft and offer management")
print("PASS production Home routing: no groups, invalid explicit choice, unavailable catalog")
'''
with tempfile.TemporaryDirectory(prefix='leo-home-prompt-') as folder:
 code=Path(folder)/'main.swift';code.write_text(swift);binary=Path(folder)/'smoke'
 subprocess.run(['swiftc',str(code),'-o',str(binary)],check=True)
 subprocess.run([str(binary)],check=True)
