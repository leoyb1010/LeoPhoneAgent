#!/usr/bin/env python3
"""File-browser export staging on real temporary files; no native share UI runs."""
from pathlib import Path
import importlib.util
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('audit_generator', ROOT / 'scripts/native-model-audit/generate.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
source = (ROOT / 'src/ios/Views/Rootfs/FileBrowserView.swift').read_text()
start = source.index('struct DocumentExportCopy')
production = source[start:source.index('private struct DocumentExportActivity', start)]
activity_source = source[source.index('private struct DocumentExportActivity:'):]
activity = r'''
final class UIActivityViewController {
 let activityItems: [URL]
 var completionWithItemsHandler: ((String?, Bool, [String]?, Error?) -> Void)?
 init(activityItems: [URL], applicationActivities: [String]?) { self.activityItems = activityItems }
}
@MainActor struct ExportActivityProbe {
 let copy: DocumentExportCopy
 let onFinished: () -> Void
 let onFailure: (String) -> Void
 struct Context {}
''' + module.extract_swift_method(activity_source, 'makeUIViewController') + '\n}\n'

swift = r'''
import Foundation
import UniformTypeIdentifiers
func expect(_ value: Bool, _ message: String) { if !value { print("FAIL: " + message); exit(1) } }
''' + production + activity + r'''
@main struct Runner {
 @MainActor static func main() async throws {
  let fm = FileManager.default
  let root = URL(fileURLWithPath: CommandLine.arguments[1])
  defer { try? fm.removeItem(at: root) }
  let a = root.appendingPathComponent("a"), b = root.appendingPathComponent("b"), temp = root.appendingPathComponent("exports")
  for directory in [a, b, temp] { try fm.createDirectory(at: directory, withIntermediateDirectories: true) }
  let name = "fixture-" + UUID().uuidString + ".txt"
  let first = a.appendingPathComponent(name), second = b.appendingPathComponent(name)
  try Data("first window".utf8).write(to: first); try Data("second window".utf8).write(to: second)
  let one = try DocumentExportCopy.stage(source: first, temporaryDirectory: temp)
  defer { one.cleanup() }
  let two = try DocumentExportCopy.stage(source: second, temporaryDirectory: temp)
  defer { two.cleanup() }
  expect(try String(contentsOf: one.fileURL, encoding: .utf8) == "first window", "second same-name export replaced first window's share URL")
  expect(one.fileURL != two.fileURL, "each export must own a different stable URL")
  expect(try String(contentsOf: two.fileURL, encoding: .utf8) == "second window", "second export bytes")
  let prior = Set(try fm.contentsOfDirectory(atPath: temp.path))
  do { _ = try DocumentExportCopy.stage(source: root.appendingPathComponent("missing/" + name), temporaryDirectory: temp); fatalError("missing source must report failure") } catch {}
  expect(Set(try fm.contentsOfDirectory(atPath: temp.path)) == prior, "failed export leaked staging or removed another export")
  expect(try String(contentsOf: one.fileURL, encoding: .utf8) == "first window", "failed retry damaged existing share")
  one.cleanup()
  expect(fm.fileExists(atPath: two.fileURL.path), "one completed/cancelled export cleaned another active export")
  expect(try String(contentsOf: first, encoding: .utf8) == "first window", "cleanup removed original")
  let unusual = a.appendingPathComponent("report.不常见格式")
  try Data("unusual extension".utf8).write(to: unusual)
  let safe = try DocumentExportCopy.stage(source: unusual, temporaryDirectory: temp)
  expect(safe.fileURL.pathExtension == "bin", "unsafe ShareKit extensions need a safe staged filename")
  expect(try String(contentsOf: safe.fileURL, encoding: .utf8) == "unusual extension", "sanitized copy bytes")
  safe.cleanup()

  let cancellation = ExportActivityProbe(copy: two, onFinished: {}, onFailure: { _ in }).makeUIViewController(context: .init())
  expect(fm.fileExists(atPath: cancellation.activityItems[0].path), "constructing share UI must not clean files before its consumer reads")
  cancellation.completionWithItemsHandler?(nil, false, nil, nil)
  expect(!fm.fileExists(atPath: two.fileURL.path), "system cancellation should clean its own copy")
  let completed = try DocumentExportCopy.stage(source: first, temporaryDirectory: temp)
  let completion = ExportActivityProbe(copy: completed, onFinished: {}, onFailure: { _ in }).makeUIViewController(context: .init())
  expect(try String(contentsOf: completion.activityItems[0], encoding: .utf8) == "first window", "consumer retains bytes until completion")
  completion.completionWithItemsHandler?("fixture", true, nil, nil)
  expect(!fm.fileExists(atPath: completed.fileURL.path), "successful activity should clean its copy after completion")
  print("PASS actual export staging: same-name coexistence, explicit copy failure, own-copy cleanup and safe extension")
 }
}
'''
with tempfile.TemporaryDirectory(prefix='leo-export-test-') as folder:
    root = Path(folder); code = root / 'Export.swift'; code.write_text(swift); binary = root / 'probe'
    subprocess.run(['swiftc', '-parse-as-library', str(code), '-o', str(binary)], check=True)
    subprocess.run([str(binary), str(root / 'data')], check=True)
    sdk = subprocess.check_output(['xcrun', '--sdk', 'iphonesimulator', '--show-sdk-path'], text=True).strip()
    fragment = source[source.index('struct DocumentExportView:'):source.index('// MARK: - View Model')]
    ui = root / 'ExportUI.swift'; ui.write_text('import SwiftUI\nimport UIKit\nimport UniformTypeIdentifiers\n' + fragment)
    subprocess.run(['swiftc', '-typecheck', '-parse-as-library', '-swift-version', '5', '-sdk', sdk,
                    '-target', 'arm64-apple-ios26.0-simulator', '-module-cache-path', str(root / 'sdk-cache'), str(ui)], check=True)
    print('PASS actual export SwiftUI/Activity wrapper iOS SDK typecheck (no share UI launched)')
