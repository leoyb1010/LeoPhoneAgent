import SwiftUI
import WebKit

/// 密码只输入到服务器自己的 Better Auth 网页，原生层不收集、不注入密码。
struct PaperclipLoginView: View {
    let profile: PaperclipProfile
    let verify: () async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var checking = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Text("请在下面的服务器网页登录。完成后验证人类用户身份；不支持智能体或管理员 API 密钥。")
                    .font(.footnote).foregroundStyle(.secondary).padding()
                Text(profile.origin.absoluteString).font(.caption).textSelection(.enabled).padding(.bottom, 8)
                if let error { Text(error).foregroundStyle(.red).font(.footnote).padding() }
                PaperclipLoginBrowser(profile: profile, error: $error)
            }
            .navigationTitle("登录 Paperclip")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(checking) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(checking ? "正在验证" : "完成登录并验证") {
                        checking = true
                        Task {
                            if await verify() { dismiss() }
                            else { error = "尚未验证成功。请检查服务器是否就绪，并完成登录后重试。" }
                            checking = false
                        }
                    }.disabled(checking)
                }
            }
        }
        .interactiveDismissDisabled(checking)
    }
}

private struct PaperclipLoginBrowser: UIViewRepresentable {
    let profile: PaperclipProfile
    @Binding var error: String?
    func makeCoordinator() -> Coordinator { Coordinator(error: $error) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = PaperclipWorkspaceStore.websiteData(for: profile)
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = true
        let login = profile.origin.appendingPathComponent("auth")
        var request = URLRequest(url: login)
        request.setValue("zh-CN,zh;q=0.9", forHTTPHeaderField: "Accept-Language")
        view.load(request)
        return view
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.stopLoading()
        uiView.navigationDelegate = nil
    }
    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        @Binding var error: String?
        init(error: Binding<String?>) { _error = error }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard action.request.url?.scheme?.lowercased() == "https" else {
                error = "登录页面尝试打开非 HTTPS 地址，已阻止。请检查服务器和登录服务配置。"
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            self.error = "登录页面加载失败，请检查网络后重新打开。"
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            self.error = "无法安全连接登录页面，请检查服务器地址和 HTTPS 证书。"
        }
    }
}
