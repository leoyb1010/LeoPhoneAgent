import SwiftUI
import Speech

struct SystemSpeechResourcesView: View {
    @AppStorage(SystemSpeechPreferences.autoNetworkAllowedKey) private var autoNetworkAllowed = false
    @State private var localeID = Locale.current.identifier
    @State private var locales: [String] = []
    @State private var availability: SystemSpeechAvailability?
    @State private var progress = 0.0
    @State private var installation: Task<Void, Never>?
    @State private var message: String?
    @State private var reserved = false

    var body: some View {
        List {
            Section("识别政策") {
                Toggle("自动模式允许联网识别", isOn: $autoNetworkAllowed)
                Text("关闭时，自动模式只使用本机可用资源。明确选择离线时始终禁止联网；允许联网也会优先使用已安装的本机引擎。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("本机语言资源") {
                if #available(iOS 26.0, *) {
                    Picker("语言", selection: $localeID) {
                        ForEach(Array(Set(locales + [localeID])).sorted(), id: \.self) { identifier in
                            Text(Locale.current.localizedString(forIdentifier: identifier) ?? identifier).tag(identifier)
                        }
                    }.disabled(installation != nil)
                    LabeledContent("资源状态", value: statusLabel)
                    if let resolved = availability?.resolvedLocale, resolved != localeID {
                        LabeledContent("系统匹配语言", value: resolved)
                    }
                    if installation != nil {
                        ProgressView(value: min(1, max(0, progress)))
                        Button("请求取消下载") { installation?.cancel() }
                    } else {
                        Button("下载并保留本机语言资源") { install() }
                            .disabled(availability == nil || availability?.state == .installed || availability?.state == .unsupported || availability?.state == .downloading)
                        if reserved {
                            Button("释放本 App 的语言保留") {
                                Task {
                                    _ = await AssetInventory.release(reservedLocale: Locale(identifier: availability?.resolvedLocale ?? localeID))
                                    await refresh()
                                }
                            }
                        }
                    }
                    Button("刷新资源状态") { Task { await refresh() } }
                } else {
                    Text("系统转写资源管理需要 iOS 26 或更新版本。旧系统继续使用可用的系统识别接口，并遵守离线限制。")
                }
                Text("下载大小、存储和最终资源清理由 Apple 管理。释放保留不等于立即删除系统资源。离开此页会请求取消本页下载；再次进入后以系统状态为准。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let message { Section { Text(message).font(.callout) } }
        }
        .navigationTitle("系统语音与语言资源")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if #available(iOS 26.0, *) { locales = await SpeechTranscriber.supportedLocales.map(\.identifier) }
            await refresh()
        }
        .onChange(of: localeID) { _, _ in Task { await refresh() } }
        .onDisappear { installation?.cancel() }
    }

    private var statusLabel: String {
        switch availability?.state {
        case .installed: return "已安装，可本机转写"
        case .notInstalled: return "支持，需要下载"
        case .downloading: return "系统正在准备资源"
        case .unsupported: return "此设备或语言暂不支持"
        case .unknown: return "状态未知，请刷新"
        default: return "正在检查"
        }
    }

    @MainActor private func refresh() async {
        guard #available(iOS 26.0, *) else { return }
        let requested = localeID
        let result = await AppleSpeechAnalyzer.availability(locale: Locale(identifier: requested))
        let reservations = await AssetInventory.reservedLocales
        guard requested == localeID else { return }
        availability = result
        reserved = reservations.contains { $0.identifier == result.resolvedLocale }
    }

    @MainActor private func install() {
        guard installation == nil, #available(iOS 26.0, *) else { return }
        message = nil; progress = 0
        let requested = localeID
        installation = Task { @MainActor in
            defer { installation = nil }
            do {
                try await AppleSpeechAnalyzer.install(locale: Locale(identifier: requested), userInitiated: true) { progress = $0 }
                message = "系统已确认语言资源安装完成。"
            } catch is CancellationError {
                message = "已请求取消。系统可能仍在处理，请刷新查看实际状态。"
            } catch {
                message = error.localizedDescription
            }
            await refresh()
        }
    }
}
