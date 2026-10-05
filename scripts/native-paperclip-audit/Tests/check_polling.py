#!/usr/bin/env python3
"""Host Swift regression of the actual view polling expressions; not a SwiftUI/device test."""
from pathlib import Path
import re
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
views = root / 'src/ios/Views/Paperclip'
workspace = (views / 'PaperclipWorkspaceView.swift').read_text()
detail = (views / 'PaperclipIssueDetailView.swift').read_text()
composer_match = re.search(r'private func updateComposing\(\) \{\s*(?://[^\n]*\n\s*)?composing = (.*?)\n    \}', workspace, re.S)
detail_match = re.search(r'if (PaperclipPollingPolicy.canRefresh\(active: visible.*?) \{\s*await model.refresh\(\)', detail, re.S)
assert composer_match and detail_match, 'Production polling wiring changed: update this regression extractor.'
source = '''import Foundation
struct PollingViewState {
 var focused=false, showDetails=false, showReceipt=false, busy=false
 var visible=true, editingReply=false, editingDecision=false, discardReply=false, details=false, acknowledgeStatus=false
 var statusDecision:Int?=nil, pendingDecision:Int?=nil
 var decisionNote="保留的审批说明", expandedApprovalIDs:Set<String>=["approval"]
 var draft=PaperclipDraft()
 var composing:Bool { COMPOSER }
 var detailRefresh:Bool { DETAIL }
}
var failures=0
func check(_ passed:Bool,_ label:String) {
 if !passed { print("FAIL: " + label); failures+=1 }
}
var state=PollingViewState()
let encoder=JSONEncoder();encoder.outputFormatting = .sortedKeys
state.draft.title="保留任务标题";state.draft.body="保留回复正文"
for submitted in [false,true] {
 state.draft.submitted=submitted
 let original=try encoder.encode(state.draft)
 check(!state.composing,"blurred saved/unknown draft must permit workspace reads")
 check(state.detailRefresh,"blurred reply/closed approval must permit detail reads")
 check(try encoder.encode(state.draft)==original,"read polling must preserve receipt and text")
}
state.focused=true;state.editingReply=true
check(state.composing && !state.detailRefresh,"focused editors pause reads")
state.focused=false;state.editingReply=false
state.showReceipt=true;state.acknowledgeStatus=true
check(state.composing && !state.detailRefresh,"receipt confirmation pauses reads")
state.showReceipt=false;state.acknowledgeStatus=false
state.showDetails=true;state.details=true
check(state.composing && !state.detailRefresh,"visible information sheets pause reads")
state.showDetails=false;state.details=false
state.busy=true;state.visible=false
check(state.composing && !state.detailRefresh,"mutation and hidden detail pause reads")
state.busy=false;state.visible=true;state.pendingDecision=1
check(!state.detailRefresh,"pending approval confirmation pauses reads")
state.pendingDecision=nil;state.statusDecision=1
check(!state.detailRefresh,"status confirmation pauses reads")
state.statusDecision=nil;state.discardReply=true
check(!state.detailRefresh,"draft discard confirmation pauses reads")
print("polling expression regression failures=\\(failures)")
exit(failures==0 ? 0:1)
'''.replace('COMPOSER', composer_match.group(1)).replace('DETAIL', detail_match.group(1))
with tempfile.TemporaryDirectory(prefix='paperclip-polling-') as tmp:
    main = Path(tmp) / 'main.swift'
    main.write_text(source)
    binary = Path(tmp) / 'polling'
    subprocess.run(['swiftc', str(root / 'src/ios/Agent/Paperclip/PaperclipContract.swift'), str(root / 'src/ios/Agent/Paperclip/PaperclipDraft.swift'), str(main), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
