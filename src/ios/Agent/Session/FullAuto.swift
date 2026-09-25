import AVFoundation
import Contacts
import CoreLocation
import EventKit
import Foundation
import Photos
import Speech
import SwiftUI
import UserNotifications

/// [T-full-auto] 「全自动」:打开后 Agent 执行任务时不再逐次确认。
///
/// 覆盖三道闸:`SensitiveToolGate`(写文件、终端、Cookie、远程终端、远程 Agent,前台后台一样)、
/// `OffloadPermissionManager`(原生能力里设为「询问」的一律放行;你设成「不允许」的仍不执行)、
/// 配置修改确认(自动通过;`protectedConfigPaths` 里降低保护的几项 Agent 仍改不了)。
///
/// 只有你能开关:设置 → 权限,或聊天 / 首页输入框上方的「全自动」开关、`/auto`。配置注册表里是只读
/// 占位(Agent 写入返回 permission_denied),快捷指令、Siri、机器人都没有这个动作。按设备存 UserDefaults,不进任何同步。
@MainActor
final class FullAutoStore: ObservableObject {
    static let shared = FullAutoStore()
    static let defaultsKey = FullAutoGate.defaultsKey

    @Published var enabled: Bool {
        didSet {
            guard enabled != oldValue else { return }
            UserDefaults.standard.set(enabled, forKey: Self.defaultsKey)
            AppLogger(category: "FullAuto").info("[FullAuto] \(enabled ? "打开" : "关闭")")
            if !enabled { Self.turnOffOnMacs() }
        }
    }

    /// 关掉开关时,已升级的 Mac(LeoPhoneAgent 1.2 起)上由这台手机发起、还在全自动跑的任务
    /// 一并切回「先问我」。尽力而为:连不上的 Mac 下次收到这台手机的消息时也会按开关切回。
    private static func turnOffOnMacs() {
        Task { @MainActor in
            for host in GatewayHostStore.shared.activeHosts where host.runsLeoPhoneAgent {
                guard let client = GatewayHostStore.shared.client(for: host) else { continue }
                Task {
                    // 手机或中继一时不通就重试几次(1 s、5 s、20 s);都不通时,之后发给这台 Mac 的每条消息也会带上"关"。
                    for delay in [0, 1, 5, 20] as [UInt64] {
                        if delay > 0 { try? await Task.sleep(nanoseconds: delay * 1_000_000_000) }
                        guard await MainActor.run(body: { !FullAutoStore.shared.enabled }) else { return }
                        if (try? await client.turnOffFullAuto()) != nil { return }
                    }
                }
            }
        }
    }

    /// [T-smart-approve] 全自动关着时回到哪一档(逐项确认 / 智能批准)。
    @Published private var smartWhenOff: Bool {
        didSet { UserDefaults.standard.set(smartWhenOff ? FullAutoGate.Mode.smart.rawValue : FullAutoGate.Mode.ask.rawValue,
                                           forKey: FullAutoGate.modeKey) }
    }

    /// 三档审批;`enabled` 仍是全自动本身(配置注册表、Mac 转发都读它)。
    var mode: FullAutoGate.Mode {
        get { enabled ? .full : (smartWhenOff ? .smart : .ask) }
        set {
            if newValue != .full { smartWhenOff = newValue == .smart }
            enabled = newValue == .full
        }
    }

    private init() {
        enabled = UserDefaults.standard.bool(forKey: Self.defaultsKey)
        smartWhenOff = UserDefaults.standard.string(forKey: FullAutoGate.modeKey) == FullAutoGate.Mode.smart.rawValue
    }
}

extension FullAutoGate.Mode {
    var title: String {
        switch self {
        case .ask: String(localized: "逐项确认")
        case .smart: String(localized: "智能批准")
        case .full: String(localized: "全自动")
        }
    }

    var symbol: String {
        switch self {
        case .ask: "hand.raised"
        case .smart: "checkmark.shield"
        case .full: "bolt.fill"
        }
    }

    var detail: String {
        switch self {
        case .ask: String(localized: "写文件、跑命令、调用手机能力前都先问你。")
        case .smart: String(localized: "只读、不碰个人数据的操作直接放行；会改动的先问你，一个会话里允许过就不再问。")
        case .full: String(localized: "不再逐项确认。设成「不允许」的能力仍然不执行。")
        }
    }

    var tint: Color {
        switch self {
        case .ask: .secondary
        case .smart: .teal
        case .full: .orange
        }
    }
}

// MARK: - 任务来源

