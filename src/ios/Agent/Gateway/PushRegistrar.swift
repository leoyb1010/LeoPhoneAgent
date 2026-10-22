//
//  PushRegistrar.swift
//  MinisApp
//
//  [T-live-mission] 把这台设备登记到中继,让 Mac 上的事件能在 app
//  完全没运行时也推到锁屏。
//
//  两种 token,用途不同:
//  - device token:普通远程通知。审批请求走它,带「允许一次/拒绝」按钮,
//    锁屏直接按,不用开 app。
//  - push-to-start token(iOS 17.2+):远程拉起 Live Activity。任务开跑时
//    灵动岛/锁屏出现任务卡,后续状态用 activity 自己的 update token 推。
//
//  两者都注册到中继的 /relay/device。中继按 (bundle, token) 去重,
//  设备重装/换机不会留下幽灵 token(APNs 回 410 时中继自行清理)。
//

import Combine
import Foundation
import UIKit
import UserNotifications
#if canImport(ActivityKit)
import ActivityKit
#endif

@MainActor
final class PushRegistrar {
    static let shared = PushRegistrar()
    private init() {}

    private var lastDeviceToken: String? {
        get { UserDefaults.standard.string(forKey: "leo.push.lastDeviceToken") }
        set { UserDefaults.standard.set(newValue, forKey: "leo.push.lastDeviceToken") }
    }
    private var lastPushToStartToken: String?
    private var lastAuthorizationRefresh: Date = .distantPast
    private var liveActivityToggleWatch: AnyCancellable?

    /// [remote-ctl-power] 设置里关了 Live Activity 就不把 push-to-start token 交给中继
    /// (否则中继照样为每个任务远程拉起卡片、叫醒手机)。中继没有注销 push-to-start 的接口:
    /// 关掉之后只是不再登记,已登记的那份仍留在中继上;它拉起的卡这边直接收掉(见 observePushToStart)。
    private var pushToStartAllowed: Bool {
        MacFollowLogic.shouldRegisterPushToStart(
            liveActivityEnabled: MacFollowLogic.liveActivityEnabled(),
            supported: AgentLiveActivityManager.isLiveActivitySupported)
    }

    /// 启动时调用:请求通知权限并向 APNs 注册。
    func start() {
        refreshAuthorizationAndRegister()
        observePushToStart()
        // 开关打开时补登记缓存的 token;关上时停掉还在退避重试的那一轮。
        liveActivityToggleWatch = BackgroundKeepAliveManager.shared.$liveActivityEnabled
            .dropFirst()
            .removeDuplicates()
            .sink { [weak self] enabled in
                // @Published 在赋值前发出:下一拍再读 UserDefaults。
                Task { @MainActor in
                    guard let self else { return }
                    if enabled {
                        if self.pushToStartAllowed, let token = self.lastPushToStartToken {
                            await self.register(kind: "push_to_start", token: token)
                        }
                    } else {
                        self.registerGenerations["push_to_start", default: 0] &+= 1
                    }
                }
            }
    }

