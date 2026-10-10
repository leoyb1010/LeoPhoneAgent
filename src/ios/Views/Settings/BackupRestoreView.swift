import SwiftUI
import UniformTypeIdentifiers

/// 从备份包恢复：选文件 → 预览内容（无需密码）→ 输入密码并检查（校验完整性、
/// 解密、对比本地数据）→ 选择类别并确认 → 恢复 → 结果。
struct BackupRestoreView: View {
    let initialPackage: URL?
    let ownsInitialPackage: Bool
    var onClose: (() -> Void)?

    @ObservedObject private var runner = BackupRunController.shared
    @Environment(\.dismiss) private var dismiss

    private enum Phase {
        case pick
        case peeked(BackupPackageReader.Peek)
        case checking
        case ready(BackupImporter.Prepared, BackupImporter.Plan)
        case running(BackupImporter.Prepared)
        case done(BackupImporter.Report)
    }

    @State private var phase: Phase = .pick
    @State private var packageURL: URL?
    @State private var ownsPackage = false
    @State private var passphrase = ""
    @State private var selected: Set<BackupCategory> = []
    @State private var error: String?
    @State private var showPicker = false
    @State private var showConfirm = false
    @State private var importer = BackupImporter(target: LiveBackupStores(), workRoot: BackupDelivery.workRoot,
                                                 journalBase: BackupDelivery.journalBase)

    init(initialPackage: URL?, ownsInitialPackage: Bool, onClose: (() -> Void)? = nil) {
        self.initialPackage = initialPackage
        self.ownsInitialPackage = ownsInitialPackage
        self.onClose = onClose
    }

