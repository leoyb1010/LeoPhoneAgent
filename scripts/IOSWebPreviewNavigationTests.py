#!/usr/bin/env python3
"""Execute production preview navigation/load methods with inert WebKit adapters.

Exercises main-frame A→B, failures, redirects, subframes/new windows and file
scope without a browser, simulator, network access or user data.
"""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
source = (ROOT / 'src/ios/Views/Chat/WebPreviewSheet.swift').read_text()
errors = (ROOT / 'src/ios/Views/Chat/WebLoadError.swift').read_text()


def declaration(text, signature):
    start = text.index(signature)
    opening = text.index('{', start)
    depth, end = 1, opening + 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    return text[start:end]


delegates = declaration(source, 'extension WebViewHolder: WKNavigationDelegate')
confirm = declaration(delegates, 'private func confirmExternalOpen(')
delegates = delegates.replace(confirm, 'private func confirmExternalOpen(_ url: URL, from webView: WKWebView) {}')
methods = '\n'.join(declaration(source, signature) for signature in [
    'private func performLoad(', 'func retryFailedLoad()',
    'private func loadLocalFileBypassingCache(', 'func reload()'
])
for signature in ['func actionURL(', 'private func canReadFileURL(']:
    if signature in source:
        methods += '\n' + declaration(source, signature)

swift = r'''
import Foundation
enum WKError { static let errorDomain = "WKErrorDomain" }
enum WKNavigationActionPolicy { case allow, cancel }
enum WKNavigationType { case linkActivated, other }
struct WKFrameInfo { let isMainFrame: Bool }
struct WKNavigationAction {
    let request: URLRequest
    let targetFrame: WKFrameInfo?
    let navigationType: WKNavigationType
}
final class WKNavigation {}
protocol WKNavigationDelegate {}
final class WKWebView {
    var url: URL?
    var requests: [URLRequest] = []
    var fileScopes: [URL] = []
    var reloads = 0
    func load(_ request: URLRequest) { requests.append(request) }
    func loadFileRequest(_ request: URLRequest, allowingReadAccessTo scope: URL) {
        requests.append(request); fileScopes.append(scope)
    }
    func loadFileURL(_ url: URL, allowingReadAccessTo scope: URL) {
        requests.append(URLRequest(url: url)); fileScopes.append(scope)
    }
    func reload() { reloads += 1 }
}
struct AppLogger { init(category: String) {}; func warning(_ text: String) {} }
''' + declaration(errors, 'struct WebLoadError: Equatable') + r'''
final class WebViewHolder {
    let webView = WKWebView()
    var loadError: WebLoadError?
    var pendingURL: URL?
    var currentURL = ""
    var pendingLocalFile: Bool
    let localFileReadAccessURL: URL?
    var activeNavigation: WKNavigation?
    init(url: URL, localFile: Bool = false) {
        pendingURL = url; pendingLocalFile = localFile
        localFileReadAccessURL = localFile && url.isFileURL ? url.deletingLastPathComponent() : nil
    }
''' + methods + '\n}\n' + delegates + r'''
func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { print("FAIL: " + message); exit(1) }
}
func action(_ url: URL, main: Bool? = true) -> WKNavigationAction {
    WKNavigationAction(request: URLRequest(url: url), targetFrame: main.map(WKFrameInfo.init), navigationType: .linkActivated)
}
let a = URL(string: "https://example.test/a")!, b = URL(string: "https://example.test/b")!
let holder = WebViewHolder(url: a)
holder.webView.url = a
holder.webView(holder.webView, decidePolicyFor: action(b), decisionHandler: { _ in })
let navigationB = WKNavigation()
holder.webView(holder.webView, didStartProvisionalNavigation: navigationB)
holder.webView(holder.webView, didFailProvisionalNavigation: navigationB,
               withError: NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut,
                                  userInfo: [NSURLErrorFailingURLErrorKey: b]))
holder.retryFailedLoad()
check(holder.webView.requests.last?.url == b, "B failed, but Retry loaded initial A")
'''

