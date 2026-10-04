import CloudKit
import SwiftUI

/// V2 iCloud Sync settings page. Replaces the v1 CloudSyncSettingsView
/// when v2 is enabled. Drives:
/// - Master enable/disable
/// - This device's friendly name
/// - Per-category upload toggles (Chat / SessionFiles / Skills / Providers / Env)
/// - Per-file size cap
/// - Discovered remote devices (read from sync_devices table populated
///   by mergeDevice hydrator on inbound SyncDeviceV2 records)
struct CloudSyncSettingsV2View: View {
    @ObservedObject private var gatewayStore = GatewayHostStore.shared
    @State private var tailnetEnabled = false
    @State private var replicaHostID = ""
    @State private var replicaStatus = ""
    @State private var deliveryFailures: [String] = []
    @State private var v2Enabled: Bool = false
    @State private var deviceName: String = ""
    @State private var deviceNameDraft: String = ""
    @State private var showDeviceNameEditor: Bool = false
    @State private var categoriesEnabled: [UploadPolicy.Category: Bool] = [:]
    @State private var maxFileSizeMB: Int = 1
    @State private var maxArtifactSizeMB: Int = 25
    @State private var remoteDevices: [SyncDevice] = []
    @State private var statusText: String = ""
    /// [T-ck15-explain] 打开页面时查一次 iCloud 通不通;不通就把原因摆出来(以前照样显示「运行中」,设备列表空着,看不出为什么)。
    @State private var cloudProblem: String?
    @State private var checkingCloud = false
    @State private var health = SyncTransportHealth()
    @State private var pendingCount = 0
    @State private var categoryPausedCount = 0
    @State private var retryAt: Date?
    // [T-ios-migration-timer-sessionlist-uaf-crash] 5s refresh cadence is driven by
    // a `.task` async loop (see refreshLoop), NOT a process-lived
    // `Timer.publish(every:5).autoconnect()` + `.onReceive`. A graph-bound Combine
    // publisher's sink is a SwiftUI attribute AttributeGraph re-creates on every body
    // transaction; a tick delivered while it is torn down/rebuilt releases the dangling
    // `SubscriptionView` sink closure → use-after-free (CODESIGNING Invalid Page,
    // TestFlight crash1/crash2, 1.10(43)). Same mechanism 665c15fb fixed in ContentView;
    // that commit converted only the ContentView binding point, leaving this view and
    // SyncMigrationDetailView on the crashing pattern.
    private static let refreshIntervalSeconds: UInt64 = 5

