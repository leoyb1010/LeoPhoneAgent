//
//  GatewayHostStore.swift
//  MinisApp
//
//  [T-leogateway] Where a gateway host lives on this device.
//
//  Mirrors RemoteHostStore's split deliberately: non-secret metadata in
//  UserDefaults so the Fleet UI can list hosts without a Keychain round-trip,
//  and the access key in the LOCAL Keychain only —
//  kSecAttrAccessibleAfterFirstUnlock and NOT synchronizable, so a gateway
//  key never rides iCloud to another device.
//

import CryptoKit
import Foundation
import Security
import UIKit

struct GatewayHost: Codable, Identifiable, Hashable {
    var id: String = UUID().uuidString.lowercased()
    /// Display name, e.g. "cortex".
    var name: String
    /// Full base URL of the agent ENGINE including scheme and port, e.g.
    /// `https://host.example.ts.net:8645`.
    ///
    /// Must be reached by HOSTNAME: the gateway is fronted by Tailscale's TLS
    /// terminator, which selects its certificate by SNI — connecting to the
    /// bare tailnet IP fails the handshake outright.
    var baseURL: String
    /// Where the LeoAgent HARNESS service lives, e.g. `…ts.net:8647`. A
    /// separate process on a separate port from the engine; one URL cannot
    /// serve both. Optional so hosts saved before this field decode cleanly —
    /// harness features then surface a named setup error instead of
    /// misrouting to the engine.
    var harnessURL: String? = nil
    var isEnabled: Bool = true
    /// Last successful contact, for the reachability dot.
    var lastSeenAt: Date?
    /// From relay `/machines` `info.platform` (android / leoagent).
    var platform: String? = nil
    /// From relay `/machines` `info.server` (minis / leocodebox).
    var server: String? = nil
    var device: LeoDeviceDescriptor? = nil
    var directOnly: Bool? = nil
    var relayServices: GatewayRelayServices? = nil
    /// Local queue ownership; discovery enrichment must not orphan pending input.
    var outboxIdentity: String? = nil
    /// [fix-remote] 这台 Mac 上次报的可开任务类型（/v1/capabilities），菜单据此列出；nil = 还没问过。
    var harnesses: [HarnessKind]? = nil
    /// [fix-remote] SSH 兜底：Mac 在 capabilities 里广播的目标（tailnet 名 + 用户）、设置里改过的、
    /// 以及经已配对的加密通道读到的 sshd 公钥（ssh-ed25519，固定为这台 Mac 的 SSH 身份）。
    var sshTarget: MacSSHTarget? = nil
    var sshTargetOverride: MacSSHTarget? = nil
    var sshHostKey: String? = nil
    /// [e2e] 这台 Mac 的中继加密公钥(base64url,公钥不是秘密)与它的来源(扫码 / 直连 / 经中继首次信任)。
    var relayE2EKey: String? = nil
    var relayE2EKeySource: RelayE2E.KeySource? = nil
    /// [e2e] 和这台 Mac 成功完成过一次加密往返:之后带凭据的请求不再退回明文中继。
    var relayE2EVerified: Bool? = nil

    /// SSH 兜底实际用的目标：设置里填的 → Mac 广播的 → 内置默认（按中继里的机器名）。
    var resolvedSSHTarget: MacSSHTarget? {
        MacSSHTarget.resolve(advertised: sshTarget, override: sshTargetOverride,
                             machine: harnessURL.flatMap { url in url.range(of: "/m/", options: .backwards).map { String(url[$0.upperBound...]) } }
                                ?? device?.aliases?.first ?? id)
    }

    var isAndroidBody: Bool { platform == "android" || server == "minis" }
    /// Mac 1.2 起由 LeoPhoneAgent 自己接中继(`info.server = leophoneagent`):
    /// 能直接开 LeoPhoneAgent 任务(harness `zcode`),也仍能开 Claude Code / Codex / Grok。
    var runsLeoPhoneAgent: Bool { server == "leophoneagent" }

    var url: URL? { URL(string: baseURL) }
    var harnessBase: URL? {
        guard let harnessURL, !harnessURL.isEmpty else { return nil }
        return URL(string: harnessURL)
    }
}

