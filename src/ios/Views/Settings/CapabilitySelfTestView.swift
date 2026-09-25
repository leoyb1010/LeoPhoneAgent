import SwiftUI

/// [T-selftest-1.41] 能力自检。
///
/// 每项原生能力按 Agent 的同一条路跑一遍:iSH 里执行 `apple-*` 命令 → 原生分发 →
/// 授权闸 → 系统框架,只用只读子命令(信息、状态、列表)。再加上模型供应商连通(拉模型
/// 列表,不花 token)、已配对 Mac 可达、Jev 连通。结果分四种:通过 / 未授权(系统权限
/// 或 App 内权限没给)/ 失败 / 跳过,带耗时。
///
/// 结果同时写到 Library/Application Support/Diagnostics/selftest.json,
/// 可以 `xcrun devicectl device copy from ...` 取回;深链 leophoneagent://settings/selftest
/// 打开时自动开跑。
@MainActor
final class CapabilitySelfTest: ObservableObject {
    static let shared = CapabilitySelfTest()

    enum Status: String, Codable {
        case pending, running, passed, unauthorized, failed, skipped
    }

    struct Check: Identifiable, Codable {
        let id: String
        let group: String
        let title: String
        let command: String?
        var status: Status = .pending
        var ms: Double = 0
        var detail: String = ""
    }

    @Published private(set) var checks: [Check] = []
    @Published private(set) var isRunning = false
    @Published private(set) var finishedAt: Date?
    /// 深链打开时置位,页面出现时消费。
    var autoRunRequested = false
    /// 同时对每个模型供应商真发一句话(走和聊天完全相同的请求路径,带一个工具)。
    /// 每项只花几十个 token;默认关,页面开关或深链 `?chat=1` 打开。
    @Published var includeChat = false
    /// chat 检查项 id → (供应商实例, 模型条目)。
    private var chatTargets: [String: (instanceId: String, entryId: String)] = [:]

    private static let sessionId = OffloadPermissionManager.selfTestSessionId

    private init() {
        checks = Self.staticChecks()
    }

    /// 自检探测命令对应的 (命令.动作),权限层只对这些免审批(见 OffloadPermissionManager.authorize)。
    static let probeScopes: Set<String> = Set(staticChecks().compactMap { check in
        guard let command = check.command else { return nil }
        let parts = command.split(separator: " ").map(String.init)
        guard let name = parts.first, name.hasPrefix("apple-") else { return nil }
        let invocation = OffloadPermissionInvocation(command: name, arguments: Array(parts.dropFirst()))
        return "\(invocation.command).\(invocation.action)"
    })

    private static func staticChecks() -> [Check] {
        func c(_ id: String, _ group: String, _ title: String, _ command: String) -> Check {
            Check(id: id, group: group, title: title, command: command)
        }
        return [
            c("shell", "终端", "Shell(iSH)", "echo selftest-ok && uname -m"),
            c("device-info", "设备", "设备信息", "apple-device info"),
            c("device-battery", "设备", "电池", "apple-device battery"),
            c("device-storage", "设备", "存储空间", "apple-device storage"),
            c("clipboard", "设备", "剪贴板", "apple-clipboard status"),
            c("notification", "设备", "通知", "apple-notification settings"),
            c("alarm", "设备", "闹钟", "apple-alarm list"),
            c("calendar", "个人数据", "日历", "apple-calendar calendars"),
            c("reminders", "个人数据", "提醒事项", "apple-reminders list"),
            c("contacts", "个人数据", "通讯录", "apple-contacts status"),
            c("photos", "个人数据", "相册", "apple-photos stats"),
            c("location", "个人数据", "定位", "apple-location current"),
            c("health", "个人数据", "健康", "apple-healthkit steps"),
            c("motion", "个人数据", "运动", "apple-motion status"),
            c("homekit", "个人数据", "家庭", "apple-homekit list"),
            c("weather", "系统服务", "天气", "apple-weather current"),
            // 地图搜索必须给中心点;用固定坐标,只测 MapKit 本身,不依赖定位。
            c("maps", "系统服务", "地图搜索", "apple-maps search --query 咖啡 --lat 31.2304 --lon 121.4737 --limit 1"),
            c("nlp", "系统服务", "自然语言", "apple-nlp language --text '你好,世界'"),
            c("speak", "系统服务", "朗读音色", "apple-speak voices"),
            c("speech", "系统服务", "语音识别", "apple-speech status"),
            c("media", "系统服务", "正在播放", "apple-media now-playing"),
            c("player", "系统服务", "播放器", "apple-player list"),
            c("shortcuts", "系统服务", "快捷指令", "apple-shortcuts list"),
            c("bluetooth", "系统服务", "蓝牙", "apple-bluetooth status"),
            c("ffmpeg", "系统服务", "FFmpeg", "ffmpeg -hide_banner -version"),
        ]
    }

