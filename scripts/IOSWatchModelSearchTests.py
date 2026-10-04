#!/usr/bin/env python3
"""Run production Watch model filtering on fixtures, then iOS-SDK typecheck the view.

No simulator, WatchConnectivity, live credentials or user preferences are used.
The view typecheck uses inert adapters; the full app build remains a separate gate.
"""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
view = (ROOT / 'src/ios/Views/Settings/WatchSettingsView.swift').read_text()
bridge = (ROOT / 'src/ios/Shared/WatchBridge.swift').read_text()
catalog = (ROOT / 'src/ios/Providers/ModelCatalog.swift').read_text()


def declaration(source, signature):
    start = source.index(signature)
    opening = source.index('{', start)
    depth = 1
    end = opening + 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]


if 'private enum WatchModelSearch' not in view:
    raise SystemExit('FAIL: Watch model search is not implemented')
search = declaration(view, 'private enum WatchModelSearch').replace('private enum', 'enum', 1)
candidate = declaration(bridge, 'struct Candidate:')
matcher = declaration(catalog, 'static func matches(_ query: String, text: String)')
shared = 'import Foundation\nenum ModelCatalog {\n' + matcher + '\n}\n'
fixture = shared + 'enum WatchStandalone {\n' + candidate + '\n}\n' + search + r'''
func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { fatalError(message) }
}
let candidates = [
    WatchStandalone.Candidate(id: "p1/openai/gpt-4.1-mini", modelName: "Everyday", providerName: "Café Gateway"),
    WatchStandalone.Candidate(id: "p2/claude-sonnet-4-6", modelName: "编程助手", providerName: "个人 Anthropic"),
    WatchStandalone.Candidate(id: "p3/gpt-4.1-mini", modelName: "Everyday", providerName: "Office")
]
func ids(_ query: String) -> [String] {
    WatchModelSearch.results(candidates, query: query).map(\.id)
}
check(ids("") == candidates.map(\.id), "empty query must retain order and distinct providers")
check(ids(" \n\t ") == candidates.map(\.id), "whitespace must behave as empty search")
check(ids("EVERYDAY") == [candidates[0].id, candidates[2].id], "search model display name")
check(ids("cafe") == [candidates[0].id], "search provider, insensitive to accents/case")
check(ids("ＧＰＴ") == [candidates[0].id, candidates[2].id], "full-width model ID search")
check(ids("openai/gpt-4.1") == [candidates[0].id], "preserve slash in actual model ID")
check(ids("个人 编程") == [candidates[1].id], "search Chinese terms across provider and name")
check(ids("office MINI") == [candidates[2].id], "combine provider and model ID terms")
check(ids("not-a-model").isEmpty, "unmatched query must not return unrelated models")
check(WatchModelSearch.modelID(candidates[0]) == "openai/gpt-4.1-mini", "strip only provider identity prefix")
check(candidates.map(\.id) == ["p1/openai/gpt-4.1-mini", "p2/claude-sonnet-4-6", "p3/gpt-4.1-mini"], "browsing must not mutate candidate identities")
print("PASS Watch production search: names/providers/IDs, tokens, Chinese, case/diacritics/width, empty/no results, stable IDs/order")
'''
adapters = shared + r'''
import SwiftUI
enum WatchStandalone {
    enum Mode: String { case auto, always, off }
    static let modeKey = "fixture.mode"
    static let entryKey = "fixture.entry"
    static var mode: Mode { .auto }
    static var toolsOn: Set<String> = []
''' + candidate + r'''
    struct ToolRow: Identifiable { let id: String; let usable: Bool; let reason: String? }
    struct Config { let modelName: String; let providerName: String }
    enum Unavailable: Error { case missing; var explanation: String { "Fixture unavailable" } }
    static func candidates() -> [Candidate] { [] }
    static func toolRows() -> [ToolRow] { [] }
    static func resolve() -> Result<Config, Unavailable> { .failure(.missing) }
}
@MainActor final class WatchBridge: ObservableObject {
    static let shared = WatchBridge()
    @Published var watchUnreachableReason: String?
    func refreshWatchState() {}
    func syncStandaloneConfigIfNeeded(force: Bool) {}
}
'''
with tempfile.TemporaryDirectory(prefix='leo-watch-model-search-') as folder:
    folder = Path(folder)
    source = folder / 'Search.swift'
    source.write_text(fixture)
    binary = folder / 'search-tests'
    subprocess.run(['xcrun', 'swiftc', str(source), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
    stubs = folder / 'Adapters.swift'
    stubs.write_text(adapters)
    sdk = subprocess.check_output(['xcrun', '--sdk', 'iphoneos', '--show-sdk-path'], text=True).strip()
    subprocess.run(['xcrun', 'swiftc', '-typecheck', '-swift-version', '5', '-sdk', sdk,
                    '-target', 'arm64-apple-ios26.0', str(stubs),
                    str(ROOT / 'src/ios/Views/Settings/WatchSettingsView.swift')], check=True)
    print('PASS complete WatchSettingsView iOS SDK typecheck with inert adapters; no device execution')