    var body: some View {
        Form {
            Section {
                Toggle(isOn: Binding(
                    get: { v2Enabled },
                    set: { newValue in
                        if #available(iOS 17.0, *) { SyncV2Bootstrap.setEnabled(newValue) }
                        v2Enabled = newValue
                    }
                )) {
                    Text("Enable iCloud Sync")
                }
                if !statusText.isEmpty {
                    NavigationLink {
                        SyncMigrationDetailView()
                    } label: {
                        LabeledContent("Status") {
                            Text(statusText).foregroundStyle(.secondary)
                        }
                    }
                }
            }

            Section {
                Picker("同步副本 Mac", selection: Binding(
                    get: { replicaHostID },
                    set: { id in
                        replicaHostID = id
                        SyncV2Bootstrap.setTailnetEnabled(tailnetEnabled, hostID: id)
                    }
                )) {
                    Text("请选择设备").tag("")
                    ForEach(gatewayStore.activeHosts) { host in Text(host.name).tag(host.id) }
                }
                Toggle("启用 Tailscale 同步副本", isOn: Binding(
                    get: { tailnetEnabled },
                    set: { enabled in
                        tailnetEnabled = enabled
                        SyncV2Bootstrap.setTailnetEnabled(enabled, hostID: replicaHostID)
                    }
                ))
                .disabled(replicaHostID.isEmpty)
                if !replicaStatus.isEmpty { LabeledContent("Status", value: replicaStatus) }
                if tailnetEnabled {
                    Button("立即同步副本") {
                        Task {
                            await SyncV2Bootstrap.startIfEnabled()
                            await SyncCore.shared.sendNow(trigger: .manual)
                            await SyncCore.shared.fetchNow(trigger: .manual)
                            await refresh()
                        }
                    }
                }
            } header: {
                Text("Tailscale 同步副本")
            } footer: {
                Text("选择已配对并授权同步的常在线 Mac。首次启用会发送已允许同步的数据；iCloud 开关独立生效。关闭后保留待传数据。")
            }

            if !deliveryFailures.isEmpty {
                Section("待处理同步问题") {
                    ForEach(deliveryFailures, id: \.self) { Text($0).font(.caption).textSelection(.enabled) }
                }
            }

            if v2Enabled || tailnetEnabled {
                Section {
                    Button {
                        deviceNameDraft = deviceName
                        showDeviceNameEditor = true
                    } label: {
                        LabeledContent("Name") {
                            HStack(spacing: 6) {
                                Text(deviceName).foregroundStyle(.secondary)
                                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                } header: {
                    Text("Upload (This Device)")
                } footer: {
                    Text("This device name is broadcast to your other devices in the iCloud Sync zone.")
                        .font(.caption)
                }

                Section {
                    ForEach(UploadPolicy.Category.allCases, id: \.self) { cat in
                        Toggle(isOn: Binding(
                            get: { categoriesEnabled[cat] ?? true },
                            set: { newVal in
                                UploadPolicy.setEnabled(cat, newVal)
                                categoriesEnabled[cat] = newVal
                                Task {
                                    if newVal {
                                        await ChatStoreSyncHydrators.stageUploadCategory(cat)
                                    }
                                    await markDeviceDirty()
                                }
                            }
                        )) {
                            HStack(spacing: 12) {
                                Image(systemName: iconName(for: cat))
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(.white)
                                    .frame(width: 28, height: 28)
                                    .background(iconColor(for: cat), in: RoundedRectangle(cornerRadius: 7))
                                Text(LocalizedStringKey(cat.displayName))
                            }
                        }
                    }
                    if categoriesEnabled[.sessionFiles] ?? true {
                        Picker(selection: $maxFileSizeMB) {
                            Text("256 KB").tag(0)
                            Text("1 MB").tag(1)
                            Text("4 MB").tag(4)
                            Text("16 MB").tag(16)
                            Text("64 MB").tag(64)
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "doc.zipper")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(.white)
                                    .frame(width: 28, height: 28)
                                    .background(Color.gray, in: RoundedRectangle(cornerRadius: 7))
                                Text("Max Per-File Size")
                            }
                        }
                        .pickerStyle(.menu)
                        .onChange(of: maxFileSizeMB) { newValue in
                            UploadPolicy.maxFileSizeBytes = newValue == 0 ? 256 * 1024 : newValue * 1024 * 1024
                        }
                    }
                    if categoriesEnabled[.artifacts] ?? false {
                        Picker(selection: $maxArtifactSizeMB) {
                            Text("1 MB").tag(1)
                            Text("5 MB").tag(5)
                            Text("25 MB").tag(25)
                            Text("100 MB").tag(100)
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "shippingbox.fill")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(.white)
                                    .frame(width: 28, height: 28)
                                    .background(Color.purple, in: RoundedRectangle(cornerRadius: 7))
                                Text("Max Artifact Version Size")
                            }
                        }
                        .pickerStyle(.menu)
                        .onChange(of: maxArtifactSizeMB) { newValue in
                            UploadPolicy.maxArtifactSizeBytes = newValue * 1024 * 1024
                        }
                    }
                } footer: {
                    Text("选择此设备上传到已启用目的地的数据。关闭类别会保留本机待传改动和删除，重新开启后继续上传；已上传的数据不会因此删除。")
                        .font(.caption)
                }

                if v2Enabled, let cloudProblem {
                    Section {
                        Text(health.state == .degraded ? String(localized: "Some sync operations are waiting; other data can continue.") : String(localized: "Sync needs attention. Local changes are kept on this device."))
                            .foregroundStyle(.secondary)
                        DisclosureGroup("Sync diagnostics") {
                            Text(cloudProblem).font(.caption).textSelection(.enabled)
                        }
                        Button(checkingCloud ? "正在检查…" : "重新检查") {
                            Task { await checkCloud() }
                        }
                        .disabled(checkingCloud)
                    } header: {
                        Text("iCloud 连接")
                    }
                }

                Section("Sync activity") {
                    LabeledContent("Pending upload", value: String(pendingCount))
                    if categoryPausedCount > 0 {
                        LabeledContent("Paused by category", value: String(categoryPausedCount))
                    }
                    LabeledContent("Last successful upload", value: health.lastSendAt.map(relativeDate) ?? "—")
                    LabeledContent("Last successful download", value: health.lastFetchAt.map(relativeDate) ?? "—")
                    if let retryAt, retryAt > Date() {
                        LabeledContent("Retry after", value: retryAt.formatted(date: .omitted, time: .standard))
                    }
                }

                Section {
                    if remoteDevices.isEmpty {
                        Text("No other devices found yet. Devices appear here once they enable iCloud Sync.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 4)
                    } else {
                        ForEach(remoteDevices, id: \.id) { d in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(d.deviceName).font(.body)
                                    Spacer()
                                    Text(relativeDate(d.lastSeen)).font(.caption2).foregroundStyle(.secondary)
                                }
                                if !d.uploadTypes.isEmpty {
                                    Text(uploadTypesSummary(d.uploadTypes))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                }
                            }
                        }
                    }
                } header: {
                    Text("Other Devices")
                } footer: {
                    Text("Devices that are signed in to the same iCloud account and have sync enabled. Last seen reflects the most recent push from that device.")
                        .font(.caption)
                }
            }
        }
        .navigationTitle("设备同步")