    var summary: (passed: Int, unauthorized: Int, failed: Int, skipped: Int) {
        (checks.filter { $0.status == .passed }.count,
         checks.filter { $0.status == .unauthorized }.count,
         checks.filter { $0.status == .failed }.count,
         checks.filter { $0.status == .skipped }.count)
    }

    func run() async {
        guard !isRunning else { return }
        isRunning = true
        finishedAt = nil
        defer { isRunning = false }

        var list = Self.staticChecks()
        for instance in ProviderConfigStore.shared.instances {
            list.append(Check(id: "provider-\(instance.id)", group: "模型与连接",
                              title: "模型:\(instance.label)", command: nil))
        }
        for host in GatewayHostStore.shared.activeHosts {
            list.append(Check(id: "mac-\(host.id)", group: "模型与连接", title: "Mac:\(host.name)", command: nil))
        }
        list.append(Check(id: "jev", group: "模型与连接", title: "Jev 快速判断", command: nil))
        chatTargets = [:]
        if includeChat {
            for instance in ProviderConfigStore.shared.instances where instance.isEnabled {
                for entry in Self.chatProbeEntries(for: instance) {
                    let id = "chat-\(instance.id)-\(entry.id)"
                    chatTargets[id] = (instance.id, entry.id)
                    list.append(Check(id: id, group: "真实对话", title: "\(instance.label) · \(entry.model.displayName)", command: nil))
                }
            }
        }
        checks = list

        // 先把内核起起来(和聊天走同一段启动代码)。
        do {
            try AIChatViewModel.bootKernelIfNeeded()
            RootfsManager.shared.applyDefaultMountOverlay()
        } catch {
            for i in checks.indices where checks[i].command != nil {
                checks[i].status = .failed
                checks[i].detail = "内核没起来:\(error.localizedDescription)"
            }
        }

        for index in checks.indices {
            guard checks[index].status == .pending else { continue }
            checks[index].status = .running
            let start = CFAbsoluteTimeGetCurrent()
            let (status, detail) = await perform(checks[index])
            checks[index].status = status
            checks[index].detail = detail
            checks[index].ms = ((CFAbsoluteTimeGetCurrent() - start) * 1000).rounded()
        }
        finishedAt = Date()
        persist()
        includeChat = false
    }

    /// 第一次用会弹系统授权框的能力。命令在等你点选时会超时,那不是坏了,是在等授权。
    private static let permissionGated: Set<String> = [
        "calendar", "reminders", "contacts", "photos", "location", "health", "motion", "homekit", "speech", "media", "bluetooth",
    ]

    private func perform(_ check: Check) async -> (Status, String) {
        if let command = check.command {
            let (status, detail) = await runShell(command)
            if status == .failed, detail.contains("timed out"), Self.permissionGated.contains(check.id) {
                return (.unauthorized, "在等系统授权:请在弹窗里选「允许」或「不允许」,然后再测一次")
            }
            return (status, detail)
        }
        if check.id.hasPrefix("provider-") {
            let id = String(check.id.dropFirst("provider-".count))
            guard let instance = ProviderConfigStore.shared.instances.first(where: { $0.id == id }) else {
                return (.skipped, "已删除")
            }
            // 未登录的 OAuth 供应商也能从缓存列出模型,不能据此算"通过"。
            if instance.credentialType == .oauth, !instance.isOAuthAuthenticated {
                return (.unauthorized, "还没登录(设置 → AI 服务商 → \(instance.label))")
            }
            do {
                let models = try await ProviderConfigStore.fetchModelsForInstance(instance, forceRefresh: true)
                return models.isEmpty ? (.failed, "连上了,但没有返回模型") : (.passed, "\(models.count) 个模型")
            } catch {
                let text = error.localizedDescription
                let lowered = text.lowercased()
                if lowered.contains("401") || lowered.contains("403") || lowered.contains("unauthorized") {
                    return (.unauthorized, text)
                }
                return (.failed, text)
            }
        }
        if check.id.hasPrefix("mac-") {
            let id = String(check.id.dropFirst("mac-".count))
            guard let host = GatewayHostStore.shared.activeHosts.first(where: { $0.id == id }) else {
                return (.skipped, "已移除")
            }
            // 带钥匙问一次能开哪些会话:中继对没带钥匙的请求一律回 401,只看 /health 会把休眠的 Mac 算成可达。
            guard let client = GatewayHostStore.shared.client(for: host) else { return (.failed, "缺少访问密钥") }
            do {
                let kinds = try await client.harnessKinds()
                return (.passed, kinds.isEmpty ? "可达" : "可达 · " + kinds.map(\.name).joined(separator: " / "))
            } catch {
                return (.failed, "连不上(Mac 可能在休眠):\(error.localizedDescription.prefix(80))")
            }
        }
        if let target = chatTargets[check.id] {
            return await chatProbe(instanceId: target.instanceId, entryId: target.entryId)
        }
        if check.id == "jev" {
            guard JevClient.hasKey else { return (.skipped, "没填 Key(设置 → Agent → Jev 快速判断)") }
            do {
                let yes = try await JevClient.ping()
                return (.passed, "判断\"是\"的概率 \(String(format: "%.2f", yes))")
            } catch {
                return (.failed, error.localizedDescription)
            }
        }
        return (.skipped, "")
    }

