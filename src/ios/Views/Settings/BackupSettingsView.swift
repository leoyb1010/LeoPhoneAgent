import SwiftUI

/// 设置 › 数据与关于 › 备份与恢复
///
/// 本地备份包（.minisbak）：导出（类别选择 + 可选密码）、从文件恢复、30 天历史。
/// 没有远端 / 传输配置——包交给「文件」App、分享面板或已挂载的文件夹。
struct BackupSettingsView: View {
    @ObservedObject private var runner = BackupRunController.shared
    @ObservedObject private var history = BackupHistory.shared

    @AppStorage("backup.selectedCategories") private var storedCategories = ""
    @State private var selected: Set<BackupCategory> = Set(BackupCategory.backupable)
    @State private var encrypt = true
    @State private var passphrase = ""
    @State private var confirmPassphrase = ""
    @State private var mountedTargets: Set<UUID> = []
    @State private var localPackages: [URL] = []
    @State private var shareURL: URL?
    @State private var saveURL: URL?
    @State private var showStopConfirm = false

    private var mountedFolders: [MountedFolderEntry] {
        MountedFoldersManager.shared.entries.filter(\.effectiveWritable)
    }

    private var passphraseProblem: String? {
        guard encrypt else { return nil }
        if passphrase.count < BackupCrypto.minimumPassphraseLength {
            return String(localized: "密码至少 \(BackupCrypto.minimumPassphraseLength) 位")
        }
        if passphrase != confirmPassphrase { return String(localized: "两次输入的密码不一致") }
        return nil
    }

    private var canStart: Bool {
        !runner.isRunning && !selected.isEmpty && passphraseProblem == nil
    }