    /// Foreground / Settings-return: if the user granted notifications after
    /// the first deny, actually register. Also re-POSTs a persisted token
    /// once a relay host exists.
    func refreshAuthorizationAndRegister() {
        // [S6] didFinishLaunching's start() and the launch's first scenePhase
        // .active both landed here within the same second: one pass per 10 s.
        let now = Date()
        guard now.timeIntervalSince(lastAuthorizationRefresh) >= 10 else { return }
        lastAuthorizationRefresh = now
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            Task { @MainActor in
                switch settings.authorizationStatus {
                case .authorized, .provisional, .ephemeral:
                    UIApplication.shared.registerForRemoteNotifications()
                    self.reregisterIfPossible()
                case .notDetermined:
                    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
                        guard granted else { return }
                        Task { @MainActor in
                            UIApplication.shared.registerForRemoteNotifications()
                        }
                    }
                default:
                    break
                }
            }
        }
    }

    /// AppDelegate 的 didRegisterForRemoteNotificationsWithDeviceToken 转进来。
    func handleDeviceToken(_ data: Data) {
        let token = data.map { String(format: "%02x", $0) }.joined()
        lastDeviceToken = token
        Task { await register(kind: "device", token: token) }
    }

    /// Hosts appeared after the first token — send it again so APNs is not
    /// stuck on "no relay client yet".
    func reregisterIfPossible() {
        if let token = lastDeviceToken {
            Task { await register(kind: "device", token: token) }
        }
        if let token = lastPushToStartToken, pushToStartAllowed {
            Task { await register(kind: "push_to_start", token: token) }
        }
    }

    /// [T-live-mission] push-to-start token。拿到后中继就能在审批/开跑时远程拉起
    /// 灵动岛任务卡,不需要 app 在前台。
    private func observePushToStart() {
        #if canImport(ActivityKit)
        guard AgentLiveActivityManager.isLiveActivitySupported else { return }
        Task {
            for await data in Activity<AgentActivityAttributes>.pushToStartTokenUpdates {
                let token = data.map { String(format: "%02x", $0) }.joined()
                await MainActor.run {
                    guard token != self.lastPushToStartToken else { return }
                    // 先记下:开关之后打开时还要用它登记。
                    self.lastPushToStartToken = token
                    guard self.pushToStartAllowed else { return }
                    Task { await self.register(kind: "push_to_start", token: token) }
                }
            }
        }
        // [WP-41] 中继远程拉起的卡:系统会把 App 叫醒交出这张卡的 update token,
        // 登记上去,后续的 update / end 才有地方发。
        Task {
            for await activity in Activity<AgentActivityAttributes>.activityUpdates
            where activity.attributes.origin == AgentActivityAttributes.relayOrigin {
                Task { @MainActor in
                    // [remote-ctl-power] 开关关着时中继还拿着旧的 push-to-start token(没有注销接口):
                    // 它拉起的卡直接收掉,不登记 update token,中继也就不会再推更新叫醒手机。
                    guard MacFollowLogic.liveActivityEnabled() else {
                        await activity.end(nil, dismissalPolicy: .immediate)
                        return
                    }
                    for await data in activity.pushTokenUpdates {
                        let state = activity.content.state
                        let token = LiveActivityTokenRegistration.hex(data)
                        // 失败重试在里面退避,别挡住下一次 token 更新。
                        Task { await self.registerActivityUpdateToken(token, sessions: state.sessions,
                                                                      privacyMode: state.privacyMode) }
                    }
                }
            }
        }
        #endif
    }

    /// [WP-41] 一张 Live Activity 的 update token 连同卡上的会话登记到中继。中继回 2xx 才返回 true。
    @discardableResult
    func registerActivityUpdateToken(_ token: String, sessions: [LiveSessionSnapshot], privacyMode: Bool) async -> Bool {
        guard let payload = LiveActivityTokenRegistration.payload(
            token: token, sessions: sessions, privacyMode: privacyMode,
            bundleId: Bundle.main.bundleIdentifier ?? "", environment: Self.apsEnvironment) else { return false }
        return await sendWithRetry(payload, key: "activity_update:\(token)")
    }

    /// token 轮换后注销旧的,中继别再往死 token 推(推到 APNs 回 410 为止白费一路)。
    /// 只试一次:旧中继没有这个接口(404/405),失败了也只是回到以前的行为。
    func unregisterActivityUpdateToken(_ token: String) async {
        guard let client = GatewayHostStore.shared.activeHosts
            .compactMap({ GatewayHostStore.shared.client(for: $0) })
            .first(where: { $0.relayEventsURL != nil }) else { return }
        registerGenerations["activity_update:\(token)", default: 0] &+= 1   // 还在重试的旧登记别再发
        _ = await client.unregisterActivityToken(token)
    }

    /// 把 token 送到中继。中继与全部 Mac 共用同一把钥匙,所以任取一台
    /// 已配置的主机的 client 即可;拿不到就跳过(没配 Mac 时本就不需要)。
    private func register(kind: String, token: String) async {
        await sendWithRetry([
            "kind": kind,
            "token": token,
            "bundle_id": Bundle.main.bundleIdentifier ?? "",
            // development 证书发的 token 只能用沙盒网关推,中继据此选网关
            "environment": Self.apsEnvironment,
        ], key: kind)
    }

    /// 登记失败的最多试几次(5 s → 10 s → 20 s → 40 s);之后由下次回前台的 reregisterIfPossible
    /// 或下一次卡片状态推送再登记。
    static let maxRegisterAttempts = 5
    /// ponytail: 每个 Live Activity token 留一个计数,进程内只增不清;卡片数很少,不值得回收。
    private var registerGenerations: [String: Int] = [:]

    /// 发一次登记,中继没回 2xx 就按退避再试。同一个 key 来了新的登记,旧的这轮就不再重发。
    @discardableResult
    private func sendWithRetry(_ payload: [String: Any], key: String) async -> Bool {
        let generation = (registerGenerations[key] ?? 0) &+ 1
        registerGenerations[key] = generation
        for attempt in 1...Self.maxRegisterAttempts {
            if await send(payload) { return true }
            guard attempt < Self.maxRegisterAttempts else { break }
            try? await Task.sleep(for: .seconds(RetryBackoff.delay(failures: attempt, base: 5, cap: 60)))
            guard registerGenerations[key] == generation else { return false }
        }
        return false
    }

    private func send(_ payload: [String: Any]) async -> Bool {
        // 必须挑"配了中继"的主机:第一台若是直连 Mac(relayEventsURL 为
        // nil),token 会静默注册失败,整条 APNs 链路无声失效。
        // 其他三处调用点都已这么写,这里之前漏了。
        guard let client = GatewayHostStore.shared.activeHosts
            .compactMap({ GatewayHostStore.shared.client(for: $0) })
            .first(where: { $0.relayEventsURL != nil }) else { return false }
        return await client.registerPushToken(payload)
    }

    /// 从 entitlement 读 aps-environment —— 用错网关 APNs 直接 400,
    /// 而这个值只有构建时知道,必须由客户端带上去。
    static var apsEnvironment: String {
        #if DEBUG
        return "development"
        #else
        // 侧载的 Release 包用的仍是 development 证书(个人账号无 App Store
        // 分发),所以这里不能想当然写 production。
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .isoLatin1),
              text.contains("<key>aps-environment</key>") else {
            return "development"
        }
        // 描述文件里 aps-environment 紧跟着 <string>…</string>
        if let range = text.range(of: "<key>aps-environment</key>") {
            let tail = text[range.upperBound...].prefix(120)
            if tail.contains("production") { return "production" }
        }
        return "development"
        #endif
    }
}

