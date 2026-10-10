//
//  BrainSettingsView.swift
//  MinisApp
//
//  [T-brain] 设置 › 资料库:服务地址、连接状态、设备令牌(钥匙串)、
//  可选 Cloudflare Access 凭据、最近访问记录、断开。
//

import SwiftUI

struct BrainSettingsView: View {
    @ObservedObject private var store = BrainStore.shared
    @State private var baseURLDraft = ""
    @State private var tokenDraft = ""
    @State private var accessIdDraft = ""
    @State private var accessSecretDraft = ""
    @State private var message: String?
    @State private var confirmDisconnect = false
    @State private var audit: [BrainAuditEntry] = []
    @State private var auditError: String?
    @State private var loadingAudit = false

    var body: some View {
        Form {
            // 操作结果放在最上面:以前在表单最底部,点了「保存令牌并连接」要往下翻才知道成没成。
            if let message {
                Section { Text(message).font(.footnote) }
            }
            if let pending = store.pendingConnect {
                Section {
                    Text("收到一个资料库连接链接。确认后,令牌只保存在这台设备的钥匙串里。")
                        .font(.footnote)
                    Button {
                        if store.connect(pending) {
                            message = String(localized: "已连接资料库")
                            Task { await store.refreshHealth() }
                        } else {
                            message = String(localized: "令牌格式不对,没有保存。")
                        }
                    } label: { Label("使用这枚令牌连接", systemImage: "checkmark.shield") }
                    Button("忽略", role: .destructive) { store.pendingConnect = nil }
                } header: { Text("待确认") }
            }

            Section {
                TextField("https://wenjian.leoyuan.top", text: $baseURLDraft)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel(Text("资料库地址"))
                    .onSubmit(saveBaseURL)
                if baseURLDraft != store.baseURLString {
                    Button("保存地址", action: saveBaseURL)
                }
            } header: { Text("资料库地址") } footer: {
                Text("经 Cloudflare 隧道访问 Mac 上的资料库网关。只支持 https。")
            }

            Section {
                if store.isConfigured {
                    statusRows
                    Button {
                        Task { await store.refreshHealth() }
                    } label: { Label("重新检测", systemImage: "arrow.clockwise") }
                    .disabled(store.checking)
                } else {
                    Label("未连接", systemImage: "bolt.horizontal.circle")
                        .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                }
            } header: { Text("连接状态") }

            Section {
                SecureField("粘贴设备令牌", text: $tokenDraft)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel(Text("设备令牌"))
                Button {
                    let token = tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                    if store.connect(BrainConnectRequest(token: token, scopes: nil)) {
                        tokenDraft = ""
                        message = String(localized: "已连接资料库")
                        Task { await store.refreshHealth() }
                    } else {
                        message = String(localized: "令牌格式不对,没有保存。")
                    }
                } label: { Label(store.isConfigured ? String(localized: "替换令牌") : String(localized: "保存令牌并连接"), systemImage: "key.fill") }
                .disabled(tokenDraft.isEmpty)
            } header: { Text("设备令牌") } footer: {
                Text("令牌只存在本机钥匙串,不同步、不进备份。也可以由 Mac 用 devicectl 把令牌文件拷进 App,启动时自动导入并删除文件。")
            }

            Section {
                TextField("Client ID", text: $accessIdDraft)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel(Text("Cloudflare Access Client ID"))
                SecureField("Client Secret", text: $accessSecretDraft)
                    .textInputAutocapitalization(.never)
                    .accessibilityLabel(Text("Cloudflare Access Client Secret"))
                Button(store.hasAccessCredentials && accessIdDraft.isEmpty && accessSecretDraft.isEmpty
                       ? String(localized: "清除 Access 凭据") : String(localized: "保存 Access 凭据")) {
                    store.saveAccessCredentials(id: accessIdDraft, secret: accessSecretDraft)
                    accessIdDraft = ""
                    accessSecretDraft = ""
                    message = store.hasAccessCredentials ? String(localized: "Access 凭据已保存") : String(localized: "Access 凭据已清除")
                }
                .disabled(!store.hasAccessCredentials && (accessIdDraft.isEmpty || accessSecretDraft.isEmpty))
            } header: { Text("Cloudflare Access(可选)") } footer: {
                Text(store.hasAccessCredentials ? String(localized: "已保存在钥匙串,每次请求都会带上。")
                     : String(localized: "网关前面加了 Access 服务令牌时才需要填。"))
            }

            if store.isConfigured {
                Section {
                    if audit.isEmpty && !loadingAudit {
                        Button {
                            Task { await loadAudit() }
                        } label: { Label("查看最近访问", systemImage: "list.bullet.rectangle") }
                    }
                    if loadingAudit { ProgressView() }
                    if let auditError {
                        Text(auditError).font(.footnote).foregroundStyle(LeoTheme.ColorToken.warning)
                    }
                    ForEach(audit) { entry in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.endpoint).font(.footnote.monospaced())
                            Text(verbatim: [BrainDisplay.date(entry.at) ?? entry.at, entry.target ?? "", entry.status.map { "HTTP \($0)" } ?? ""]
                                .filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(.caption)
                                .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                        }
                        .accessibilityElement(children: .combine)
                    }
                } header: { Text("最近被访问的资料") } footer: {
                    Text("网关只记录这台设备访问了什么接口和文件,不记录正文。")
                }

                Section {
                    Button(role: .destructive) { confirmDisconnect = true } label: {
                        Label("断开资料库", systemImage: "bolt.horizontal.circle")
                    }
                } footer: { Text("删除本机钥匙串里的令牌,并清空离线缓存。") }
            }

        }
        .navigationTitle("资料库")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("断开资料库?", isPresented: $confirmDisconnect, titleVisibility: .visible) {
            Button("断开", role: .destructive) {
                store.disconnect()
                audit = []
                message = String(localized: "已断开,令牌已从本机删除。")
            }
            Button("取消", role: .cancel) {}
        }
        .onAppear {
            baseURLDraft = store.baseURLString
            store.importProvisionFileIfPresent()
        }
        .task(id: store.isConfigured) {
            if store.isConfigured, store.health == nil { await store.refreshHealth() }
        }
    }

    @ViewBuilder
    private var statusRows: some View {
        if store.checking {
            HStack { ProgressView(); Text("正在检测…") }
        } else if let health = store.health {
            Label(health.ok ? String(localized: "已连接") : String(localized: "网关异常"), systemImage: health.ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(health.ok ? LeoTheme.ColorToken.success : LeoTheme.ColorToken.warning)
            LabeledContent("文件", value: health.files.map(String.init) ?? "—")
            LabeledContent("知识卡", value: health.cards.map(String.init) ?? "—")
            LabeledContent("语义检索", value: health.semanticReady
                           ? String(localized: "已就绪")
                           : String(localized: "未就绪(先用关键词检索)"))
        } else if let error = store.statusError {
            Label(error, systemImage: "wifi.exclamationmark")
                .foregroundStyle(LeoTheme.ColorToken.warning)
        }
    }

    private func saveBaseURL() {
        if store.saveBaseURL(baseURLDraft) {
            baseURLDraft = store.baseURLString
            message = String(localized: "地址已保存")
            Task { await store.refreshHealth() }
        } else {
            message = BrainError.invalidBaseURL.message
        }
    }

    private func loadAudit() async {
        loadingAudit = true
        defer { loadingAudit = false }
        do {
            audit = try await store.requireClient().audit(limit: 30).items
            auditError = audit.isEmpty ? String(localized: "还没有访问记录。") : nil
        } catch {
            auditError = (error as? BrainError)?.message ?? BrainError.network.message
        }
    }
}
