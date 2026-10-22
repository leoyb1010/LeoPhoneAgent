//
//  BrainProfilePublisher.swift
//  MinisApp
//
//  [E1] 把「Leo 画像」发到资料库:记忆文件一变(memory_write / 纠错 / 设置里编辑 /
//  iCloud 合并,都会发 memoryFilesDidChange 或 soulMdChanged)就防抖 60 秒发一次;
//  回到前台时内容指纹和上次发布的不同也发一次。始终更新同一张卡(id + version 存在
//  UserDefaults);版本冲突就重取一次再试。只在资料库连着、令牌有 write:cards 时发。
//

import Foundation

private let profileLog = AppLogger(category: "BrainProfile")

@MainActor
final class BrainProfilePublisher {
    static let shared = BrainProfilePublisher()

    static let debounceNanoseconds: UInt64 = 60 * 1_000_000_000
    /// 403(没有写卡权限)后多久再试。
    static let forbiddenBackoff: TimeInterval = 24 * 3600
    private static let forbiddenUntilKey = "leo.brain.profileCard.forbiddenUntil"

    private var started = false
    private var debounceTask: Task<Void, Never>?
    private var inFlight = false
    private var observers: [NSObjectProtocol] = []

    private init() {}

    /// 回到前台时调(幂等);前台那次检查由 MinisApp 的 scenePhase.active 直接调 publishIfChanged。
    func start() {
        guard !started else { return }
        started = true
        let center = NotificationCenter.default
        for name in [Notification.Name.memoryFilesDidChange, .soulMdChanged] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { _ in
                Task { @MainActor in BrainProfilePublisher.shared.scheduleDebounced() }
            })
        }
    }

    func scheduleDebounced() {
        debounceTask?.cancel()
        debounceTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: Self.debounceNanoseconds)
            guard !Task.isCancelled else { return }
            await self.publishIfChanged(reason: "memory-changed")
        }
    }

    // MARK: Inputs

    nonisolated static func readInputs() -> BrainProfileCard.Inputs {
        let dir = AIChatViewModel.minisMemoryPersistentDir
        var inputs = BrainProfileCard.Inputs()
        if let soul = SoulStore.load() {
            inputs.soulName = soul.metadata.name
            inputs.soulStyle = soul.metadata.style
            inputs.soulBody = soul.body
        }
        if let global = MemoryDailyLog.readPrefix(of: dir.appendingPathComponent("GLOBAL.md"), maxBytes: 8 * 1024) {
            inputs.global = global.text
        }
        inputs.corrections = CorrectionStore.load()
        return inputs
    }

    // MARK: Publish

    func publishIfChanged(reason: String) async {
        let brain = BrainStore.shared
        guard BrainProfileCard.canPublish(configured: brain.isConfigured, knownScopes: brain.knownScopes),
              let gateway = brain.endpoint?.base.absoluteString else { return }
        let defaults = UserDefaults.standard
        if defaults.double(forKey: Self.forbiddenUntilKey) > Date().timeIntervalSince1970 { return }
        guard !inFlight else { return }
        inFlight = true
        defer { inFlight = false }

        let body = await Task.detached(priority: .utility) {
            BrainProfileCard.composeBody(Self.readInputs())
        }.value
        let state = BrainProfileCard.loadState()
        guard BrainProfileCard.shouldPublish(body: body, state: state, gateway: gateway) else { return }

        do {
            let client = try brain.requireClient()
            let previous = state?.gateway == gateway ? state : nil
            let card = try await save(body: body, previous: previous, client: client)
            BrainProfileCard.saveState(BrainProfileCard.State(
                gateway: gateway, cardId: card.id, version: card.version,
                contentHash: BrainProfileCard.contentHash(body),
                status: card.status ?? previous?.status ?? BrainProfileCard.preferredStatus))
            profileLog.info("profile card published (\(reason)) v\(card.version) bytes=\(body.utf8.count)")
        } catch BrainError.forbidden {
            defaults.set(Date().timeIntervalSince1970 + Self.forbiddenBackoff, forKey: Self.forbiddenUntilKey)
            profileLog.info("profile card: token lacks write:cards, backing off")
        } catch {
            profileLog.warning("profile card publish failed (\(reason)): \(String(describing: error))")
        }
    }

    /// 更新同一张卡;409 时取最新版本号再试一次;卡在网关上被删了就新建;
    /// 网关不认 confirmed 状态就退回 reference。
    private func save(body: String, previous: BrainProfileCard.State?, client: BrainClient) async throws -> BrainCard {
        var status = previous?.status ?? BrainProfileCard.preferredStatus
        func draft(id: String?, version: Int?) -> BrainCardDraft {
            BrainCardDraft(id: id, version: version, title: BrainProfileCard.title, body: body,
                           category: BrainProfileCard.category, status: status)
        }
        func attempt(_ d: BrainCardDraft) async throws -> BrainCard {
            do { return try await client.saveCard(d).0 }
            catch BrainError.server(let code, _) where (code == 400 || code == 422) && status != BrainProfileCard.fallbackStatus {
                status = BrainProfileCard.fallbackStatus
                var retry = d
                retry.status = status
                return try await client.saveCard(retry).0
            }
        }
        guard let previous else { return try await attempt(draft(id: nil, version: nil)) }
        do {
            return try await attempt(draft(id: previous.cardId, version: previous.version))
        } catch BrainError.versionConflict {
            let latest = try await client.card(previous.cardId).0
            return try await attempt(draft(id: previous.cardId, version: latest.version))
        } catch BrainError.notFound {
            return try await attempt(draft(id: nil, version: nil))
        }
    }
}
