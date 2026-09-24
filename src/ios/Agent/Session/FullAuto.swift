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
/// 只有你能开关:设置 → 权限。配置注册表里是只读占位(Agent 写入返回 permission_denied),
/// 快捷指令、Siri、机器人都没有这个动作。按设备存 UserDefaults,不进任何同步。
@MainActor
final class FullAutoStore: ObservableObject {
    static let shared = FullAutoStore()
    static let defaultsKey = FullAutoGate.defaultsKey

    @Published var enabled: Bool {
        didSet {
            guard enabled != oldValue else { return }
            UserDefaults.standard.set(enabled, forKey: Self.defaultsKey)
            AppLogger(category: "FullAuto").info("[FullAuto] \(enabled ? "打开" : "关闭")")
        }
    }

    private init() {
        enabled = UserDefaults.standard.bool(forKey: Self.defaultsKey)
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

/// 全自动打开时显示;点一下直接关掉。
struct FullAutoBadge: View {
    @ObservedObject private var store = FullAutoStore.shared

    var body: some View {
        if store.enabled {
            Button {
                store.enabled = false
                LeoHaptics.impact(.light)
            } label: {
                Label("全自动", systemImage: "bolt.fill")
                    .font(.caption2.weight(.semibold))
                    .labelStyle(.titleAndIcon)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Capsule().fill(Color.orange.opacity(0.16)))
                    .foregroundStyle(.orange)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("全自动已打开")
            .accessibilityHint("点一下关闭全自动,之后敏感操作会先问你")
            .transition(.opacity)
        }
    }
}

// MARK: - 设置页开关

struct FullAutoSettingsSection: View {
    @ObservedObject private var store = FullAutoStore.shared
    @State private var showSystemPermissions = false

    var body: some View {
        Section {
            Toggle(isOn: Binding(
                get: { store.enabled },
                set: { newValue in
                    store.enabled = newValue
                    if newValue { showSystemPermissions = true }
                }
            )) {
                Label("全自动(不再询问)", systemImage: "bolt.fill")
            }
            .tint(.orange)
            if store.enabled {
                Button("一次授完系统权限") { showSystemPermissions = true }
            }
        } footer: {
            Text("打开后,Agent 执行任务时写文件、跑命令、读写网站登录状态、调用手机能力、改设置都不再逐次确认,手机发给 Mac 的任务也一样(连上新 Mac 后生效)。你设成「不允许」的能力仍然不执行;相册、定位这类系统弹窗由 iOS 控制,任何 App 都跳不过,可以在这里一次授完。关闭后立即恢复询问。")
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