    var body: some View {
        List {
            Section {
                ForEach(BackupCategory.backupable, id: \.self) { category in
                    Toggle(isOn: binding(for: category)) {
                        Label(category.displayName, systemImage: category.systemImage)
                    }
                }
            } header: {
                Text("备份内容")
            } footer: {
                Text("备份包含对话（含附件和工作区文件）、共享文件夹、技能、记忆、服务商与模型分组、MCP 服务器和环境变量。不包含沙箱系统文件。")
            }

            Section {
                Toggle("使用密码加密（推荐）", isOn: $encrypt.animation())
                if encrypt {
                    SecureField("备份密码", text: $passphrase)
                        .textContentType(.newPassword)
                    SecureField("再次输入密码", text: $confirmPassphrase)
                        .textContentType(.newPassword)
                    if let problem = passphraseProblem, !passphrase.isEmpty {
                        Text(problem).font(.footnote).foregroundStyle(LeoTheme.ColorToken.warning)
                    }
                }
            } header: {
                Text("加密")
            } footer: {
                Text(encrypt
                     ? "加密后才会包含 API 密钥和环境变量的值。密码不会被保存，忘记后无法恢复这个备份。"
                     : "未加密的备份不包含任何 API 密钥和环境变量的值，MCP 服务器里的密钥也会被移除；对话内容以明文保存，请妥善保管备份文件。")
            }

            if !mountedFolders.isEmpty {
                Section {
                    ForEach(mountedFolders) { folder in
                        Toggle(isOn: Binding(
                            get: { mountedTargets.contains(folder.id) },
                            set: { on in if on { mountedTargets.insert(folder.id) } else { mountedTargets.remove(folder.id) } }
                        )) {
                            Label(folder.name, systemImage: "externaldrive.connected.to.line.below")
                        }
                    }
                } header: {
                    Text("同时复制到")
                } footer: {
                    Text("备份总会保存到「文件」App › LeoBot › Backups，也可以同时复制到已挂载的文件夹（如 iCloud 云盘、WebDAV、SMB）。")
                }
            }

            Section {
                if runner.activity == .exporting {
                    HStack(spacing: LeoTheme.Spacing.sm) {
                        ProgressView()
                        Text(runner.statusText.isEmpty ? String(localized: "正在备份…") : runner.statusText)
                            .font(.subheadline)
                            .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                            .lineLimit(2)
                    }
                    Button("停止备份", role: .destructive) { showStopConfirm = true }
                } else {
                    Button {
                        startExport()
                    } label: {
                        Label("立即备份", systemImage: "archivebox")
                    }
                    .disabled(!canStart)
                    if runner.activity == .restoring {
                        Text("正在恢复，完成后才能备份").font(.footnote).foregroundStyle(LeoTheme.ColorToken.secondaryText)
                    }
                }
                if let error = runner.lastError, runner.activity == .idle {
                    Text(error).font(.footnote).foregroundStyle(LeoTheme.ColorToken.destructive)
                }
            }

            if let outcome = runner.lastExport {
                Section("刚刚完成的备份") {
                    VStack(alignment: .leading, spacing: LeoTheme.Spacing.xxs) {
                        Text(outcome.packageURL.lastPathComponent).font(.subheadline).lineLimit(2)
                        Text(ByteCountFormatter.string(fromByteCount: outcome.summary.totalBytes, countStyle: .file)
                             + (outcome.summary.encrypted ? String(localized: " · 已加密") : String(localized: " · 未加密")))
                            .font(.footnote).foregroundStyle(LeoTheme.ColorToken.secondaryText)
                        if outcome.summary.skippedFiles > 0 || outcome.summary.notDownloadedFiles > 0 {
                            Text("有 \(outcome.summary.skippedFiles + outcome.summary.notDownloadedFiles) 个文件未包含（超出大小上限或尚未从 iCloud 下载）")
                                .font(.footnote).foregroundStyle(LeoTheme.ColorToken.warning)
                        }
                        ForEach(outcome.deliveryFailures, id: \.self) { failure in
                            Text(failure).font(.footnote).foregroundStyle(LeoTheme.ColorToken.destructive)
                        }
                    }
                    Button { shareURL = outcome.packageURL } label: { Label("分享…", systemImage: "square.and.arrow.up") }
                    Button { saveURL = outcome.packageURL } label: { Label("存储到「文件」…", systemImage: "folder") }
                }
            }

            Section {
                NavigationLink {
                    BackupRestoreView(initialPackage: nil, ownsInitialPackage: false)
                } label: {
                    Label("从文件恢复…", systemImage: "arrow.counterclockwise")
                }
                ForEach(localPackages, id: \.self) { url in
                    NavigationLink {
                        BackupRestoreView(initialPackage: url, ownsInitialPackage: false)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(url.lastPathComponent).font(.subheadline).lineLimit(1)
                            Text(Self.fileSubtitle(url)).font(.caption).foregroundStyle(LeoTheme.ColorToken.secondaryText)
                        }
                    }
                }
                .onDelete { offsets in
                    for i in offsets { try? FileManager.default.removeItem(at: localPackages[i]) }
                    localPackages = BackupDelivery.localPackages()
                }
            } header: {
                Text("恢复")
            } footer: {
                Text("恢复会合并到现有数据，不会删除任何内容：本地更新的内容会保留，备份里更新或缺少的内容会补回。恢复的数据会通过 iCloud 同步到你的其他设备。")
            }

            Section {
                if history.records.isEmpty {
                    LeoEmptyState(systemImage: "clock.arrow.circlepath", title: String(localized: "还没有备份记录"),
                                  message: String(localized: "最近 30 天的备份和恢复会显示在这里"))
                } else {
                    ForEach(history.records) { record in
                        NavigationLink {
                            BackupHistoryDetailView(recordId: record.id)
                        } label: {
                            BackupHistoryRow(record: record)
                        }
                    }
                    .onDelete { offsets in
                        for i in offsets { history.remove(history.records[i].id) }
                    }
                }
            } header: {
                Text("历史记录（30 天）")
            }
        }
        .navigationTitle("备份与恢复")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            loadSelection()
            localPackages = BackupDelivery.localPackages()
        }
        .onChange(of: runner.activity) { localPackages = BackupDelivery.localPackages() }
        .confirmationDialog("停止备份？", isPresented: $showStopConfirm, titleVisibility: .visible) {
            Button("停止", role: .destructive) { runner.stop() }
        } message: {
            Text("已完成的部分会被丢弃，不会生成备份包。")
        }
        .sheet(item: Binding(get: { shareURL.map(BackupIdentifiedURL.init) }, set: { shareURL = $0?.url })) { item in
            BackupShareSheet(url: item.url) { shareURL = nil }
        }
        .sheet(item: Binding(get: { saveURL.map(BackupIdentifiedURL.init) }, set: { saveURL = $0?.url })) { item in
            BackupDocumentExportPicker(url: item.url) { saveURL = nil }
        }
    }

    private func binding(for category: BackupCategory) -> Binding<Bool> {
        Binding(
            get: { selected.contains(category) },
            set: { on in
                if on { selected.insert(category) } else { selected.remove(category) }
                storedCategories = selected.map(\.rawValue).sorted().joined(separator: ",")
            })
    }

    private func loadSelection() {
        guard !storedCategories.isEmpty else { return }
        let parsed = storedCategories.split(separator: ",").compactMap { BackupCategory(rawValue: String($0)) }
        selected = Set(parsed).intersection(BackupCategory.backupable)
    }

    private func startExport() {
        let request = BackupRunController.ExportRequest(
            categories: selected, passphrase: encrypt ? passphrase : nil, maxFileBytes: nil,
            mountedFolderIds: Array(mountedTargets))
        if runner.startExport(request) {
            passphrase = ""
            confirmPassphrase = ""
        }
    }

    static func fileSubtitle(_ url: URL) -> String {
        let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
        let size = ByteCountFormatter.string(fromByteCount: Int64(values?.fileSize ?? 0), countStyle: .file)
        let date = values?.contentModificationDate.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? ""
        return "\(date) · \(size)"
    }
}