@MainActor
final class GatewayHostStore: ObservableObject {
    static let shared = GatewayHostStore()
    static let storageKey = "leo.gatewayHosts.v1"
    /// nonisolated: the Keychain helpers below are callable from any
    /// context, so this constant must not inherit @MainActor isolation.
    nonisolated private static let keychainService = "com.leoyuan.leophoneagent.gateway"

    @Published private(set) var hosts: [GatewayHost]
    @Published private(set) var routeStatuses: [String: GatewayRouteStatus] = [:]
    /// [e2e] 每台主机经中继的加密状态(连接详情里标「中继：端到端加密 / 未加密 / 钥匙不一致」)。
    enum RelayE2EStatus: Equatable { case encrypted, plaintext, keyMismatch }
    @Published private(set) var relayE2E: [String: RelayE2EStatus] = [:]
    private static let e2eLog = AppLogger(category: "RelayE2E")
    /// [T-link-problem] 每台主机当前的连接问题,以及哪些主机的自动重连 / 轮询已暂停(等用户点主按钮)。
    @Published private(set) var linkBook = LeoLinkProblemBook()
    /// Built clients live here, not in a view body: `client(for:)` does a
    /// synchronous Keychain read and spins up a URLSession, and SwiftUI would
    /// re-run both on every redraw of the host list.
    private var clients: [String: LeoAgentClient] = [:]

