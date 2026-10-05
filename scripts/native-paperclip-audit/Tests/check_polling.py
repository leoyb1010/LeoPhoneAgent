#!/usr/bin/env python3
"""Host Swift regression of the actual view polling expressions; not a SwiftUI/device test.

新语义：只读轮询只在写请求进行中暂停；输入框聚焦、面板/弹窗打开都不再暂停。
"""
from pathlib import Path
import re
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
views = root / 'src/ios/Views/Paperclip'
workspace = (views / 'PaperclipWorkspaceView.swift').read_text()
detail = (views / 'PaperclipIssueDetailView.swift').read_text()
list_match = re.search(r'PaperclipPollingPolicy\.canRefresh\(active: true, mutating: (\w+)\)', workspace)
detail_match = re.search(r'PaperclipPollingPolicy\.canRefresh\(active: visible, mutating: (model\.busy)\)', detail)
assert list_match and detail_match, 'Production polling wiring changed: update this regression extractor.'
assert list_match.group(1) == 'creating', 'List polling must pause only while a create request is in flight.'
for banned in ['replyFocused', 'statusSheetOpen', '!details', '!composing', '!searching']:
    assert banned not in detail.split('func pollLoop', 1)[1].split('// MARK: 线程', 1)[0], banned
source = '''import Foundation
struct PollingViewState {
 var visible=true, focused=true, sheetOpen=true, creating=false
 var model=(busy: false, ())
 var listRefresh:Bool { PaperclipPollingPolicy.canRefresh(active: true, mutating: creating) }
 var detailRefresh:Bool { PaperclipPollingPolicy.canRefresh(active: visible, mutating: model.busy) }
}
var failures=0
func check(_ passed:Bool,_ label:String) { if !passed { print("FAIL: " + label); failures+=1 } }
var state=PollingViewState()
check(state.listRefresh && state.detailRefresh, "focus and open panels must not pause reads")
state.creating=true; state.model.busy=true
check(!state.listRefresh && !state.detailRefresh, "write requests pause reads")
state.creating=false; state.model.busy=false; state.visible=false
check(!state.detailRefresh, "hidden detail pauses reads")
print("polling expression regression failures=\\(failures)")
exit(failures==0 ? 0:1)
'''
with tempfile.TemporaryDirectory(prefix='paperclip-polling-') as tmp:
    main = Path(tmp) / 'main.swift'
    main.write_text(source)
    binary = Path(tmp) / 'polling'
    subprocess.run(['swiftc', str(root / 'src/ios/Agent/Paperclip/PaperclipContract.swift'), str(root / 'src/ios/Agent/Paperclip/PaperclipDraft.swift'), str(main), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