struct BackupIdentifiedURL: Identifiable {
    let url: URL
    var id: String { url.path }
}

struct BackupHistoryRow: View {
    let record: BackupHistory.Record

    var body: some View {
        HStack(spacing: LeoTheme.Spacing.sm) {
            Image(systemName: icon)
                .foregroundStyle(color)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(record.kind == .export ? String(localized: "备份") : String(localized: "恢复"))
                    .font(.subheadline.weight(.medium))
                Text("\(record.startedAt.formatted(date: .abbreviated, time: .shortened)) · \(Self.statusText(record.status))")
                    .font(.caption)
                    .foregroundStyle(LeoTheme.ColorToken.secondaryText)
            }
            Spacer()
            if record.kind == .export, record.totalBytes > 0 {
                Text(ByteCountFormatter.string(fromByteCount: record.totalBytes, countStyle: .file))
                    .font(.caption)
                    .foregroundStyle(LeoTheme.ColorToken.secondaryText)
            }
        }
    }

    private var icon: String {
        switch record.status {
        case .running: return "hourglass"
        case .succeeded: return "checkmark.circle.fill"
        case .completedWithIssues: return "exclamationmark.triangle.fill"
        case .failed: return "xmark.octagon.fill"
        case .cancelled: return "stop.circle"
        }
    }

    private var color: Color {
        switch record.status {
        case .running: return LeoTheme.ColorToken.accent
        case .succeeded: return LeoTheme.ColorToken.success
        case .completedWithIssues: return LeoTheme.ColorToken.warning
        case .failed: return LeoTheme.ColorToken.destructive
        case .cancelled: return LeoTheme.ColorToken.secondaryText
        }
    }

    static func statusText(_ s: BackupHistory.Status) -> String {
        switch s {
        case .running: return String(localized: "进行中")
        case .succeeded: return String(localized: "成功")
        case .completedWithIssues: return String(localized: "完成但有问题")
        case .failed: return String(localized: "失败")
        case .cancelled: return String(localized: "已取消")
        }
    }
}