extension LeoAgentClient {
    /// `DELETE /relay/api/device/activity-token`(本次的 relay.py 才有);返回中继是否回了 2xx。
    func unregisterActivityToken(_ token: String) async -> Bool {
        guard let eventsURL = relayEventsURL,
              let range = eventsURL.absoluteString.range(of: "/relay/api/"),
              let url = URL(string: String(eventsURL.absoluteString[..<range.upperBound]) + "device/activity-token")
        else { return false }
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        req.setValue("Bearer \(apiKeyForRelay)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["token": token])
        req.timeoutInterval = 20
        guard let (_, response) = try? await session.data(for: req),
              let status = (response as? HTTPURLResponse)?.statusCode else { return false }
        return (200..<300).contains(status)
    }

    /// 向中继登记推送 token。中继根地址从 harness 地址推导(与事件端点同法)。
    /// 中继回 2xx 才算登记上(之前不看状态码:401/5xx 也当成功,卡片从此收不到远程更新)。
    func registerPushToken(_ payload: [String: Any]) async -> Bool {
        // 按 relay 根拼,不做字符串替换 —— 与 syncTreasuryChanges 同法:
        // 部署路径本身含 /events 时替换会把地址拼碎。
        guard let eventsURL = relayEventsURL,
              let range = eventsURL.absoluteString.range(of: "/relay/api/"),
              let base = URL(string: String(eventsURL.absoluteString[..<range.upperBound]) + "device")
        else { return false }
        var req = URLRequest(url: base)
        req.httpMethod = "POST"
        req.setValue("Bearer \(apiKeyForRelay)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        req.timeoutInterval = 20
        guard let (_, response) = try? await session.data(for: req),
              let status = (response as? HTTPURLResponse)?.statusCode else { return false }
        return (200..<300).contains(status)
    }
}
