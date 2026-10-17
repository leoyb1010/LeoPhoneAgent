//
//  MailAccountsView.swift
//  MinisApp
//
//  [T-mail] 设置 → 邮箱账户:授权给 Agent 读的邮箱。填地址 + 授权码,测试通了才保存;
//  可以加多个,逐个开关。授权码只进本机钥匙串。
//

import SwiftUI

struct MailAccountsView: View {
    @ObservedObject private var store = MailAccountStore.shared
    @State private var showAdd = false
    @State private var editing: MailAccount?
    @State private var pendingDelete: MailAccount?

    var body: some View {
        List {
            Section {
                if store.accounts.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("还没有授权的邮箱")
                            .font(.headline)
                        Text("加一个之后,对话里直接说「看看我今天的未读邮件」「找一下携程发来的行程」「读第 3 封」,Agent 就能读到。")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                } else {
                    ForEach(store.accounts) { account in
                        row(account)
                    }
                }
            } footer: {
                Text("授权码只保存在这台设备的钥匙串里,不会同步、不会出现在日志里。Agent 只在你提到邮件时才去读;标记、移动、存草稿、发信会先问你,可以对某个邮箱选「始终允许」。不会永久删除邮件。")
            }

            Section {
                Button {
                    showAdd = true
                } label: {
                    Label("添加邮箱账户", systemImage: "plus.circle.fill")
                }
            } footer: {
                Text("支持 Gmail、QQ 邮箱、163 / 126 邮箱、iCloud 以及任何开了 IMAP 的邮箱。")
            }

            if !store.accounts.isEmpty {
                Section {
                    NavigationLink {
                        MailWatchRulesView()
                    } label: {
                        Label("邮件监控", systemImage: "bell.badge")
                    }
                } footer: {
                    Text("按发件人或主题盯着收件箱,来了符合条件的新邮件就通知你。打开 App 时和后台都会检查(后台频率由 iOS 决定,大约 15 分钟以上一次),不是实时推送。")
                }
            }
        }
        .navigationTitle("邮箱账户")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showAdd = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel(Text("添加邮箱账户"))
            }
        }
        .sheet(isPresented: $showAdd) {
            NavigationStack { MailAccountEditor(existing: nil) }
        }
        .sheet(item: $editing) { account in
            NavigationStack { MailAccountEditor(existing: account) }
        }
        .alert("移除这个邮箱?", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } })) {
            Button("移除", role: .destructive) {
                if let account = pendingDelete { store.remove(account) }
                pendingDelete = nil
            }
            Button("取消", role: .cancel) { pendingDelete = nil }
        } message: {
            Text("会删掉本机保存的授权码;邮箱本身不受影响。")
        }
    }

    private func row(_ account: MailAccount) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "envelope.fill")
                .foregroundStyle(account.isEnabled ? Color.accentColor : Color.secondary)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(account.displayName)
                    .font(.body)
                Text(account.label.isEmpty ? "\(account.preset.name) · \(account.host)" : "\(account.email) · \(account.preset.name)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if let error = account.lastError, !error.isEmpty {
                    Text(error)
                        .font(.caption2)
                        .foregroundStyle(LeoTheme.ColorToken.destructive)
                        .lineLimit(2)
                } else if let at = account.lastVerifiedAt {
                    Text("上次读取成功:\(at.formatted(.relative(presentation: .named)))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            Toggle("", isOn: Binding(get: { account.isEnabled }, set: { store.setEnabled($0, for: account) }))
                .labelsHidden()
                .accessibilityLabel(Text("启用 \(account.displayName)"))
        }
        .contentShape(Rectangle())
        .onTapGesture { editing = account }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { pendingDelete = account } label: { Label("移除", systemImage: "trash") }
        }
    }
}

/// 新增 / 编辑一个账户。密码框留空表示沿用原来的授权码。
struct MailAccountEditor: View {
    let existing: MailAccount?
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var store = MailAccountStore.shared