    /// 每个供应商测它最新的模型(按 id 倒序近似"最新",跳过只出图的);ChatGPT 登录的测三个,新模型常常一次出好几个。
    private static func chatProbeEntries(for instance: ProviderInstance) -> [ModelEntry] {
        // 只挑能聊天的:出图、出视频、语音、向量这类生成 / 专用模型本来就不收对话请求(1.42.0 实测会误报失败)。
        let mediaWords = ["image", "imagine", "video", "tts", "audio", "speech", "whisper", "transcribe", "embed", "realtime"]
        let chatCapable = ProviderConfigStore.shared.visibleEntries(for: instance.id)
            .filter { entry in
                let id = entry.model.id.lowercased()
                let modality = entry.model.modalityOverride ?? []
                return !modality.contains(.imageOutput) && !modality.contains(.videoOutput)
                    && !modality.contains(.audioOutput) && !mediaWords.contains { id.contains($0) }
            }
        let count = (instance.providerType == .openAI && instance.credentialType == .oauth) ? 3 : 1
        // 先测你真正在用的(模型分组里的成员),再按 id 倒序补"最新的"。
        let used = Set(ProviderConfigStore.shared.config.modelGroups.flatMap(\.memberEntryIds))
        let inGroups = chatCapable.filter { used.contains($0.id) }
        let newest = chatCapable
            .filter { !used.contains($0.id) }
            .sorted { $0.model.id.localizedStandardCompare($1.model.id) == .orderedDescending }
        return Array((inGroups + newest).prefix(count))
    }

    /// 发一句 "只回复 OK",等流结束。成功 = 收到文字或正常结束;失败把服务端原话带回来。
    private func chatProbe(instanceId: String, entryId: String) async -> (Status, String) {
        guard let entry = ProviderConfigStore.shared.config.modelEntries.first(where: { $0.id == entryId }) else {
            return (.skipped, "模型已删除")
        }
        let provider = await AIChatViewModel.makeAgentProvider(for: entry)
        let probeTool = AgentToolDefinition(
            name: "selftest_noop", description: "Self-test placeholder tool. Never call it.",
            parameters: ["note": AgentToolParam(type: .string, description: "Unused.")], required: [])
        let work = Task { () -> (Status, String) in
            var text = ""
            do {
                let stream = try await provider.streamAgentMessage(
                    messages: [AgentMessage(role: .user, parts: [.text("Reply with exactly: OK")])],
                    systemPrompt: "You are a connectivity check. Reply with exactly OK.",
                    tools: [probeTool], maxTokens: 64, thinkingLevel: .off)
                for try await event in stream {
                    if case .textDelta(let delta) = event { text += delta }
                }
                // 超时取消时流会悄悄结束、不抛错:不能当成通过。
                if Task.isCancelled { return (.failed, "45 秒内没有回复") }
                let reply = text.trimmingCharacters(in: .whitespacesAndNewlines)
                return (.passed, reply.isEmpty ? "请求成功(没有文字回复)" : "回复:\(reply.prefix(40))")
            } catch {
                let message = error.localizedDescription
                let lowered = message.lowercased()
                if lowered.contains("401") || lowered.contains("403") || lowered.contains("unauthorized") {
                    return (.unauthorized, String(message.prefix(160)))
                }
                return (.failed, String(message.prefix(200)))
            }
        }
        let timeout = Task {
            try? await Task.sleep(nanoseconds: 45_000_000_000)
            work.cancel()
        }
        let result = await work.value
        timeout.cancel()
        if Task.isCancelled || (result.0 == .failed && result.1.lowercased().contains("cancel")) {
            return (.failed, "45 秒内没有回复")
        }
        return result
    }

    private func runShell(_ command: String) async -> (Status, String) {
        do {
            let result = try await ISHExecutionCoordinator.shared.execute(
                sessionId: Self.sessionId, command: command, timeout: 25,
                lineCallback: { _ in }, pidCallback: { _ in })
            return Self.classify(output: result.output, exitCode: Int(result.exitCode))
        } catch {
            return (.failed, error.localizedDescription)
        }
    }