    var body: some View {
        List {
            if let error {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(LeoTheme.ColorToken.destructive)
                        .font(.subheadline)
                }
            }
            switch phase {
            case .pick: pickSection
            case .peeked(let peek): peekSections(peek)
            case .checking:
                Section {
                    HStack(spacing: LeoTheme.Spacing.sm) {
                        ProgressView()
                        Text("正在校验并解包…").foregroundStyle(LeoTheme.ColorToken.secondaryText)
                    }
                } footer: {
                    Text("会先校验每个文件的完整性，再解密。这一步不会修改任何数据。")
                }
            case .ready(let prepared, let plan): readySections(prepared, plan)
            case .running:
                Section {
                    HStack(spacing: LeoTheme.Spacing.sm) {
                        ProgressView()
                        Text(runner.statusText.isEmpty ? String(localized: "正在恢复…") : runner.statusText)
                            .font(.subheadline).foregroundStyle(LeoTheme.ColorToken.secondaryText).lineLimit(2)
                    }
                    Button("停止", role: .destructive) { runner.stop() }
                } footer: {
                    Text("停止后，正在恢复的类别会撤销，已完成的类别会保留。")
                }
            case .done(let report): doneSections(report)
            }
        }
        .navigationTitle("恢复备份")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let onClose {
                ToolbarItem(placement: .cancellationAction) {
                    Button(isRunning ? String(localized: "后台继续") : String(localized: "关闭")) {
                        cleanup()
                        onClose()
                    }
                }
            }
        }
        .fileImporter(isPresented: $showPicker, allowedContentTypes: [BackupDelivery.contentType, .data]) { result in
            if case .success(let url) = result { adopt(staging: url) }
        }
        .confirmationDialog("开始恢复？", isPresented: $showConfirm, titleVisibility: .visible) {
            Button("恢复所选内容") { startRestore() }
        } message: {
            Text("恢复会合并到现有数据，不会删除任何内容；本地更新的内容会保留。")
        }
        .onAppear {
            if packageURL == nil, let initialPackage {
                packageURL = initialPackage
                ownsPackage = ownsInitialPackage
                peek()
            }
        }
        .onDisappear { if !isRunning { cleanup() } }
    }

    private var isRunning: Bool {
        if case .running = phase { return true }
        return false
    }

    // MARK: - Sections

    private var pickSection: some View {
        Section {
            Button { showPicker = true } label: { Label("选择备份文件…", systemImage: "doc.badge.arrow.up") }
        } footer: {
            Text("选择一个 .minisbak 备份包（可来自「文件」App、iCloud 云盘或其他设备）。")
        }
    }

    @ViewBuilder
    private func peekSections(_ peek: BackupPackageReader.Peek) -> some View {
        let m = peek.manifest
        Section("备份信息") {
            row("来源设备", m.deviceName)
            row("创建时间", m.createdAt.formatted(date: .abbreviated, time: .shortened))
            row("App 版本", "\(m.app.platform) \(m.app.version) (\(m.app.build))")
            row("大小", ByteCountFormatter.string(fromByteCount: peek.fileSize, countStyle: .file))
            row("加密", m.encryption == nil ? String(localized: "未加密") : String(localized: "已加密"))
        }
        Section("包含内容") {
            ForEach(m.knownCategories, id: \.self) { c in
                if let stat = m.categories[c.rawValue] {
                    row(c.displayName, Self.statText(c, stat), systemImage: c.systemImage)
                }
            }
        }
        Section {
            if m.encryption != nil {
                SecureField("备份密码", text: $passphrase)
                    .textContentType(.password)
            }
            Button {
                check()
            } label: {
                Label("检查备份", systemImage: "checkmark.shield")
            }
            .disabled(m.encryption != nil && passphrase.isEmpty)
        } footer: {
            Text("检查会校验完整性并对比本地数据，告诉你哪些内容会新增、更新或保留，不会修改任何数据。")
        }
    }

    @ViewBuilder
    private func readySections(_ prepared: BackupImporter.Prepared, _ plan: BackupImporter.Plan) -> some View {
        Section {
            ForEach(plan.categories) { cp in
                Toggle(isOn: Binding(
                    get: { selected.contains(cp.category) },
                    set: { on in if on { selected.insert(cp.category) } else { selected.remove(cp.category) } }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Label(cp.category.displayName, systemImage: cp.category.systemImage)
                        Text(Self.planText(cp)).font(.caption).foregroundStyle(LeoTheme.ColorToken.secondaryText)
                        ForEach(cp.notes, id: \.self) { note in
                            Text(note).font(.caption).foregroundStyle(LeoTheme.ColorToken.warning)
                        }
                    }
                }
            }
        } header: {
            Text("选择要恢复的内容")
        } footer: {
            if prepared.wasEncrypted {
                Text("已解密并通过完整性校验（\(prepared.integrityChecked) 个文件）。")
            } else {
                Text("已确认 \(prepared.integrityChecked) 个文件未损坏。未加密的备份无法验证来源，任何人都能制作一份。")
            }
        }
        if !prepared.wasEncrypted {
            Section {
                Label("这份备份没有加密，无法确认它来自你自己的设备。恢复会把包里的 MCP 服务器、技能、模型服务商和环境变量并入本机，模型之后会使用它们。只恢复你信任来源的备份；MCP 服务器会先保持停用，请逐个检查后再启用。",
                      systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(LeoTheme.ColorToken.warning)
            }
        }
        if !plan.warnings.isEmpty {
            Section("注意") {
                ForEach(plan.warnings, id: \.self) { w in
                    Label(w, systemImage: "info.circle").font(.footnote)
                }
            }
        }
        Section {
            Button {
                showConfirm = true
            } label: {
                Label("开始恢复", systemImage: "arrow.counterclockwise.circle")
            }
            .disabled(selected.isEmpty || runner.isRunning
                      || (selected.contains(.chats) && plan.runningSessions > 0))
            if plan.runningSessions > 0, selected.contains(.chats) {
                Text("有 \(plan.runningSessions) 个相关对话正在运行，请等它们结束后再恢复对话。")
                    .font(.footnote).foregroundStyle(LeoTheme.ColorToken.warning)
            }
            if runner.isRunning {
                Text("已有备份或恢复在进行中").font(.footnote).foregroundStyle(LeoTheme.ColorToken.secondaryText)
            }
        }
    }

    @ViewBuilder
    private func doneSections(_ report: BackupImporter.Report) -> some View {
        Section {
            Label(report.cancelled ? String(localized: "恢复已停止")
                  : report.hasFailures ? String(localized: "部分内容恢复失败，已撤销失败的类别")
                  : String(localized: "恢复完成"),
                  systemImage: report.hasFailures || report.cancelled ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .foregroundStyle(report.hasFailures || report.cancelled ? LeoTheme.ColorToken.warning : LeoTheme.ColorToken.success)
        }
        Section("结果") {
            ForEach(report.categories) { c in
                VStack(alignment: .leading, spacing: 2) {
                    Label(c.category.displayName, systemImage: c.category.systemImage)
                    Text(c.summary).font(.caption)
                        .foregroundStyle(c.failed == nil ? LeoTheme.ColorToken.secondaryText : LeoTheme.ColorToken.destructive)
                    ForEach(c.needsAttention, id: \.self) { n in
                        Text(n).font(.caption).foregroundStyle(LeoTheme.ColorToken.warning)
                    }
                    if c.missingBlobs > 0 {
                        Text("备份包中缺少 \(c.missingBlobs) 个文件").font(.caption).foregroundStyle(LeoTheme.ColorToken.warning)
                    }
                    if c.sizeSkippedInPackage + c.notDownloadedInPackage > 0 {
                        Text("备份时未包含 \(c.sizeSkippedInPackage + c.notDownloadedInPackage) 个文件").font(.caption)
                            .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                    }
                }
            }
        }
        if !report.warnings.isEmpty {
            Section("注意") {
                ForEach(report.warnings, id: \.self) { Text($0).font(.footnote) }
            }
        }
        Section {
            Button("完成") {
                cleanup()
                if let onClose { onClose() } else { dismiss() }
            }
        } footer: {
            Text("恢复的数据会在下次 iCloud 同步时上传到你的其他设备。")
        }
    }

    private func row(_ title: String, _ value: String, systemImage: String? = nil) -> some View {
        HStack {
            if let systemImage { Label(title, systemImage: systemImage) } else { Text(title) }
            Spacer()
            Text(value).foregroundStyle(LeoTheme.ColorToken.secondaryText).multilineTextAlignment(.trailing)
        }
    }

    // MARK: - Actions

    private func adopt(staging url: URL) {
        cleanup()
        error = nil
        phase = .checking
        // Copying a multi-GB package (coordinated, may download first) must
        // not run on the main thread.
        Task {
            let staged = await Task.detached(priority: .userInitiated) { BackupOpenRouter.stage(url) }.value
            guard let staged else {
                error = String(localized: "无法读取这个备份文件")
                phase = .pick
                return
            }
            packageURL = staged
            ownsPackage = true
            peek()
        }
    }

    private func peek() {
        guard let packageURL else { return }
        error = nil
        // Reading the zip directory of a large package is file I/O: off main.
        Task {
            let result = await Task.detached(priority: .userInitiated) {
                Result { try BackupPackageReader.peek(at: packageURL) }
            }.value
            switch result {
            case .success(let peeked): phase = .peeked(peeked)
            case .failure(let failure):
                error = failure.localizedDescription
                phase = .pick
            }
        }
    }

    private func check() {
        guard let packageURL else { return }
        let importer = importer
        let pass = passphrase
        error = nil
        phase = .checking
        Task {
            do {
                let prepared = try await importer.open(packageURL: packageURL, passphrase: pass.isEmpty ? nil : pass)
                let plan = await importer.analyze(prepared)
                var initial = Set(plan.categories.map(\.category))
                if !prepared.wasEncrypted {
                    // Unverifiable origin: the categories the model acts on are
                    // opt-in, not default.
                    initial.subtract([.mcpServers, .skills, .providers, .environmentVariables])
                }
                selected = initial
                phase = .ready(prepared, plan)
            } catch {
                self.error = error.localizedDescription
                peek()
            }
        }
    }

    private func startRestore() {
        guard case .ready(let prepared, _) = phase else { return }
        let started = runner.startRestore(importer: importer, prepared: prepared, categories: selected) { result in
            switch result {
            case .success(let report):
                importer.discard(prepared)
                phase = .done(report)
            case .failure(let err):
                error = err.localizedDescription
                Task {
                    let plan = await importer.analyze(prepared)
                    phase = .ready(prepared, plan)
                }
            }
        }
        if started { phase = .running(prepared) } else { error = String(localized: "已有备份或恢复在进行中") }
    }

    private func cleanup() {
        switch phase {
        case .ready(let prepared, _): importer.discard(prepared)
        case .done: break
        default: break
        }
        if ownsPackage, let packageURL, !isRunning {
            try? FileManager.default.removeItem(at: packageURL)
            self.packageURL = nil
        }
    }

    // MARK: - Text

    static func statText(_ c: BackupCategory, _ s: BackupManifest.CategoryStat) -> String {
        switch c {
        case .chats: return String(localized: "\(s.messages ?? s.entries) 条消息 · \(s.files ?? 0) 个文件")
        case .skills: return String(localized: "\(s.entries) 个")
        case .providers:
            let creds = s.includesCredentials == true ? String(localized: "含密钥") : String(localized: "不含密钥")
            return String(localized: "\(s.entries) 个 · \(creds)")
        case .sharedFiles: return String(localized: "\(s.entries) 个文件")
        default: return String(localized: "\(s.entries) 项")
        }
    }

    static func planText(_ p: BackupImporter.CategoryPlan) -> String {
        var parts: [String] = []
        if p.newItems > 0 { parts.append(String(localized: "新增 \(p.newItems)")) }
        if p.newerInBackup > 0 { parts.append(String(localized: "更新 \(p.newerInBackup)")) }
        if p.localKept > 0 { parts.append(String(localized: "保留本地 \(p.localKept)")) }
        if p.identical > 0 { parts.append(String(localized: "相同 \(p.identical)")) }
        return parts.isEmpty ? String(localized: "无需变更") : parts.joined(separator: " · ")
    }
}