/// 自动批准的日志里标上任务从哪来。快捷指令被"通知触发"时系统不告诉 App,统一记为快捷指令。
enum TaskSource: String {
    case app = "App"
    case shortcut = "快捷指令"
    case scheduled = "定时任务"
}

enum TaskSourceRegistry {
    private static let lock = NSLock()
    private static var sources: [String: TaskSource] = [:]
    private static var pending: TaskSource?

    /// 定时任务在派发前声明来源,`SendPromptIntent.dispatchRun` 取走。
    static func setPending(_ source: TaskSource?) {
        lock.lock(); pending = source; lock.unlock()
    }

    /// 你在 App 里发消息:这一轮起按"App"记,不再沿用之前快捷指令或定时任务打的标签。
    static func clear(sessionId: String) {
        lock.lock(); sources[sessionId] = nil; lock.unlock()
    }

    /// 经 App Intent 派发的任务:没有声明就是快捷指令。
    static func tagIntentRun(sessionId: String) {
        lock.lock()
        sources[sessionId] = pending ?? .shortcut
        pending = nil
        lock.unlock()
    }

    static func source(for sessionId: String?) -> TaskSource {
        guard let sessionId else { return .app }
        lock.lock(); defer { lock.unlock() }
        return sources[sessionId] ?? .app
    }
}

// MARK: - 自动批准记录

enum FullAutoLog {
    /// 各道闸经 `FullAutoGate.announce` 广播,这里统一落日志。App 启动时装一次。
    static func install() {
        NotificationCenter.default.addObserver(forName: FullAutoGate.approvedNotification, object: nil, queue: .main) { note in
            let what = note.userInfo?["what"] as? String ?? ""
            let sid = note.userInfo?["sessionId"] as? String
            MainActor.assumeIsolated { FullAutoLog.note(what, sessionId: sid) }
        }
    }

    /// 记进活动日志,原因标"自动批准",工具名里带上做了什么和来源。
    @MainActor
    static func note(_ what: String, sessionId: String?) {
        let source = TaskSourceRegistry.source(for: sessionId)
        let summary = String(what.prefix(80))
        AppLogger(category: "FullAuto").info("[FullAuto] 自动批准 \(summary) 来源=\(source.rawValue)")
        guard let sid = sessionId,
              let runId = SessionActivityTracker.shared.currentRunId(for: sid) else { return }
        _ = AgentActivityLog.shared.append(AgentActivityEvent(
            runId: runId, sessionId: sid, kind: .toolChanged, phase: .usingTool,
            toolName: "\(summary) · \(source.rawValue)", reason: .autoApproved))
    }
}

// MARK: - 常驻标记

/// 审批档位:聊天和首页输入框上方常驻,点开是三档菜单(逐项确认 / 智能批准 / 全自动)。
/// 第一次切到全自动先说明一次后果(之后一选即开);切换的瞬间标签展开成一句说明,两秒后收回。
struct FullAutoBadge: View {
    static let explainedKey = "fullAuto.explainedOnce"

    @ObservedObject private var store = FullAutoStore.shared
    @AppStorage(FullAutoBadge.explainedKey) private var explainedOnce = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var confirming = false
    @State private var flashToken = 0
    @State private var flashing = false

    var body: some View {
        let mode = store.mode
        Menu {
            Picker("审批方式", selection: Binding(get: { store.mode }, set: choose)) {
                ForEach(FullAutoGate.Mode.allCases, id: \.self) { option in
                    Label {
                        Text(option.title)
                        Text(option.detail)
                    } icon: {
                        Image(systemName: option.symbol)
                    }
                    .tag(option)
                }
            }
            .pickerStyle(.inline)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: mode.symbol)
                    .font(.system(size: 10, weight: .bold))
                    .contentTransition(.symbolEffect(.replace))
                Text(flashing ? "\(mode.title) · \(mode == .full ? String(localized: "不再逐项确认") : String(localized: "只读的直接放行"))" : mode.title)
                    .lineLimit(1)
                    .contentTransition(.interpolate)
            }
            .font(.caption2.weight(.semibold))
            .fixedSize()
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(Capsule().fill(mode == .ask ? Color.primary.opacity(0.06) : mode.tint.opacity(0.16)))
            .foregroundStyle(mode.tint)
            .contentShape(Capsule())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .accessibilityLabel(String(localized: "审批方式：\(mode.title)"))
        .accessibilityHint(mode.detail)
        .confirmationDialog("打开全自动?", isPresented: $confirming, titleVisibility: .visible) {
            Button("打开全自动") {
                explainedOnce = true
                setMode(.full)
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("Agent 写文件、跑命令、调用手机能力、改设置都不再逐项确认,发给 Mac 的任务也一样。你设成「不允许」的能力仍然不执行。随时再点这里关掉。")
        }
        .animation(reduceMotion ? nil : .spring(duration: 0.3, bounce: 0.2), value: mode)
        .animation(reduceMotion ? nil : .spring(duration: 0.3, bounce: 0.15), value: flashing)
    }