    /// apple-* 命令输出 `{"ok": true|false, "error": {"code", "message"}}`;
    /// 其余命令只看退出码。权限类错误单独记为"未授权",不算坏了。
    static func classify(output: String, exitCode: Int) -> (Status, String) {
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        if let start = trimmed.firstIndex(of: "{"),
           let data = String(trimmed[start...]).data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let ok = json["ok"] as? Bool {
            if ok { return (.passed, compact(json)) }
            let error = json["error"] as? [String: Any]
            let code = (error?["code"] as? String) ?? ""
            let message = (error?["message"] as? String) ?? trimmed
            let authWords = ["auth", "denied", "permission", "restricted", "not_determined", "consent", "foreground"]
            if authWords.contains(where: { code.lowercased().contains($0) || message.lowercased().contains($0) })
                || message.contains("授权") || message.contains("权限") {
                return (.unauthorized, message)
            }
            return (.failed, code.isEmpty ? message : "\(code):\(message)")
        }
        if exitCode == 0 { return (.passed, String(trimmed.prefix(80))) }
        return (.failed, "退出码 \(exitCode):\(String(trimmed.prefix(120)))")
    }

    private static func compact(_ json: [String: Any]) -> String {
        var copy = json
        for key in ["ok", "tool", "action", "timestamp"] { copy.removeValue(forKey: key) }
        guard let data = try? JSONSerialization.data(withJSONObject: copy, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return "" }
        return String(text.prefix(90))
    }

    private func persist() {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return }
        let dir = support.appendingPathComponent("Diagnostics", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let s = summary
        let payload: [String: Any] = [
            "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?",
            "finishedAt": ISO8601DateFormatter().string(from: finishedAt ?? Date()),
            "summary": ["passed": s.passed, "unauthorized": s.unauthorized, "failed": s.failed, "skipped": s.skipped],
            "checks": checks.map { ["id": $0.id, "group": $0.group, "title": $0.title,
                                    "status": $0.status.rawValue, "ms": $0.ms, "detail": $0.detail] },
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: dir.appendingPathComponent("selftest.json"))
        }
    }
}

struct CapabilitySelfTestView: View {
    @ObservedObject private var test = CapabilitySelfTest.shared

    private var groups: [String] {
        var seen: [String] = []
        for check in test.checks where !seen.contains(check.group) { seen.append(check.group) }
        return seen
    }

    var body: some View {
        List {
            Section {
                HStack(spacing: 14) {
                    stat(test.summary.passed, "通过", .green)
                    stat(test.summary.unauthorized, "未授权", .orange)
                    stat(test.summary.failed, "失败", .red)
                    Spacer()
                    Button(test.isRunning ? "检查中…" : (test.finishedAt == nil ? "开始自检" : "再测一次")) {
                        Task { await test.run() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(test.isRunning)
                }
                Toggle("同时真发一句话测模型(每个供应商几十个 token)", isOn: $test.includeChat)
                    .font(.footnote)
                    .disabled(test.isRunning)
            } footer: {
                Text("用只读方式把每项能力按 Agent 的同一条路跑一遍。\"未授权\"不是坏了,是系统或 App 里还没允许;点一项的说明看原因。")
            }
            ForEach(groups, id: \.self) { group in
                Section(group) {
                    ForEach(test.checks.filter { $0.group == group }) { check in
                        row(check)
                    }
                }
            }
        }
        .navigationTitle("能力自检")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if test.autoRunRequested {
                test.autoRunRequested = false
                await test.run()
            }
        }
    }

    private func stat(_ value: Int, _ label: String, _ color: Color) -> some View {
        VStack(spacing: 2) {
            Text("\(value)")
                .font(.title3.weight(.semibold).monospacedDigit())
                .foregroundStyle(color)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private func row(_ check: CapabilitySelfTest.Check) -> some View {
        HStack(alignment: .top, spacing: 10) {
            statusIcon(check.status)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(check.title)
                    .font(.subheadline.weight(.medium))
                if !check.detail.isEmpty {
                    Text(check.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .textSelection(.enabled)
                }
            }
            Spacer(minLength: 4)
            if check.ms > 0 {
                Text("\(Int(check.ms)) ms")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func statusIcon(_ status: CapabilitySelfTest.Status) -> some View {
        switch status {
        case .pending:
            Image(systemName: "circle.dotted").foregroundStyle(.tertiary)
        case .running:
            ProgressView().controlSize(.small)
        case .passed:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .unauthorized:
            Image(systemName: "lock.circle.fill").foregroundStyle(.orange)
        case .failed:
            Image(systemName: "xmark.octagon.fill").foregroundStyle(.red)
        case .skipped:
            Image(systemName: "minus.circle").foregroundStyle(.secondary)
        }
    }
}