#if !os(macOS)
        .navigationBarTitleDisplayMode(.inline)
#endif
        // [T-ios-migration-timer-sessionlist-uaf-crash] `.task` async refresh loop
        // replaces the old `.task { await refresh() }` + `.onReceive(timer)` pair, so
        // there is no graph-bound Combine sink to be released mid-transaction (the crash
        // that pattern caused — see refreshIntervalSeconds). SwiftUI cancels this Task
        // on teardown.
        .task { await refreshLoop() }
        .alert("Device Name", isPresented: $showDeviceNameEditor) {
            TextField("Device name", text: $deviceNameDraft)
            Button("Save") {
                let trimmed = deviceNameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.isEmpty {
                    UploadPolicy.customDeviceName = nil
                    deviceName = DeviceIdentity.deviceName
                } else {
                    UploadPolicy.customDeviceName = trimmed
                    deviceName = trimmed
                }
                Task { await markDeviceDirty() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Friendly name shown to your other LeoPhoneAgent devices.")
        }
    }

    /// [T-ios-migration-timer-sessionlist-uaf-crash] Self-cancelling 5s refresh loop
    /// driven by `.task`, replacing the graph-bound `Timer.publish().autoconnect()` +
    /// `.onReceive` that AttributeGraph could tear down mid-transaction (UAF). SwiftUI
    /// cancels this Task on teardown, so no dangling subscription survives. Refreshes
    /// once immediately (mirroring the old `.task { await refresh() }`) then every 5s;
    /// skips the refresh while backgrounded and resumes on the next foreground tick.
    @MainActor
    private func refreshLoop() async {
        await refresh()
        await checkCloud()
        while !Task.isCancelled {
            do {
                try await Task.sleep(nanoseconds: Self.refreshIntervalSeconds * 1_000_000_000)
            } catch {
                return  // cancelled during sleep
            }
            let backgrounded: Bool
            if #available(iOS 17.0, *) {
                backgrounded = SyncCore.shared.isAppInBackground
            } else {
                backgrounded = false
            }
            if !backgrounded {
                await refresh()
            }
        }
    }

    @MainActor
    private func refresh() async {
        if #available(iOS 17.0, *) {
            v2Enabled = SyncV2Bootstrap.isEnabled
        }
        tailnetEnabled = SyncV2Bootstrap.isTailnetEnabled
        replicaHostID = SyncV2Bootstrap.selectedReplicaHostID
        replicaStatus = SyncV2Bootstrap.tailnetStatus
        if #available(iOS 17.0, *) {
            if let replica = SyncCore.shared.transports.first(where: { $0.name.hasPrefix("tailnet:") }) {
                replicaStatus = "\(SyncV2Bootstrap.tailnetStatus) · \(replica.health.state.localizedLabel)"
            }
            deliveryFailures = ((try? await ChatStore.shared.syncDeliveryFailures()) ?? []).map {
                "\($0.destination) · \($0.recordType): \($0.reason)"
            }
        }
        deviceName = UploadPolicy.customDeviceName ?? DeviceIdentity.deviceName
        for cat in UploadPolicy.Category.allCases {
            categoriesEnabled[cat] = UploadPolicy.isEnabled(cat)
        }
        let bytes = UploadPolicy.maxFileSizeBytes
        maxFileSizeMB = bytes < 1024 * 1024 ? 0 : Int((Double(bytes) / (1024 * 1024)).rounded())
        maxArtifactSizeMB = max(1, UploadPolicy.maxArtifactSizeBytes / (1024 * 1024))
        let me = DeviceIdentity.deviceId
        let all = await ChatStore.shared.listSyncDevices()
        remoteDevices = all.filter { $0.id != me }.sorted { $0.lastSeen > $1.lastSeen }
        if #available(iOS 17.0, *), v2Enabled || tailnetEnabled {
            health = v2Enabled ? SyncCore.shared.cloudHealth : (SyncCore.shared.transports.first { $0.name.hasPrefix("tailnet:") }?.health ?? SyncTransportHealth())
            let counts = await ChatStore.shared.countDirtyRecords()
            categoryPausedCount = counts.byType.filter { !UploadPolicy.allowsRecordType($0.key) }.values.reduce(0, +)
            pendingCount = counts.total - categoryPausedCount
            retryAt = SyncCore.shared.nextEarliestSendAt
            let issues = health.issues.values.sorted { $0.operation < $1.operation }
            if let first = issues.first {
                // Lead with what it means and what to do; keep the codes for support.
                var lines = issues.map { "\($0.operation): \($0.diagnostic)" }
                if first.domain == CKErrorDomain,
                   let headline = cloudKitProblemDescription(NSError(domain: first.domain, code: first.code))
                    .components(separatedBy: "\n详情").first {
                    lines.insert(headline, at: 0)
                }
                cloudProblem = lines.joined(separator: "\n")
            } else {
                cloudProblem = nil
            }
            statusText = health.state.localizedLabel
            if SyncCore.shared.pausedUntil != nil { statusText = String(localized: "Paused") }
        } else {
            statusText = String(localized: "Off")
        }
    }

    /// [T-ck15-explain] 一次最便宜的只读请求(列出本 App 的 iCloud 区域),看 iCloud 通不通。
    @MainActor
    private func checkCloud() async {
        guard #available(iOS 17.0, *), v2Enabled, !checkingCloud else { return }
        checkingCloud = true
        defer { checkingCloud = false }
        var problem: String?
        do { try await SyncCore.shared.checkCloudConnection() }
        catch { problem = cloudKitProblemDescription(error) }
        await refresh()
        // The explicit check result wins over the aggregated health text.
        if let problem { cloudProblem = problem }
    }

    /// Whenever the user changes their upload preferences or device
    /// name, re-broadcast our SyncDeviceV2 record so peers learn about
    /// the new state.
    private func markDeviceDirty() async {
        await ChatStore.shared.markDirty(
            recordType: "SyncDeviceV2",
            recordId: DeviceIdentity.deviceId
        )
        if #available(iOS 17.0, *) {
            SyncCore.shared.scheduleSend(delay: 1)
        }
    }

    private func iconName(for cat: UploadPolicy.Category) -> String {
        switch cat {
        case .chatSessions: return "bubble.left.and.bubble.right.fill"
        case .sessionFiles: return "doc.fill"
        case .artifacts:    return "shippingbox.fill"
        case .skills:       return "puzzlepiece.fill"
        case .providers:    return "link"
        case .envVars:      return "rectangle.stack.fill"
        case .memory:       return "brain.head.profile"
        }
    }

    private func iconColor(for cat: UploadPolicy.Category) -> Color {
        switch cat {
        case .chatSessions: return .blue
        case .sessionFiles: return .indigo
        case .artifacts:    return .purple
        case .skills:       return .orange
        case .providers:    return .teal
        case .envVars:      return .green
        case .memory:       return .pink
        }
    }

    private func uploadTypesSummary(_ csv: [String]) -> String {
        guard !csv.isEmpty else { return String(localized: "No categories enabled") }
        return csv.joined(separator: " · ")
    }

    private func relativeDate(_ d: Date) -> String {
        let secs = Int(Date().timeIntervalSince(d))
        if secs < 60 { return String(localized: "Just now") }
        let mins = secs / 60
        if mins < 60 { return String(localized: "\(mins) min ago") }
        let hrs = mins / 60
        if hrs < 24 { return String(localized: "\(hrs) hr ago") }
        let days = hrs / 24
        return String(localized: "\(days) day ago")
    }
}
