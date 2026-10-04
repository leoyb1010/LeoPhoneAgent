#!/usr/bin/env python3
"""Exercise the real Home draft store against a temporary directory, never user drafts."""
from pathlib import Path
import subprocess
import tempfile
root=Path(__file__).resolve().parents[1]
source=(root/'src/ios/Views/Home/HomeComposer.swift').read_text()
source=source[source.index('@MainActor\nfinal class HomeDraft'):source.index('/// 首页搜索框:')]
swift='import Foundation\nimport Combine\n'+source+r'''
func expect(_ c:Bool,_ m:String){if !c{print("FAIL: "+m);exit(1)}}
@main struct Runner {
 @MainActor static func main() async throws {
  let directory=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
  defer {try? FileManager.default.removeItem(at:directory)}
  let url=directory.appendingPathComponent("HomeComposerDraft.json")
  let chat=directory.appendingPathComponent("__new_chat__.json")
  try Data("unrelated chat draft".utf8).write(to:chat)
  let first=HomeDraft();_ = first.enablePersistence(at:url)
  first.text="unfinished 中文 task\nsecond line";first.updateModelChoice("provider/vision")
  first.flushPersistence()
  let second=HomeDraft();let restored=second.enablePersistence(at:url)
  expect(second.text==first.text && restored=="provider/vision","Home text and choice did not survive reconstruction")
  let untouched=try String(contentsOf:chat, encoding:.utf8)
  expect(untouched=="unrelated chat draft","Home draft overwrote in-chat draft")
  first.text="debounced edit";first.text="latest debounced edit"
  try await Task.sleep(nanoseconds: 500_000_000)
  let debounced=HomeDraft();_ = debounced.enablePersistence(at:url)
  expect(debounced.text=="latest debounced edit","typing debounce did not persist the latest draft")
  second.flushPersistence()
  let idle=HomeDraft();_ = idle.enablePersistence(at:url)
  expect(idle.text=="latest debounced edit","untouched Home instance overwrote newer draft")
  second.text="last keystrokes";second.flushPersistence()
  let immediate=HomeDraft();_ = immediate.enablePersistence(at:url)
  expect(immediate.text=="last keystrokes","background flush lost debounced text")
  immediate.text="";immediate.updateModelChoice(nil);immediate.flushPersistence()
  let sent=HomeDraft();let sentChoice=sent.enablePersistence(at:url)
  expect(sent.text.isEmpty && sentChoice==nil,"consumed Home draft resurrected")
  expect(!FileManager.default.fileExists(atPath:url.path),"cleared Home draft was not removed")
  let search=HomeDraft();search.text="private search query";search.flushPersistence()
  expect(!FileManager.default.fileExists(atPath:url.path),"search draft was accidentally persisted as Home input")
  print("PASS production Home draft: relaunch, model choice, final-keystroke flush, consumed reset, separate search/chat state")
 }
}
'''
with tempfile.TemporaryDirectory(prefix='leo-home-draft-') as folder:
 code=Path(folder)/'Smoke.swift';code.write_text(swift);binary=Path(folder)/'smoke'
 subprocess.run(['swiftc','-parse-as-library',str(code),'-o',str(binary)],check=True)
 subprocess.run([str(binary)],check=True)
