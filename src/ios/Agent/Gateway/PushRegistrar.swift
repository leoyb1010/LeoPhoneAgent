//
//  PushRegistrar.swift
//  MinisApp
//
//  [T-live-mission] 把这台设备登记到中继,让 Mac 上的事件能在 app
//  完全没运行时也推到锁屏。
//
//  两种 token,用途不同:
//  - device token:普通远程通知。审批请求走它,带「批准一次/拒绝」按钮,
//    锁屏直接按,不用开 app。
//  - push-to-start token(iOS 17.2+):远程拉起 Live Activity。任务开跑时
//    灵动岛/锁屏出现任务卡,后续状态用 activity 自己的 update token 推。
//
//  两者都注册到中继的 /relay/device。中继按 (bundle, token) 去重,
//  设备重装/换机不会留下幽灵 token(APNs 回 410 时中继自行清理)。
//

import Foundation
import UIKit
#if canImport(ActivityKit)
import ActivityKit
#endif

@MainActor
final class PushRegistrar {
    static let shared = PushRegistrar()
    private init() {}

    private var lastDeviceToken: String?
    private var lastPushToStartToken: String?

    /// 启动时调用:请求通知权限并向 APNs 注册。
    func start() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            Task { @MainActor in
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
        observePushToStart()
    }

    /// AppDelegate 的 didRegisterForRemoteNotificationsWithDeviceToken 转进来。
    func handleDeviceToken(_ data: Data) {
        let token = data.map { String(format: "%02x", $0) }.joined()
        guard token != lastDeviceToken else { return }
        lastDeviceToken = token
        Task { await register(kind: "device", token: token) }
    }

    /// [T-live-mission] push-to-start token:iOS 17.2+ 才有。拿到后中继
    /// 就能在任务开跑时远程拉起灵动岛任务卡,不需要 app 在前台。
    private func observePushToStart() {
        #if canImport(ActivityKit)
        guard #available(iOS 17.2, *) else { return }
        guard AgentLiveActivityManager.isLiveActivitySupported else { return }
        Task {
            for await data in Activity<AgentActivityAttributes>.pushToStartTokenUpdates {
                let token = data.map { String(format: "%02x", $0) }.joined()
                await MainActor.run {
                    guard token != self.lastPushToStartToken else { return }
                    self.lastPushToStartToken = token
                    Task { await self.register(kind: "push_to_start", token: token) }
                }
            }
        }
        #endif
    }

    /// 把 token 送到中继。中继与全部 Mac 共用同一把钥匙,所以任取一台
    /// 已配置的主机的 client 即可;拿不到就跳过(没配 Mac 时本就不需要)。
    private func register(kind: String, token: String) async {
        // 必须挑"配了中继"的主机:第一台若是直连 Mac(relayEventsURL 为
        // nil),token 会静默注册失败,整条 APNs 链路无声失效。
        // 其他三处调用点都已这么写,这里之前漏了。
        guard let client = GatewayHostStore.shared.activeHosts
            .compactMap({ GatewayHostStore.shared.client(for: $0) })
            .first(where: { $0.relayEventsURL != nil }) else { return }
        let payload: [String: Any] = [
            "kind": kind,
            "token": token,
            "bundle_id": Bundle.main.bundleIdentifier ?? "",
            // development 证书发的 token 只能用沙盒网关推,中继据此选网关
            "environment": Self.apsEnvironment,
        ]
        await client.registerPushToken(payload)
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
    /// 向中继登记推送 token。中继根地址从 harness 地址推导(与事件端点同法)。
    func registerPushToken(_ payload: [String: Any]) async {
        // 按 relay 根拼,不做字符串替换 —— 与 uploadCollections 同法:
        // 部署路径本身含 /events 时替换会把地址拼碎。
        guard let eventsURL = relayEventsURL,
              let range = eventsURL.absoluteString.range(of: "/relay/api/"),
              let base = URL(string: String(eventsURL.absoluteString[..<range.upperBound]) + "device")
        else { return }
        var req = URLRequest(url: base)
        req.httpMethod = "POST"
        req.setValue("Bearer \(apiKeyForRelay)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        req.timeoutInterval = 20
        _ = try? await session.data(for: req)
    }
}