    private func choose(_ mode: FullAutoGate.Mode) {
        if mode == .full, !explainedOnce, store.mode != .full {
            confirming = true
        } else {
            setMode(mode)
        }
    }

    private func setMode(_ mode: FullAutoGate.Mode) {
        guard mode != store.mode else { return }
        store.mode = mode
        LeoHaptics.impact(mode == .ask ? .light : .medium)
        flashToken += 1
        guard mode != .ask else {
            flashing = false
            return
        }
        flashing = true
        let token = flashToken
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 2_200_000_000)
            if flashToken == token { flashing = false }
        }
    }
}

// MARK: - 设置页开关

struct FullAutoSettingsSection: View {
    @ObservedObject private var store = FullAutoStore.shared
    @State private var showSystemPermissions = false

    var body: some View {
        Section {
            Picker(selection: Binding(
                get: { store.mode },
                set: { newValue in
                    store.mode = newValue
                    if newValue == .full {
                        // 在这里选过就已经看过说明了,输入框上的菜单之后一选即开。
                        UserDefaults.standard.set(true, forKey: FullAutoBadge.explainedKey)
                        showSystemPermissions = true
                    }
                }
            )) {
                ForEach(FullAutoGate.Mode.allCases, id: \.self) { option in
                    Label {
                        Text(option.title)
                        Text(option.detail)
                    } icon: {
                        Image(systemName: option.symbol).foregroundStyle(option.tint)
                    }
                    .tag(option)
                }
            } label: {
                Label("审批方式", systemImage: "checkmark.shield")
            }
            .pickerStyle(.inline)
            if store.enabled {
                Button("一次授完系统权限") { showSystemPermissions = true }
            }
        } footer: {
            Text("智能批准直接放行只读、不碰个人数据的操作(查看文件、git status、天气、地图这类);会改动的先问你,审批框上会标出删除、强推、sudo 这类高风险命令。全自动下什么都不再问,发给 LeoPhoneAgent Mac 的任务也一样;你设成「不允许」的能力仍然不执行;相册、定位这类系统弹窗由 iOS 控制,任何 App 都跳不过,可以在这里一次授完。")
        }
        .sheet(isPresented: $showSystemPermissions) {
            SystemPermissionsSheet()
        }
    }
}

// MARK: - 系统权限一次授完

/// 列出尚未决定的系统权限,点一次按顺序弹系统授权框。已拒绝的只能去系统设置里改。
struct SystemPermissionsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var statuses: [SystemPermission: SystemPermissionStatus] = [:]
    @State private var requesting = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(SystemPermission.allCases) { permission in
                        HStack {
                            Label(permission.title, systemImage: permission.icon)
                            Spacer()
                            Text(statuses[permission]?.label ?? "…")
                                .font(.footnote)
                                .foregroundStyle(statuses[permission]?.color ?? .secondary)
                        }
                    }
                } footer: {
                    Text("只会弹出还没决定过的项。已拒绝的项请到 系统设置 → LeoPhoneAgent 里打开。")
                }
            }
            .navigationTitle("系统权限")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("完成") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(requesting ? "授权中…" : "全部授权") {
                        Task { await requestAll() }
                    }
                    .disabled(requesting || !statuses.values.contains(.notDetermined))
                }
            }
            .task { await refresh() }
        }
    }

    private func refresh() async {
        var result: [SystemPermission: SystemPermissionStatus] = [:]
        for permission in SystemPermission.allCases {
            result[permission] = await permission.status()
        }
        statuses = result
    }

    private func requestAll() async {
        requesting = true
        defer { requesting = false }
        for permission in SystemPermission.allCases {
            guard await permission.status() == .notDetermined else { continue }
            await permission.request()
            await refresh()
        }
    }
}

enum SystemPermissionStatus: Equatable {
    case notDetermined, granted, denied

    var label: String {
        switch self {
        case .notDetermined: return "未授权"
        case .granted: return "已允许"
        case .denied: return "已拒绝"
        }
    }

    var color: Color {
        switch self {
        case .notDetermined: return .orange
        case .granted: return .green
        case .denied: return .secondary
        }
    }
}

enum SystemPermission: String, CaseIterable, Identifiable {
    case notifications, photos, camera, microphone, speech, contacts, calendar, reminders, location

    var id: String { rawValue }