    init() {
        if let data = UserDefaults.standard.data(forKey: Self.storageKey),
           let decoded = try? JSONDecoder().decode([GatewayHost].self, from: data) {
            hosts = decoded
        } else {
            hosts = []
        }
        migrateRelayRoots()
        // [up-link] 用 Mac 主钥匙添加的机器换成这台手机自己的设备钥匙：带设备身份才能申请直连授权、才能单独撤销。
        Task { @MainActor [weak self] in await self?.upgradeRelayKeysIfNeeded() }
        // [T-link-problem] 回到前台也算用户回来了:解除所有主机的暂停(见 LeoLinkProblemBook.resumeAll)。
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.resumeAllLinks() }
        }
    }

    /// [fix-remote] 中继换了主入口（Cloudflare 隧道替代 Funnel）：已保存的每台主机一次性改到主入口，
    /// 设备描述符里列出的其他中继入口学进 RelayRootRouter（请求失败时在同组入口间回落）。
    /// 只是同一个中继换了门牌：保留队列归属（outboxIdentity）与设备信息，不当成换了主机。
    private func migrateRelayRoots(router: RelayRootRouter = .shared) {
        let roots = LeoRelayConfig.apiRoots
        var changed = false
        for index in hosts.indices {
            let host = hosts[index]
            if let migrated = RelayRootRouter.migratedHarnessURL(host.harnessURL, primaryRoot: roots.first, group: roots) {
                hosts[index].outboxIdentity = host.outboxIdentity
                    ?? HarnessOutboxIdentity.initial(hostId: host.id, endpoint: host.harnessURL)
                hosts[index].harnessURL = migrated
                if let root = RelayMachinesClient.apiRoot(fromHarnessURL: migrated) {
                    hosts[index].relayServices = GatewayRelayServices(apiRoot: root)
                }
                changed = true
            }
            router.learn(device: hosts[index].device, currentHarnessURL: hosts[index].harnessURL)
        }
        if changed { persist() }
    }

    /// True when the feature should appear at all. Everything gateway-related
    /// stays invisible until the user adds a host — the same additive
    /// guarantee the remote-shell tools follow.
    var isConfigured: Bool { hosts.contains { $0.isEnabled } }

    var activeHosts: [GatewayHost] { hosts.filter(\.isEnabled) }

    /// 你删掉的机器:中继刷新时不再自动加回来(以前一下拉刷新就又出现了)。
    /// 手动添加、扫码、一键添加这类明确的操作会把它恢复(explicit: true)。
    private static let deletedKey = "leo.gatewayHosts.deleted.v1"
    private var deletedIds: Set<String> {
        get { Set(UserDefaults.standard.stringArray(forKey: Self.deletedKey) ?? []) }
        set { UserDefaults.standard.set(Array(newValue), forKey: Self.deletedKey) }
    }

    /// `e2eKey`:扫码配对码里带的 Mac 中继加密公钥(最可信的来源)。
    func upsertDiscovered(_ machines: [RelayDiscoveredMachine], key: String,
                          apiRoot: String, explicit: Bool = false, e2eKey: String? = nil) {
        var changed = false
        for machine in machines {
            guard let name = RelayMachinesClient.sanitizeMachine(machine.name) else { continue }
            let known = machine.device.flatMap { descriptor in hosts.first { $0.device?.deviceId == descriptor.deviceId } }
            let id = known?.id ?? name.lowercased()
            if explicit {
                deletedIds.remove(id)
                if let deviceId = machine.device?.deviceId { deletedIds.remove(deviceId) }
            } else if deletedIds.contains(id) || machine.device.map({ deletedIds.contains($0.deviceId) }) == true {
                continue
            }
            if let old = hosts.first(where: { $0.id == id })?.device, let new = machine.device,
               old.deviceId != new.deviceId { continue }
            let harness = RelayMachinesClient.harnessURL(for: name, apiRoot: apiRoot)
            // [T-relay-keychain-churn] 只在密钥真的变了时才写 Keychain。
            // 原来每台机器无条件写一次:下拉刷新一下就把每台主机的
            // Keychain 项重写一遍(SecItemUpdate/Add 是同步系统调用),
            // 机器多时下拉手感直接被拖住,而绝大多数刷新密钥根本没变。
            if Self.accessKey(hostId: id) != Self.normalizedAccessKey(key) {
                Self.saveAccessKey(key, hostId: id)
                // 换了密钥(重新配对):之前「密钥被拒」之类的结论作废,轮询重新开始。
                recordLinkProblem(nil, for: id)
            }
            if let index = hosts.firstIndex(where: { $0.id == id }) {
                let before = hosts[index]
                let outboxIdentity = HarnessOutboxIdentity.next(existing: before.outboxIdentity, hostId: before.id,
                    previousEndpoint: before.harnessURL, previousDeviceId: before.device?.deviceId,
                    endpoint: harness, deviceId: machine.device?.deviceId ?? before.device?.deviceId,
                    authenticatedDiscovery: true)
                if hosts[index].outboxIdentity != outboxIdentity {
                    hosts[index].outboxIdentity = outboxIdentity
                    changed = true
                }
                RelayRootRouter.shared.learn(device: machine.device, currentHarnessURL: harness)
                if let device = machine.device, hosts[index].device != device {
                    hosts[index].device = device
                    clients.removeValue(forKey: id)
                    changed = true
                }
                if before.harnessURL != harness {
                    hosts[index].harnessURL = harness
                    hosts[index].directOnly = false
                    hosts[index].relayServices = GatewayRelayServices(apiRoot: apiRoot)
                    clients.removeValue(forKey: id)
                    changed = true
                }
                if let e2eKey, RelayE2E.validKey(e2eKey) != nil, hosts[index].relayE2EKey != e2eKey {
                    hosts[index].relayE2EKey = e2eKey
                    hosts[index].relayE2EKeySource = .qr
                    clients.removeValue(forKey: id)
                    changed = true
                }
                if let platform = machine.platform, hosts[index].platform != platform {
                    hosts[index].platform = platform
                    changed = true
                }
                if let server = machine.server, hosts[index].server != server {
                    hosts[index].server = server
                    changed = true
                }
                // Keep isEnabled, display name, and engine URL — refresh must
                // not turn a disabled machine back on or wipe a rename.
            } else {
                hosts.append(GatewayHost(
                    id: id,
                    name: machine.isAndroidBody ? name : RelayMachinesClient.displayName(for: name),
                    baseURL: "",
                    harnessURL: harness,
                    platform: machine.platform,
                    server: machine.server,
                    device: machine.device,
                    relayServices: GatewayRelayServices(apiRoot: apiRoot),
                    outboxIdentity: HarnessOutboxIdentity.newOwner(),
                    relayE2EKey: RelayE2E.validKey(e2eKey) == nil ? nil : e2eKey,
                    relayE2EKeySource: RelayE2E.validKey(e2eKey) == nil ? nil : .qr
                ))
                changed = true
            }
        }
        if changed {
            persist()
            PushRegistrar.shared.reregisterIfPossible()
        }
    }

    func upsert(_ host: GatewayHost) {
        deletedIds.remove(host.id)
        var saved = host
        if let index = hosts.firstIndex(where: { $0.id == host.id }) {
            let previous = hosts[index]
            // Older editor drafts omit discovered metadata. A name-only edit
            // must not discard the verified device or reset queue ownership.
            if previous.harnessURL == host.harnessURL && previous.baseURL == host.baseURL {
                saved.device = host.device ?? previous.device
                saved.platform = host.platform ?? previous.platform
                saved.server = host.server ?? previous.server
                saved.directOnly = host.directOnly ?? previous.directOnly
                saved.relayServices = host.relayServices ?? previous.relayServices
                saved.harnesses = host.harnesses ?? previous.harnesses
                saved.sshTarget = host.sshTarget ?? previous.sshTarget
                saved.sshHostKey = host.sshHostKey ?? previous.sshHostKey
                saved.relayE2EKey = host.relayE2EKey ?? previous.relayE2EKey
                saved.relayE2EKeySource = host.relayE2EKeySource ?? previous.relayE2EKeySource
                saved.relayE2EVerified = host.relayE2EVerified ?? previous.relayE2EVerified
            }
            // 设置里填的 SSH 兜底目标跟着编辑走；没填就保留原来的。
            saved.sshTargetOverride = host.sshTargetOverride ?? previous.sshTargetOverride
            saved.outboxIdentity = HarnessOutboxIdentity.next(existing: previous.outboxIdentity, hostId: host.id,
                previousEndpoint: previous.harnessURL, previousDeviceId: previous.device?.deviceId,
                endpoint: saved.harnessURL, deviceId: saved.device?.deviceId)
            hosts[index] = saved
        } else {
            // Re-adding a deleted host is a new owner, even if its display/URL
            // matches an old one. Do not adopt retired pending input by name.
            saved.outboxIdentity = HarnessOutboxIdentity.newOwner()
            hosts.append(saved)
        }
        clients.removeValue(forKey: host.id)   // address or key may have changed
        recordLinkProblem(nil, for: host.id)   // 地址或密钥可能改了:旧的连接结论不再可信
        persist()
        PushRegistrar.shared.reregisterIfPossible()
    }

    func delete(id: String) {
        deletedIds.insert(id)
        if let deviceId = hosts.first(where: { $0.id == id })?.device?.deviceId { deletedIds.insert(deviceId) }
        // 分享扩展「发给 Mac 当前任务」指着这台:一并清掉目标和 App Group 里的钥匙,别再拿旧钥匙往删掉的 Mac 发。
        if let host = hosts.first(where: { $0.id == id }), let target = ShareMacTarget.load(),
           target.relayBase == host.harnessURL || (target.directDeviceId != nil && target.directDeviceId == host.device?.deviceId) {
            ShareMacTarget.clear()
        }
        hosts.removeAll { $0.id == id }
        clients.removeValue(forKey: id)
        relayE2E.removeValue(forKey: id)
        recordLinkProblem(nil, for: id)
        Self.deleteKey(hostId: id)
        Self.deleteKey(hostId: id + ".direct")
        persist()
    }

    func hostMatching(hostId: String = "", machine: String) -> GatewayHost? {
        guard let index = RelayMachinesClient.pickHostIndex(
            hostIds: hosts.map(\.id),
            displayNames: hosts.map(\.name),
            hostId: hostId,
            machine: machine
        ) else { return nil }
        return hosts[index]
    }

    func pairDirect(_ pair: DirectPairPayload, name: String) async throws -> GatewayHost {
        guard let url = URL(string: pair.apiRoot.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/direct-pair") else { throw GatewayError.badURL }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["join": pair.join, "targetDeviceId": pair.deviceId, "name": name])
        let session = URLSession(configuration: .ephemeral, delegate: GatewayNoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let route = DirectDeviceRoute.decode(data, expectedDeviceId: pair.deviceId),
              let endpoint = route.endpoint() else { throw GatewayError.unauthorized }
        // An explicit trusted UUID may match an existing device; a display name/IP never may.
        if let existing = hosts.first(where: { $0.device?.deviceId == pair.deviceId }) {
            guard let json = String(data: data, encoding: .utf8), Self.saveAccessKey(json, hostId: existing.id + ".direct") else { throw GatewayError.unauthorized }
            clients.removeValue(forKey: existing.id)
            return existing
        }
        let host = GatewayHost(id: pair.deviceId, name: route.device.name, baseURL: "", harnessURL: endpoint.absoluteString,
                               platform: route.device.platform, server: "leophoneagent", device: route.device, directOnly: true)
        guard let json = String(data: data, encoding: .utf8), Self.saveAccessKey(json, hostId: host.id + ".direct"),
              Self.saveAccessKey(route.grant.token, hostId: host.id) else { throw GatewayError.unauthorized }
        upsert(host)
        return host
    }

    func recordRoute(id: String, status: GatewayRouteStatus, device: LeoDeviceDescriptor? = nil) {
        // Called per request; publish only visible changes so observing views
        // (chat, host list) don't re-render on every HTTP call.
        let old = routeStatuses[id]
        if old == nil || old!.direct != status.direct || old!.available != status.available ||
            (old!.failedAt == nil) != (status.failedAt == nil) ||
            abs((old!.latencyMilliseconds ?? -1000) - (status.latencyMilliseconds ?? -1000)) >= 100 {
            routeStatuses[id] = status
        }
        if let device, device.valid, let index = hosts.firstIndex(where: { $0.id == id }), hosts[index].device != device,
           hosts[index].device == nil || hosts[index].device?.deviceId == device.deviceId {
            hosts[index].device = device
            persist()
        }
    }

    /// [fix-remote] 记下 capabilities 里对手机有用的事实：可开的任务类型、SSH 兜底目标与 sshd 公钥。
    /// 公钥只认 ssh-ed25519（Citadel 只能固定这一种），来源是已配对、已鉴权的通道。
    func recordCapabilities(id: String, kinds: [HarnessKind], ssh: MacSSHTarget?, hostKeys: [String]) {
        guard let index = hosts.firstIndex(where: { $0.id == id }) else { return }
        var host = hosts[index]
        if !kinds.isEmpty { host.harnesses = kinds }
        if let ssh { host.sshTarget = ssh }
        if let key = hostKeys.first(where: { $0.hasPrefix("ssh-ed25519 ") }) { host.sshHostKey = key }
        guard host != hosts[index] else { return }
        hosts[index] = host
        persist()
    }

    /// [e2e] 固定 Mac 的中继加密公钥。返回这台主机现在用的是不是这把(换上了或本来就是)。
    func pinRelayE2EKey(id: String, key: String, source: RelayE2E.KeySource) -> Bool {
        guard let index = hosts.firstIndex(where: { $0.id == id }) else { return false }
        let host = hosts[index]
        if host.relayE2EKey == key { return true }
        guard RelayE2E.shouldPin(current: host.relayE2EKey, currentSource: host.relayE2EKeySource, new: key, source: source)
        else {
            if source == .relay, host.relayE2EKey != nil {
                // 中继递来的和已固定的不一样:不换(可能是 Mac 换了钥匙,也可能是中继在换钥匙),等直连或扫码来修。
                Self.e2eLog.warning("relay e2e key mismatch for host \(id); keeping pinned key until direct/QR")
                if relayE2E[id] != .keyMismatch { relayE2E[id] = .keyMismatch }
            }
            return false
        }
        hosts[index].relayE2EKey = key
        hosts[index].relayE2EKeySource = source
        if relayE2E[id] == .keyMismatch { relayE2E.removeValue(forKey: id) }
        persist()
        return true
    }

    /// 钥匙不一致是要用户直连一次才消的结论:之后的明文请求不把它冲成「未加密」。
    func recordRelayE2E(id: String, encrypted: Bool) {
        let next: RelayE2EStatus = encrypted ? .encrypted : (relayE2E[id] == .keyMismatch ? .keyMismatch : .plaintext)
        if relayE2E[id] != next { relayE2E[id] = next }
        if encrypted, let index = hosts.firstIndex(where: { $0.id == id }), hosts[index].relayE2EVerified != true {
            hosts[index].relayE2EVerified = true
            persist()
        }
    }

    func setSSHTargetOverride(_ target: MacSSHTarget?, for id: String) {
        guard let index = hosts.firstIndex(where: { $0.id == id }) else { return }
        hosts[index].sshTargetOverride = target
        persist()
    }

    // MARK: - [fix-remote] 路径（直连 / 中继 / SSH）

    @Published private(set) var routeSelectors: [String: MacRouteSelector] = [:]
    /// 直连探测失败且地址被解析成 198.18.x（代理 App 的 fake-ip）的主机：界面给出小火箭规则。
    @Published private(set) var fakeIPHosts: Set<String> = []

    func recordPath(id: String, route: MacRoute, success: Bool, latencyMilliseconds: Int? = nil) {
        var selector = routeSelectors[id] ?? MacRouteSelector()
        let before = selector
        selector.record(route, success: success, latencyMilliseconds: latencyMilliseconds)
        // 延迟抖动不重绘：只在路换了或延迟变化 ≥100ms 时发布。
        if before.current != selector.current || abs((before.latencyMilliseconds ?? -1000) - (selector.latencyMilliseconds ?? -1000)) >= 100
            || before.lastFailure != selector.lastFailure {
            routeSelectors[id] = selector
        }
    }

    func markFakeIP(_ hostId: String, detected: Bool) {
        if detected { fakeIPHosts.insert(hostId) } else if fakeIPHosts.contains(hostId) { fakeIPHosts.remove(hostId) }
    }

    func markSeen(id: String) {
        guard let index = hosts.firstIndex(where: { $0.id == id }) else { return }
        hosts[index].lastSeenAt = Date()
        recordLinkProblem(nil, for: id)   // 刚联系上:有问题也已经好了
        persist()
    }

    // MARK: - [T-link-problem] 连接问题与暂停

    func linkProblem(for hostId: String) -> LeoLinkProblem? { linkBook.problem(for: hostId) }

    /// 要用户处理的问题(密钥被拒、Mac 撤销授权…)会让这台主机的自动重连 / 轮询暂停。
    func isLinkPaused(_ hostId: String) -> Bool { linkBook.isPaused(hostId) }

    /// 记下 / 清掉这台主机的连接问题。轮询和探测每次都会调,所以只在真的变了才发布,
    /// 否则观察它的列表会跟着每次探测重绘。
    func recordLinkProblem(_ problem: LeoLinkProblem?, for hostId: String) {
        var next = linkBook
        next.record(problem, for: hostId)
        if next != linkBook { linkBook = next }
    }

    /// 用户点了主按钮:解除暂停。问题继续显示,直到下一次探测给出结论。
    func resumeLink(_ hostId: String) {
        var next = linkBook
        next.resume(hostId)
        if next != linkBook { linkBook = next }
    }

    func resumeAllLinks() {
        var next = linkBook
        next.resumeAll()
        if next != linkBook { linkBook = next }
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(hosts) else { return }
        UserDefaults.standard.set(data, forKey: Self.storageKey)
    }

    /// Build a client for a host, or nil when its key is missing.
    func client(for requestedHost: GatewayHost) -> LeoAgentClient? {
        // A view may hold a pre-edit host value across an await. Resolve the
        // current configured destination before using/cache-building its client.
        guard let host = hosts.first(where: { $0.id == requestedHost.id }) else { return nil }
        if let cached = clients[host.id] { return cached }
        guard let key = Self.accessKey(hostId: host.id), !key.isEmpty else { return nil }
        // Second line of defence behind the editor's validation: hand-edited
        // UserDefaults or an older record must not get a cleartext client.
        // https-only on both addresses; a cleartext one is dropped here rather
        // than allowed to carry the key.
        var engine = host.url
        if engine?.scheme?.lowercased() != "https" || engine?.host == nil { engine = nil }
        var harnessBase = host.harnessBase
        if harnessBase?.scheme?.lowercased() != "https" || harnessBase?.host == nil { harnessBase = nil }
        // 只控编码 CLI 的主机可以不配引擎地址;engine 调用会打到 harness 服务
        // 并返回明确错误,而不是让整台主机在 UI 里消失。
        guard let base = engine ?? harnessBase else { return nil }
        let services = host.relayServices ?? host.harnessURL.flatMap {
            RelayMachinesClient.apiRoot(fromHarnessURL: $0).flatMap { GatewayRelayServices(apiRoot: $0) }
        }
        let outboxIdentity = host.outboxIdentity ?? HarnessOutboxIdentity.initial(hostId: host.id, endpoint: host.harnessURL)
        if let index = hosts.firstIndex(where: { $0.id == host.id }), hosts[index].outboxIdentity == nil {
            // Views call client(for:) from body; publish the backfill on the next turn.
            Task { @MainActor [weak self] in
                guard let self, let i = self.hosts.firstIndex(where: { $0.id == host.id }), self.hosts[i].outboxIdentity == nil else { return }
                self.hosts[i].outboxIdentity = outboxIdentity
                self.persist()
            }
        }
        let built = LeoAgentClient(baseURL: base, apiKey: key, harnessBaseURL: harnessBase,
                                   hostId: host.id, hostName: host.name, supportsDirectDiscovery: host.runsLeoPhoneAgent, expectedDeviceId: host.device?.deviceId, directOnly: host.directOnly == true, relayServices: services,
                                   outboxIdentity: outboxIdentity, relayE2EKey: host.relayE2EKey,
                                   relayE2EVerified: host.relayE2EVerified == true)
        clients[host.id] = built
        // [fix-remote] 建好 client 就在后台问一次 capabilities：可开的 agent 列表、SSH 兜底目标与 sshd 公钥都记下来，
        // 之后直连与中继都不通时 SSH 兜底才有固定好的主机身份可用。
        if !host.isAndroidBody { Task.detached { _ = try? await built.harnessKinds() } }
        return built
    }

    /// One shared entry point for Treasury sync/read-through. Providers and
    /// views must not each invent their own relay selection or key handling.
    func treasuryRelayClient() -> LeoAgentClient? {
        activeHosts
            .compactMap { client(for: $0) }
            .first { $0.relayEventsURL != nil }
    }

    // MARK: - Keychain (local only, never synchronized)

    nonisolated static func accessKey(hostId: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: hostId,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// 清洗复制残渣:终端复制常带上 zsh 行尾标记 % 或换行,密钥本身
    /// 不含这些字符。中继侧同样容错,这里洗干净是双保险。
    /// 抽成函数是为了让「要不要写 Keychain」的比较用的是同一套规范化,
    /// 否则每次刷新都会因为 raw 与已存值差一个空白字符而重复落盘。
    nonisolated static func normalizedAccessKey(_ rawKey: String) -> String {
        rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "%"))
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @discardableResult
    nonisolated static func saveAccessKey(_ rawKey: String, hostId: String) -> Bool {
        let key = normalizedAccessKey(rawKey)
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: hostId,
        ]
        var add = base
        add[kSecValueData as String] = Data(key.utf8)
        // AfterFirstUnlock so a background refresh after a reboot still works;
        // no kSecAttrSynchronizable, so this never leaves the device.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

        var status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecDuplicateItem {
            status = SecItemUpdate(base as CFDictionary,
                                   [kSecValueData as String: Data(key.utf8)] as CFDictionary)
        }
        return status == errSecSuccess
    }

    nonisolated static func deleteKey(hostId: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: hostId,
        ]
        SecItemDelete(query as CFDictionary)
    }

    // MARK: - Reachability

    /// Probe a host without touching its key: /health is unauthenticated, so a
    /// failure here means "unreachable", not "wrong key" — the two need
    /// different fixes and the UI should not conflate them.
    nonisolated static func probe(_ host: GatewayHost) async -> Bool {
        await diagnose(host) == nil
    }

    /// 同一次探测,失败时带回「谁的问题 + 一个按钮」;nil = 连得通。
    /// 判定与 probe 完全一致(probe 就是 diagnose == nil),只是不再把原因丢掉。
    nonisolated static func diagnose(_ host: GatewayHost) async -> LeoLinkProblem? {
        // 引擎地址可留空(只控编码 CLI 的主机):/health 两个服务都有,
        // 用哪个可用的地址探测都成立。
        let engineValid = host.url.flatMap { $0.host != nil ? $0 : nil }
        let context = { (base: URL?) in
            LeoLinkProblem.Context(.session, host: base?.host, machineName: host.name)
        }
        guard let base = engineValid ?? host.harnessBase else {
            return LeoLinkProblem.from(error: GatewayError.badURL, context: context(nil))
        }
        // relay 地址自带路径前缀,绝对路径 resolve 会把它吞掉——拼接。
        var parts = URLComponents(url: base, resolvingAgainstBaseURL: false)
        let basePath = base.path.hasSuffix("/") ? String(base.path.dropLast()) : base.path
        parts?.path = basePath + "/health"
        guard let url = parts?.url else {
            return LeoLinkProblem.from(error: GatewayError.badURL, context: context(base))
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 8
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: req)
        } catch {
            return LeoLinkProblem.from(error: error, context: context(base))
        }
        guard let http = response as? HTTPURLResponse else {
            return LeoLinkProblem.from(error: GatewayError.malformedResponse("not an HTTP response"), context: context(base))
        }
        // 401/403 = 服务在、只是这条路径要钥匙(relay 的机器路径就是这样)。
        // 可达性问的是"那头有没有人",不是"钥匙对不对"。
        if http.statusCode == 401 || http.statusCode == 403 { return nil }
        guard http.statusCode == 200 else {
            return LeoLinkProblem.from(error: GatewayError.http(status: http.statusCode, message: nil), context: context(base))
        }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (obj["status"] as? String) == "ok"
        else {
            return LeoLinkProblem.from(error: GatewayError.malformedResponse("health payload"), context: context(base))
        }
        return nil
    }
}