# The first assertion reproduces the existing retry bug before new helpers exist.
if 'func actionURL(' in source:
    swift += r'''
holder.webView.url = b
holder.webView(holder.webView, didCommit: navigationB)
holder.webView(holder.webView, didFinish: navigationB)
check(holder.actionURL(fallback: a) == b, "share/copy/open must use visible B")
holder.webView(holder.webView, decidePolicyFor: action(a, main: false), decisionHandler: { _ in })
check(holder.pendingURL == b, "subframe replaced pending main-frame target")
holder.webView(holder.webView, decidePolicyFor: action(a, main: nil), decisionHandler: { _ in })
check(holder.pendingURL == b, "new-window target replaced this preview's target")
let c = URL(string: "https://example.test/redirected")!
holder.webView.url = c
holder.webView(holder.webView, didReceiveServerRedirectForProvisionalNavigation: navigationB)
holder.webView(holder.webView, didFailProvisionalNavigation: navigationB,
               withError: URLError(.cannotConnectToHost))
check(holder.loadError?.failedURL == c, "redirect failure lost latest top-level destination")
check(holder.actionURL(fallback: a) == c, "error-overlay actions lost failed target")
holder.retryFailedLoad()
check(holder.webView.requests.last?.url == c, "retry ignored redirect destination")
let newer = WKNavigation()
holder.webView(holder.webView, didStartProvisionalNavigation: newer)
holder.webView(holder.webView, didFailProvisionalNavigation: navigationB,
               withError: URLError(.timedOut))
check(holder.loadError == nil, "superseded navigation overwrote current error state")
holder.webView(holder.webView, didFailProvisionalNavigation: newer,
               withError: URLError(.cancelled))
check(holder.loadError == nil, "benign cancel produced error UI")

let fileA = URL(fileURLWithPath: "/fixture/reports/a.html")
let fileB = URL(fileURLWithPath: "/fixture/reports/sub/b.html")
let local = WebViewHolder(url: fileA, localFile: true)
local.webView.url = fileA
local.webView(local.webView, decidePolicyFor: action(fileB), decisionHandler: { _ in })
let fileNavigation = WKNavigation()
local.webView(local.webView, didStartProvisionalNavigation: fileNavigation)
local.webView(local.webView, didFailProvisionalNavigation: fileNavigation,
              withError: NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotOpenFile,
                                 userInfo: [NSURLErrorFailingURLErrorKey: fileB]))
local.retryFailedLoad()
check(local.webView.requests.last?.url == fileB, "local retry lost the failed file")
check(local.webView.fileScopes.last == fileA.deletingLastPathComponent(), "local retry changed original read scope")
check(local.webView.requests.last?.cachePolicy == .reloadIgnoringLocalCacheData, "file retry no longer bypasses stale cache")
let outside = URL(fileURLWithPath: "/fixture/secret.html")
local.loadError = WebLoadError(error: URLError(.cannotOpenFile), failedURL: outside)
let before = local.webView.requests.count
local.retryFailedLoad()
check(local.webView.requests.count == before, "retry expanded local-file access outside original directory")
check(local.actionURL(fallback: fileA) == fileA, "export action exposed out-of-scope file URL")
holder.loadError = WebLoadError(error: URLError(.cannotOpenFile), failedURL: outside)
check(holder.actionURL(fallback: a) == a, "remote preview export exposed an ungranted local file")
local.loadError = WebLoadError(error: URLError(.timedOut), failedURL: b)
local.retryFailedLoad()
check(local.webView.requests.last?.url == b && local.webView.fileScopes.count == 1,
      "local-to-web retry incorrectly used file loading or granted a new scope")
print("PASS production preview navigation: A→B, failure/redirect retry, subframes, new windows, stale/cancelled callbacks, file cache/scope, remote-file exports")
'''
else:
    swift += 'print("FAIL: preview action URL tracking is absent"); exit(1)\n'

with tempfile.TemporaryDirectory(prefix='leo-web-preview-navigation-') as folder:
    path = Path(folder) / 'Navigation.swift'
    path.write_text(swift)
    binary = Path(folder) / 'navigation-tests'
    subprocess.run(['xcrun', 'swiftc', str(path), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
    adapters = Path(folder) / 'Adapters.swift'
    adapters.write_text(r'''
import Foundation
import SwiftUI
import UIKit
import WebKit
final class FixtureSchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {}
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}
enum BrowserUseManager {
    static let sharedProcessPool = WKProcessPool()
    static let sharedMinisSchemeHandler = FixtureSchemeHandler()
    static let printMessageHandlerName = "fixture.print"
    static func printBridgeScript() -> WKUserScript {
        WKUserScript(source: "", injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }
}
enum SafeKVCSetTrue { static func apply(_ value: AnyObject, key: String) {} }
final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    init(_ target: WKScriptMessageHandler) {}
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {}
}
enum UserAgentProfile: String {
    case mobileSafari, desktopSafari, custom
    var userAgentString: String { "fixture" }
}
enum PrintHelper { static func printWebView(_ webView: WKWebView, jobName: String) {} }
struct AppLogger { init(category: String) {}; func warning(_ text: String) {} }
final class BrowserTabPool {}
struct MinisShareSheet: View { let url: URL; var body: some View { EmptyView() } }
struct WideSheetSizingModifier: ViewModifier {
    func body(content: Content) -> some View { content }
}
''')
    sdk = subprocess.check_output(['xcrun', '--sdk', 'iphoneos', '--show-sdk-path'], text=True).strip()
    subprocess.run(['xcrun', 'swiftc', '-typecheck', '-swift-version', '5', '-sdk', sdk,
                    '-target', 'arm64-apple-ios26.0', str(adapters),
                    str(ROOT / 'src/ios/Views/Chat/WebLoadError.swift'),
                    str(ROOT / 'src/ios/Views/Chat/WebPreviewSheet.swift')], check=True)
    print('PASS complete WebPreviewSheet/WebLoadError iOS SDK typecheck with inert app adapters')
