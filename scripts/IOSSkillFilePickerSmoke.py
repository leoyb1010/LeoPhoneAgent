#!/usr/bin/env python3
"""Run the production skill document-picker delegate against real temporary files.
UIKit is only a delegate-type adapter; FileManager and UTF-8 decoding are real.
"""
from pathlib import Path
import subprocess,tempfile,textwrap
root=Path(__file__).resolve().parents[1]
source=(root/'src/ios/Views/Skills/SkillsManagementView.swift').read_text()
start=source.index('private enum SkillFilePickResult')
enum=source[start:source.index('\nprivate struct SkillFileDocumentPicker',start)]
start=source.index('    class Coordinator: NSObject, UIDocumentPickerDelegate')
end=source.index('\n}\n\n// MARK: - Settings-style row icon',start)
coordinator=textwrap.dedent(source[start:end]).replace('class Coordinator:', 'private class Coordinator:', 1)
callback='''switch result {case .success(let picked): successes.append(picked);case .failure: failures += 1}''' if 'Result<SkillFilePickResult, Error>' in coordinator else 'successes.append(result)'
swift='import Foundation\nprotocol UIDocumentPickerDelegate {}\nclass UIDocumentPickerViewController {}\n'+enum+'\n'+coordinator+r'''
func expect(_ c:Bool,_ m:String){if !c{print("FAIL: "+m);exit(1)}}
@main struct Runner {
 static func main() throws {
  let fm=FileManager.default;let root=fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try fm.createDirectory(at:root,withIntermediateDirectories:true)
  var successes:[SkillFilePickResult]=[];var failures=0
  defer {
   try?fm.removeItem(at:root)
   for picked in successes {if case .archiveURL(let url)=picked {try?fm.removeItem(at:url)}}
  }
  let delegate=Coordinator { result in
''' + callback+r'''
  }
  let controller=UIDocumentPickerViewController()
  let missing=root.appendingPathComponent("SKILL.md")
  delegate.documentPicker(controller,didPickDocumentsAt:[missing])
  expect(failures==1 && successes.isEmpty,"file read failure was silently swallowed")
  try Data("---\nname: fixture\n---\noriginal skill".utf8).write(to:missing)
  delegate.documentPicker(controller,didPickDocumentsAt:[missing])
  expect(successes.count==1,"retry after read failure did not deliver skill content")
  if case .text(let content)=successes[0] {expect(content.contains("original skill"),"retry text changed")} else {expect(false,"text became archive")}
  let invalid=root.appendingPathComponent("invalid.md");try Data([0xff,0xfe,0xff]).write(to:invalid)
  delegate.documentPicker(controller,didPickDocumentsAt:[invalid])
  expect(failures==2 && successes.count==1,"UTF-8 decode failure was reported as success or swallowed")
  let archive=root.appendingPathComponent("fixture-"+UUID().uuidString+".zip")
  delegate.documentPicker(controller,didPickDocumentsAt:[archive])
  expect(failures==3 && successes.count==1,"archive copy failure was swallowed")
  try Data("archive original".utf8).write(to:archive)
  delegate.documentPicker(controller,didPickDocumentsAt:[archive])
  expect(successes.count==2,"retry archive copy failed")
  guard case .archiveURL(let staged)=successes[1] else {expect(false,"archive not staged");return}
  expect(staged != archive && (try String(contentsOf:archive,encoding:.utf8))=="archive original","source archive removed or overwritten")
  // A second import of the same name must not invalidate an earlier callback.
  try Data("second version".utf8).write(to:archive)
  delegate.documentPicker(controller,didPickDocumentsAt:[archive])
  expect(successes.count==3,"second archive import failed")
  guard case .archiveURL(let second)=successes[2] else {expect(false,"second archive not staged");return}
  expect(staged != second,"two imports share a destructive staging filename")
  expect(try String(contentsOf:staged,encoding:.utf8)=="archive original","second import destroyed earlier staged bytes")
  expect(try String(contentsOf:second,encoding:.utf8)=="second version","second import has stale bytes")
  delegate.documentPicker(controller,didPickDocumentsAt:[staged])
  expect(successes.count==4,"an archive already in tmp could not be imported")
  expect(try String(contentsOf:staged,encoding:.utf8)=="archive original","import deleted its own tmp source")
  print("PASS production skill picker: read/decode/copy failures, retry, distinct staged archives, original preservation")
 }
}
'''
# Move throwing boolean operands out of short-circuit evaluation.
swift=swift.replace('expect(staged != archive && (try String(contentsOf:archive,encoding:.utf8))=="archive original",', 'let original=try String(contentsOf:archive,encoding:.utf8)\n  expect(staged != archive && original=="archive original",')
with tempfile.TemporaryDirectory(prefix='leo-skill-picker-') as folder:
 code=Path(folder)/'Smoke.swift';code.write_text(swift);binary=Path(folder)/'smoke'
 subprocess.run(['swiftc','-parse-as-library',str(code),'-o',str(binary)],check=True)
 subprocess.run([str(binary)],check=True)