    @State private var presetId: String
    @State private var email: String
    @State private var password = ""
    @State private var label: String
    @State private var username: String
    @State private var host: String
    @State private var port: String
    @State private var usernameEdited = false
    @State private var smtpHost: String
    @State private var smtpPort: String
    @State private var alwaysAllowed: [String]
    @State private var testing = false
    @State private var result: String?
    @State private var failure: String?

    init(existing: MailAccount?) {
        self.existing = existing
        _presetId = State(initialValue: existing?.presetId ?? MailProviderPreset.qq.id)
        _email = State(initialValue: existing?.email ?? "")
        _label = State(initialValue: existing?.label ?? "")
        _username = State(initialValue: existing?.username ?? "")
        _host = State(initialValue: existing?.host ?? MailProviderPreset.qq.host)
        _port = State(initialValue: String(existing?.port ?? MailProviderPreset.qq.port))
        _usernameEdited = State(initialValue: existing.map { $0.username != $0.email } ?? false)
        _smtpHost = State(initialValue: existing?.smtpHost ?? "")
        _smtpPort = State(initialValue: existing?.smtpPort.map(String.init) ?? "")
        _alwaysAllowed = State(initialValue: existing.map { MailAlwaysAllow.grantedCategories(account: $0.email) } ?? [])
    }

    private var preset: MailProviderPreset { MailProviderPreset.preset(id: presetId) }

