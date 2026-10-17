import SafariServices
import SwiftUI
import UIKit

// [fix-remote] 在手机上登录 Mac 上的外部 agent：Mac 在伪终端里跑 CLI 的无界面登录，手机打开授权页、
// 抄设备码、或把网页给的授权码 / API key 回填给 Mac。凭据只写在 Mac 上，这里不保存、不回显。

extension LeoAgentClient {
    private static func loginPath(_ key: String, _ tail: String = "") -> String {
        "/agents/\(key.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? key)/login\(tail)"
    }

    func startAgentLogin(key: String) async throws -> AgentLoginFlow {
        let obj = try await postJSON(Self.loginPath(key), body: [:], service: .harness)
        guard let flow = AgentLoginFlow.parse(obj) else { throw GatewayError.malformedResponse("login flow") }
        return flow
    }

    func agentLoginStatus(key: String, flowId: String) async throws -> AgentLoginFlow {
        let obj = try await getJSON(Self.loginPath(key, "/\(flowId)"), service: .harness)
        guard let flow = AgentLoginFlow.parse(obj) else { throw GatewayError.malformedResponse("login flow") }
        return flow
    }

    func submitAgentLoginCode(key: String, flowId: String, code: String) async throws {
        _ = try await postJSON(Self.loginPath(key, "/\(flowId)/code"), body: ["code": code], service: .harness)
    }

    func cancelAgentLogin(key: String, flowId: String) async {
        _ = try? await postJSON(Self.loginPath(key, "/\(flowId)/cancel"), body: [:], service: .harness)
    }
}

private struct SafariSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }
    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

struct AgentLoginSheet: View {
    let client: LeoAgentClient
    let kind: HarnessKind
    var onFinished: (Bool) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss
    @State private var flow: AgentLoginFlow?
    @State private var code = ""
    @State private var errorText: String?
    @State private var showSafari = false
    @State private var copied = false
    @State private var submitting = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    statusRow
                    if let url = flow?.url {
                        Button {
                            showSafari = true
                        } label: {
                            Label(flow?.codeKind == "api_key" ? "打开获取 API key 的页面" : "打开授权页",
                                  systemImage: "safari")
                        }
                        .sheet(isPresented: $showSafari) { SafariSheet(url: url).ignoresSafeArea() }
                    }
                    if let userCode = flow?.userCode {
                        HStack {
                            Text(userCode).font(.system(size: 22, weight: .semibold, design: .monospaced))
                            Spacer()
                            Button(copied ? "已复制" : "复制") {
                                UIPasteboard.general.string = userCode
                                copied = true
                                LeoHaptics.notification(.success)
                            }
                        }
                    }
                } footer: {
                    Text(footerText)
                }
                if flow?.needsCode == true, flow?.isFinished == false {
                    Section {
                        SecureField(flow?.codeKind == "api_key" ? "粘贴 API key" : "粘贴网页给出的授权码", text: $code)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button {
                            submit()
                        } label: {
                            HStack { Text("交给 Mac"); if submitting { Spacer(); ProgressView() } }
                        }
                        .disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || submitting
                                  || flow?.status == .verifying)
                    } footer: {
                        Text("只发给这台 Mac，由它写进 \(kind.displayName) 自己的登录位置；手机上不保存。")
                    }
                }
                if let errorText {
                    Section { Text(errorText).foregroundStyle(.red).font(.footnote) }
                }
            }
            .navigationTitle(Text("登录 \(kind.displayName)"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(flow?.isFinished == true ? "完成" : "取消") { close() }
                }
            }
            .task { await run() }
        }
    }

    @ViewBuilder private var statusRow: some View {
        switch flow?.status {
        case nil, .starting?:
            HStack { ProgressView(); Text("正在让 Mac 准备登录…").foregroundStyle(.secondary) }
        case .waitingForUser?:
            Label(flow?.needsCode == true ? "完成网页上的步骤，再把结果粘贴到下面" : "在授权页确认下面的代码",
                  systemImage: "hand.point.right")
        case .verifying?:
            HStack { ProgressView(); Text("Mac 正在验证…").foregroundStyle(.secondary) }
        case .succeeded?:
            Label("已登录", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        case .failed?:
            Label(flow?.message ?? "登录失败", systemImage: "xmark.circle.fill").foregroundStyle(.red)
        case .cancelled?:
            Label("已取消", systemImage: "minus.circle").foregroundStyle(.secondary)
        }
    }

    private var footerText: String {
        switch flow?.codeKind {
        case "api_key": return "打开页面取一个 API key，粘贴到下面交给 Mac。"
        case "auth_code": return "在授权页登录并同意，页面会给出一段授权码，复制后粘贴到下面。"
        default: return "授权页上确认这个代码后，Mac 上的登录会自动完成。"
        }
    }

    private func run() async {
        do {
            var current = try await client.startAgentLogin(key: kind.key)
            flow = current
            // 有网址就直接打开（设备码流程用户只需在页面上确认）。
            if current.url != nil, !current.needsCode || current.codeKind == "auth_code" { showSafari = true }
            while !current.isFinished, !Task.isCancelled {
                try await Task.sleep(for: .seconds(2))
                current = try await client.agentLoginStatus(key: kind.key, flowId: current.flowId)
                if current.url != nil, flow?.url == nil { showSafari = true }
                flow = current
            }
            if current.status == .succeeded {
                LeoHaptics.notification(.success)
                showSafari = false
                onFinished(true)
            }
        } catch {
            if !LeoLinkProblem.isCancellation(error) { errorText = error.localizedDescription }
        }
    }

    private func submit() {
        guard let flow else { return }
        let value = code.trimmingCharacters(in: .whitespacesAndNewlines)
        submitting = true
        Task {
            defer { submitting = false }
            do {
                try await client.submitAgentLoginCode(key: kind.key, flowId: flow.flowId, code: value)
                code = ""
                showSafari = false
            } catch {
                errorText = error.localizedDescription
            }
        }
    }

    private func close() {
        if let flow, !flow.isFinished {
            let key = kind.key
            Task { await client.cancelAgentLogin(key: key, flowId: flow.flowId) }
        }
        onFinished(flow?.status == .succeeded)
        dismiss()
    }
}