    var title: String {
        switch self {
        case .notifications: return "通知"
        case .photos: return "相册"
        case .camera: return "相机"
        case .microphone: return "麦克风"
        case .speech: return "语音识别"
        case .contacts: return "通讯录"
        case .calendar: return "日历"
        case .reminders: return "提醒事项"
        case .location: return "定位"
        }
    }

    var icon: String {
        switch self {
        case .notifications: return "bell.fill"
        case .photos: return "photo.fill"
        case .camera: return "camera.fill"
        case .microphone: return "mic.fill"
        case .speech: return "waveform"
        case .contacts: return "person.crop.circle.fill"
        case .calendar: return "calendar"
        case .reminders: return "checklist"
        case .location: return "location.fill"
        }
    }

    func status() async -> SystemPermissionStatus {
        switch self {
        case .notifications:
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            switch settings.authorizationStatus {
            case .notDetermined: return .notDetermined
            case .denied: return .denied
            default: return .granted
            }
        case .photos:
            return Self.map(PHPhotoLibrary.authorizationStatus(for: .readWrite).rawValue,
                            notDetermined: PHAuthorizationStatus.notDetermined.rawValue,
                            granted: [PHAuthorizationStatus.authorized.rawValue, PHAuthorizationStatus.limited.rawValue])
        case .camera:
            return Self.map(AVCaptureDevice.authorizationStatus(for: .video).rawValue,
                            notDetermined: AVAuthorizationStatus.notDetermined.rawValue,
                            granted: [AVAuthorizationStatus.authorized.rawValue])
        case .microphone:
            switch AVAudioApplication.shared.recordPermission {
            case .undetermined: return .notDetermined
            case .granted: return .granted
            default: return .denied
            }
        case .speech:
            return Self.map(SFSpeechRecognizer.authorizationStatus().rawValue,
                            notDetermined: SFSpeechRecognizerAuthorizationStatus.notDetermined.rawValue,
                            granted: [SFSpeechRecognizerAuthorizationStatus.authorized.rawValue])
        case .contacts:
            return Self.map(CNContactStore.authorizationStatus(for: .contacts).rawValue,
                            notDetermined: CNAuthorizationStatus.notDetermined.rawValue,
                            granted: [CNAuthorizationStatus.authorized.rawValue, CNAuthorizationStatus.limited.rawValue])
        case .calendar:
            return Self.map(EKEventStore.authorizationStatus(for: .event).rawValue,
                            notDetermined: EKAuthorizationStatus.notDetermined.rawValue,
                            granted: [EKAuthorizationStatus.fullAccess.rawValue, EKAuthorizationStatus.writeOnly.rawValue])
        case .reminders:
            return Self.map(EKEventStore.authorizationStatus(for: .reminder).rawValue,
                            notDetermined: EKAuthorizationStatus.notDetermined.rawValue,
                            granted: [EKAuthorizationStatus.fullAccess.rawValue])
        case .location:
            let status = CLLocationManager().authorizationStatus
            switch status {
            case .notDetermined: return .notDetermined
            case .authorizedAlways, .authorizedWhenInUse: return .granted
            default: return .denied
            }
        }
    }

    func request() async {
        switch self {
        case .notifications:
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        case .photos:
            _ = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        case .camera:
            _ = await AVCaptureDevice.requestAccess(for: .video)
        case .microphone:
            _ = await AVAudioApplication.requestRecordPermission()
        case .speech:
            await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                SFSpeechRecognizer.requestAuthorization { _ in cont.resume() }
            }
        case .contacts:
            _ = try? await CNContactStore().requestAccess(for: .contacts)
        case .calendar:
            _ = try? await EKEventStore().requestFullAccessToEvents()
        case .reminders:
            _ = try? await EKEventStore().requestFullAccessToReminders()
        case .location:
            await LocationPermissionRequester.shared.request()
        }
    }

    private static func map(_ raw: Int, notDetermined: Int, granted: [Int]) -> SystemPermissionStatus {
        if raw == notDetermined { return .notDetermined }
        return granted.contains(raw) ? .granted : .denied
    }
}

/// 定位授权要一个活着的 CLLocationManager 等回调。
@MainActor
private final class LocationPermissionRequester: NSObject, CLLocationManagerDelegate {
    static let shared = LocationPermissionRequester()
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<Void, Never>?

    func request() async {
        guard manager.authorizationStatus == .notDetermined else { return }
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            continuation = cont
            manager.delegate = self
            manager.requestWhenInUseAuthorization()
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            guard manager.authorizationStatus != .notDetermined else { return }
            continuation?.resume()
            continuation = nil
        }
    }
}