    /// 发信服务器输入框的占位:显示留空时实际会用的服务器。
    private var smtpPlaceholder: String {
        var probe = MailAccount(presetId: presetId, label: "", email: trimmedEmail, username: "", host: host, port: 993)
        probe.smtpHost = nil
        guard let server = probe.smtpServer else { return AppLocalized("发信服务器(SMTP)") }
        return AppLocalized("发信服务器(留空用 \(server.host):\(server.port))")
    }
    private var trimmedEmail: String { email.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var effectiveUsername: String {
        let u = username.trimmingCharacters(in: .whitespacesAndNewlines)
        return (usernameEdited && !u.isEmpty) ? u : trimmedEmail
    }
    private var canTest: Bool {
        trimmedEmail.contains("@") && !host.trimmingCharacters(in: .whitespaces).isEmpty
            && UInt16(port.trimmingCharacters(in: .whitespaces)) != nil
            && (!password.isEmpty || existing != nil)
    }

    var body: some View {
        Form {
            Section("邮箱服务") {
                Picker("邮箱服务", selection: $presetId) {
                    ForEach(MailProviderPreset.all) { p in Text(p.name).tag(p.id) }
                }
                .pickerStyle(.menu)
                .onChange(of: presetId) { _, new in
                    let p = MailProviderPreset.preset(id: new)
                    if p.id != MailProviderPreset.custom.id { host = p.host; port = String(p.port) }
                }
            }
            Section {
                TextField("邮箱地址", text: $email)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textContentType(.emailAddress)
                    .onChange(of: email) { _, new in
                        if existing == nil, let guessed = MailProviderPreset.guess(forEmail: new), guessed.id != presetId {
                            presetId = guessed.id
                        }
                    }
                SecureField(existing == nil ? preset.passwordLabel : "\(preset.passwordLabel)(留空保持不变)", text: $password)
                    .textContentType(.password)
                TextField("备注名(可选,比如「工作邮箱」)", text: $label)
            } footer: {
                VStack(alignment: .leading, spacing: 6) {
                    Text(preset.help)
                    if let url = preset.helpURL {
                        Link("打开\(preset.name)设置页", destination: url)
                            .font(.footnote)
                    }
                }
            }
            Section {
                DisclosureGroup("高级设置") {
                    TextField("IMAP 服务器", text: $host)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("端口", text: $port)
                        .keyboardType(.numberPad)
                    TextField("用户名(默认同邮箱地址)", text: $username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onChange(of: username) { _, _ in usernameEdited = true }
                    TextField(smtpPlaceholder, text: $smtpHost)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("发信端口(465 或 587,留空自动)", text: $smtpPort)
                        .keyboardType(.numberPad)
                }
            } footer: {
                Text("收信一律 SSL/TLS 直连(端口 993)。发信服务器留空时按邮箱服务自动选择;465 走 SSL,587 走 STARTTLS,都不会明文发送密码。")
            }
            if existing != nil, !alwaysAllowed.isEmpty {
                Section {
                    ForEach(alwaysAllowed, id: \.self) { category in
                        Label(category == SensitiveToolGate.Category.mailSend.rawValue
                              ? AppLocalized("发送邮件:始终允许") : AppLocalized("标记、移动、存草稿:始终允许"),
                              systemImage: "checkmark.shield")
                    }
                    Button("撤销长期允许", role: .destructive) {
                        if let existing { MailAlwaysAllow.revoke(account: existing.email) }
                        alwaysAllowed = []
                    }
                } header: {
                    Text("长期允许")
                } footer: {
                    Text("撤销后,下次改信或发信会重新问你。")
                }
            }
            Section {
                Button {
                    Task { await testAndSave() }
                } label: {
                    HStack {
                        Text(existing == nil ? "测试并保存" : "重新测试并保存")
                        Spacer()
                        if testing { ProgressView() }
                    }
                }
                .disabled(!canTest || testing)
                if let result {
                    Label(result, systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                        .font(.footnote)
                }
                if let failure {
                    Label(failure, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(LeoTheme.ColorToken.destructive)
                        .font(.footnote)
                }
            } footer: {
                Text("会实际登录一次并数一下收件箱,通了才保存。")
            }
        }
        .navigationTitle(existing == nil ? "添加邮箱" : "编辑邮箱")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("取消") { dismiss() }
            }
        }
        .interactiveDismissDisabled(testing)
    }

    @MainActor
    private func testAndSave() async {
        failure = nil
        result = nil
        guard let portValue = UInt16(port.trimmingCharacters(in: .whitespaces)) else {
            failure = "端口不对"
            return
        }
        var account = existing ?? MailAccount(presetId: presetId, label: "", email: "", username: "", host: "", port: portValue)
        account.presetId = presetId
        account.email = trimmedEmail
        account.username = effectiveUsername
        account.host = host.trimmingCharacters(in: .whitespaces)
        account.port = portValue
        account.label = label.trimmingCharacters(in: .whitespaces)
        let trimmedSMTP = smtpHost.trimmingCharacters(in: .whitespaces)
        account.smtpHost = trimmedSMTP.isEmpty ? nil : trimmedSMTP
        account.smtpPort = Int(smtpPort.trimmingCharacters(in: .whitespaces))
        account.smtpSecurity = account.smtpPort == 587 ? .startTLS : (account.smtpHost == nil ? nil : .implicitTLS)
        let secret: String
        if !password.isEmpty {
            secret = password.trimmingCharacters(in: .whitespacesAndNewlines)
        } else if let existing, let saved = store.password(accountId: existing.id) {
            secret = saved
        } else {
            failure = "请填写\(preset.passwordLabel)"
            return
        }
        testing = true
        defer { testing = false }
        do {
            let status = try await MailService.test(account: account, password: secret)
            store.setPassword(secret, accountId: account.id)
            account.lastVerifiedAt = Date()
            account.lastError = nil
            account.isEnabled = true
            store.update(account)
            result = "连接成功:收件箱 \(status.messages) 封,未读 \(status.unseen) 封"
            LeoHaptics.notification(.success)
            try? await Task.sleep(nanoseconds: 700_000_000)
            dismiss()
        } catch {
            failure = error.localizedDescription
            LeoHaptics.notification(.error)
        }
    }
}

/// [T-mail-watch] 设置 → 邮箱账户 → 邮件监控。
struct MailWatchRulesView: View {
    @ObservedObject private var store = MailWatchStore.shared
    @ObservedObject private var accounts = MailAccountStore.shared
    @State private var editing: MailWatchRule?
    @State private var checking = false

    var body: some View {
        List {
            Section {
                if store.rules.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("还没有监控规则").font(.headline)
                        Text("也可以在对话里说「盯着老板发来的邮件,来了提醒我」。").font(.subheadline).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                }
                ForEach(store.rules) { rule in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(rule.name)
                            Text(ruleSummary(rule)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                        Spacer()
                        Toggle("", isOn: Binding(get: { rule.isEnabled }, set: { on in
                            var r = rule; r.isEnabled = on; store.upsert(r)
                        }))
                        .labelsHidden()
                        .accessibilityLabel(Text("启用 \(rule.name)"))
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { editing = rule }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) { store.delete(id: rule.id) } label: { Label("删除", systemImage: "trash") }
                    }
                }
                Button {
                    editing = MailWatchRule(name: "")
                } label: {
                    Label("添加规则", systemImage: "plus.circle.fill")
                }
            } footer: {
                Text("第一次检查只记下现有邮件,不会把旧邮件当成新邮件提醒。")
            }
            Section {
                Button {
                    checking = true
                    Task { await MailWatcher.shared.checkNow(reason: "settings"); checking = false }
                } label: {
                    HStack { Text("立即检查"); Spacer(); if checking { ProgressView() } }
                }
                .disabled(checking || !store.hasActiveRules)
                if let at = store.lastCheckAt {
                    Text("\(at.formatted(.relative(presentation: .named))):\(store.lastSummary ?? "")")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("邮件监控")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $editing) { rule in
            NavigationStack { MailWatchRuleEditor(rule: rule) }
        }
    }

    private func ruleSummary(_ rule: MailWatchRule) -> String {
        var parts: [String] = [rule.account ?? AppLocalized("所有邮箱")]
        if !rule.fromContains.isEmpty { parts.append(AppLocalized("发件人含「\(rule.fromContains)」")) }
        if !rule.subjectContains.isEmpty { parts.append(AppLocalized("主题含「\(rule.subjectContains)」")) }
        if rule.fromContains.isEmpty && rule.subjectContains.isEmpty { parts.append(AppLocalized("所有新邮件")) }
        if rule.triggerAutomation { parts.append(AppLocalized("触发自动化")) }
        return parts.joined(separator: " · ")
    }
}

private struct MailWatchRuleEditor: View {
    @State var rule: MailWatchRule
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var accounts = MailAccountStore.shared

    var body: some View {
        Form {
            Section {
                TextField("规则名称(比如「老板」)", text: $rule.name)
                Picker("邮箱", selection: Binding(get: { rule.account ?? "" }, set: { rule.account = $0.isEmpty ? nil : $0 })) {
                    Text("所有邮箱").tag("")
                    ForEach(accounts.enabledAccounts) { a in Text(a.email).tag(a.email) }
                }
            }
            Section {
                TextField("发件人包含(逗号分隔,留空不限)", text: $rule.fromContains)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                TextField("主题包含(逗号分隔,留空不限)", text: $rule.subjectContains)
            } footer: {
                Text("两项都留空就是所有新邮件。多个关键词命中任意一个即可。")
            }
            Section {
                Toggle("发通知", isOn: $rule.notify)
                Toggle("触发自动化", isOn: $rule.triggerAutomation)
            } footer: {
                Text("打开「触发自动化」后,可以在 设置 → 自动化 里用情境信号「新邮件」或「\(rule.signalName)」安排要做的事。自动化回合可以读信,但不能发信、改信。")
            }
        }
        .navigationTitle(rule.name.isEmpty ? "添加规则" : rule.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("保存") {
                    rule.name = rule.name.trimmingCharacters(in: .whitespacesAndNewlines)
                    MailWatchStore.shared.upsert(rule)
                    dismiss()
                }
                .disabled(rule.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }
}