// MARK: - [up-link] 主钥匙 → 设备钥匙

extension GatewayHostStore {
    private static let relayKeyLog = AppLogger(category: "RelayDeviceKey")

    /// 以前按「访问密钥 = Mac 上 ~/.leoagent/key」添加的机器，用的是中继主钥匙：中继认不出是哪台手机，
    /// Mac 因此拒绝给它发直连授权（静默 403），手机永远走中继。这里用中继自带的 /device/exchange
    /// 把主钥匙换成这台手机自己的设备钥匙（主钥匙本身不变、其他设备不受影响），每组（中继根 + 钥匙）只试一次。
    func upgradeRelayKeysIfNeeded() async {
        var groups: [String: (root: String, key: String, hostIds: [String])] = [:]
        for host in hosts {
            guard let root = RelayMachinesClient.apiRoot(fromHarnessURL: host.harnessURL),
                  let key = Self.accessKey(hostId: host.id), !key.isEmpty else { continue }
            let tag = Self.relayKeyTag(root: root, key: key)
            groups[tag, default: (root, key, [])].hostIds.append(host.id)
        }
        let defaults = UserDefaults.standard
        for (tag, group) in groups {
            let checkedKey = "leo.relayDeviceKey.checked." + tag
            guard !defaults.bool(forKey: checkedKey),
                  let url = URL(string: group.root + "/device/exchange") else { continue }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.timeoutInterval = 10
            request.setValue("Bearer \(group.key)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: ["name": UIDevice.current.name])
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if status == 200,
                   let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let newKey = obj["accessKey"] as? String, !newKey.isEmpty {
                    for id in group.hostIds {
                        Self.saveAccessKey(newKey, hostId: id)
                        clients.removeValue(forKey: id)
                    }
                    defaults.set(true, forKey: "leo.relayDeviceKey.checked." + Self.relayKeyTag(root: group.root, key: newKey))
                    Self.relayKeyLog.info("exchanged master key for a device key on \(group.hostIds.count) host(s)")
                }
                // 200 = 换好了；401/403 = 已经是设备钥匙（或主钥匙已过期）：都不用再试。其余状态下次启动再试。
                if [200, 401, 403].contains(status) { defaults.set(true, forKey: checkedKey) }
            } catch {
                Self.relayKeyLog.info("device key exchange deferred: \(error.localizedDescription)")
            }
        }
    }

    nonisolated static func relayKeyTag(root: String, key: String) -> String {
        let digest = SHA256.hash(data: Data((root.lowercased() + "|" + key).utf8))
        return digest.prefix(12).map { String(format: "%02x", $0) }.joined()
    }
}
