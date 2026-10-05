import Combine
import Foundation
import WebKit

@MainActor
final class PaperclipWorkspaceStore: ObservableObject {
    @Published private(set) var profiles: [PaperclipProfile] = []
    @Published private(set) var selectedID: UUID?
    @Published private(set) var user: PaperclipUser?
    @Published private(set) var companies: [PaperclipCompany] = []
    @Published private(set) var issues: [PaperclipIssue] = []
    @Published private(set) var agents: [PaperclipAgent] = []
    @Published private(set) var busy = false
    @Published var error: String?
    @Published private(set) var companyID = ""
    @Published private(set) var hasMore = false
    /// 公司内有运行中 run 的任务（列表“运行中”标识）。
    @Published private(set) var liveIssueIDs: Set<String> = []
    /// 当前公司的实时通道；身份或公司变化时一律断开并置空。
    @Published private(set) var live: PaperclipLiveConnection?
    @Published private(set) var liveState: PaperclipLiveConnection.State = .idle
    private(set) var client: PaperclipClient?
    private var foreground = true
    private var liveSubscriptions: Set<AnyCancellable> = []
    private var listRefreshTask: Task<Void, Never>?
    /// 任务列表是否在屏幕上。进入详情页后列表不可见：事件带来的列表刷新推迟到返回列表时做一次，
    /// 以前详情页打开期间公司内每条评论、运行状态都会触发一次三请求的列表刷新。
    private var listVisible = true
    private var listStale = false
    private let makeLiveSocket: (@MainActor (URLRequest) -> PaperclipLiveSocket)?
    private var revision = UUID()
    private var nextOffset = 0
    private var cookieVaults: [UUID: PaperclipCookieVault] = [:]
    private var connectTask: (token: UUID, task: Task<Bool, Never>)?
    private let makeConfiguration: @MainActor () -> URLSessionConfiguration
    private let defaults: UserDefaults
    private let makeCookieVault: @MainActor (PaperclipProfile) -> PaperclipCookieVault
    private static let profilesKey = "leo.paperclip.profiles.v1"
    private static let selectionKey = "leo.paperclip.selectedProfile.v1"

    init(defaults: UserDefaults = .standard,
         makeCookieVault: @escaping @MainActor (PaperclipProfile) -> PaperclipCookieVault = {
             PaperclipCookieVault.shared(for: $0)
         }, makeConfiguration: @escaping @MainActor () -> URLSessionConfiguration = { .ephemeral },
         makeLiveSocket: (@MainActor (URLRequest) -> PaperclipLiveSocket)? = nil) {
        self.makeLiveSocket = makeLiveSocket
        self.defaults = defaults
        self.makeCookieVault = makeCookieVault
        self.makeConfiguration = makeConfiguration
        if let data = defaults.data(forKey: Self.profilesKey),
           let saved = try? JSONDecoder().decode([PaperclipProfile].self, from: data) {
            profiles = saved.compactMap { try? $0.validated() }
        }
        selectedID = defaults.string(forKey: Self.selectionKey).flatMap(UUID.init(uuidString:))
        if !profiles.contains(where: { $0.id == selectedID }) { selectedID = profiles.first?.id }
    }

    var selectedProfile: PaperclipProfile? { profiles.first { $0.id == selectedID } }
    var identityKey: String { "\(selectedID?.uuidString ?? "")/\(companyID)/\(user?.id ?? "")" }

    static func websiteData(for profile: PaperclipProfile) -> WKWebsiteDataStore {
        // 每个不可变配置有独立、设备本地的浏览器容器，不使用系统共享 Cookie。
        WKWebsiteDataStore(forIdentifier: profile.id)
    }

    func add(name: String, address: String) throws {
        let profile = try PaperclipProfile(name: name, address: address)
        profiles.append(profile)
        defaults.set(try JSONEncoder().encode(profiles), forKey: Self.profilesKey)
        select(profile.id)
    }

    /// 删除服务器配置：先尽力撤销服务器会话，再清除并释放此配置的浏览器容器与本机记录。
    func remove(_ id: UUID) async {
        guard let profile = profiles.first(where: { $0.id == id }) else { return }
        if selectedID == id { resetConnection() }
        busy = true
        let vault = vault(for: profile)
        await signOut(profile: profile, vault: vault)
        await vault.clear()
        busy = false
        cookieVaults[id] = nil
        PaperclipCookieVault.forget(id)
        profiles.removeAll { $0.id == id }
        defaults.set(try? JSONEncoder().encode(profiles), forKey: Self.profilesKey)
        // 草稿、待核实状态、公司选择都以配置编号为键，配置删除后不再可核对，一并清除。
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix("leo.paperclip.") && key.contains(id.uuidString) {
            defaults.removeObject(forKey: key)
        }
        if selectedID == id {
            if let next = profiles.first { select(next.id) }
            else { selectedID = nil; defaults.removeObject(forKey: Self.selectionKey) }
        }
        // WebKit 仍有视图使用该容器时会拒绝删除；数据已清空，失败不影响配置删除。
        try? await WKWebsiteDataStore.remove(forIdentifier: id)
    }

    func select(_ id: UUID) {
        guard profiles.contains(where: { $0.id == id }) else { return }
        resetConnection()
        selectedID = id
        defaults.set(id.uuidString, forKey: Self.selectionKey)
    }

    private func resetConnection() {
        stopLive()
        revision = UUID()
        busy = false
        connectTask = nil
        client?.invalidate()
        client = nil
        user = nil
        companyID = ""
        companies = []
        issues = []
        agents = []
        error = nil
        hasMore = false
        nextOffset = 0
        liveIssueIDs = []
    }

    func clearLogin() async {
        guard let profile = selectedProfile else { return }
        resetConnection()
        let stamp = revision
        busy = true
        let vault = vault(for: profile)
        // 先尽力撤销服务器会话（失败不阻塞），再清本机 Cookie；否则服务器端会话仍可被复用。
        await signOut(profile: profile, vault: vault)
        await vault.clear()
        guard stamp == revision, selectedID == profile.id else { return }
        busy = false
    }

    private func signOut(profile: PaperclipProfile, vault: PaperclipCookieVault) async {
        let generation = vault.generation
        // 独立临时客户端：工作区客户端已失效；不写回服务器下发的过期 Cookie。
        let client = PaperclipClient(profile: profile, configuration: makeConfiguration(), readCookies: {
            await vault.read(generation: generation)
        })
        await client.signOut()
        client.invalidate()
    }

    /// 并发调用（登录页验证与工作区自动连接）共享同一次连接，返回它的真实结果，不再因 busy 误报失败。
    @discardableResult
    func connect() async -> Bool {
        if let running = connectTask { return await running.task.value }
        // 刷新或清除登录进行中：等它结束再连接，不与之并发改写列表状态。
        while busy && connectTask == nil {
            do { try await Task.sleep(for: .milliseconds(100)) } catch { return false }
        }
        if let running = connectTask { return await running.task.value }
        guard selectedProfile != nil else { return false }
        let token = UUID()
        let task = Task { @MainActor in await self.performConnect() }
        connectTask = (token, task)
        let result = await task.value
        if connectTask?.token == token { connectTask = nil }
        return result
    }

    private func performConnect() async -> Bool {
        guard let profile = selectedProfile else { return false }
        let stamp = revision
        busy = true
        error = nil
        let cookies = vault(for: profile)
        let generation = cookies.generation
        let candidate = PaperclipClient(profile: profile, configuration: makeConfiguration(), readCookies: {
            await cookies.read(generation: generation)
        }, saveCookies: { updated in
            await cookies.write(updated, generation: generation)
        })
        do {
            _ = try await candidate.health()
            let session = try await candidate.humanSession()
            let available = try await candidate.companies(userID: session.user.id)
            guard stamp == revision else { return false }
            client = candidate
            user = session.user
            companies = available
            let preferred = defaults.string(forKey: companyKey(profile: profile, user: session.user.id))
            companyID = available.first(where: { $0.id == preferred })?.id ?? available.first?.id ?? ""
            busy = false
            if !companyID.isEmpty {
                await refresh()
                startLive()
            }
            return user != nil
        } catch {
            guard stamp == revision else { return false }
            self.error = PaperclipLabels.error(error)
            if error as? PaperclipError == .signedOut || error as? PaperclipError == .identityChanged {
                stopLive()
                client?.invalidate()
                client = nil
                user = nil
                issues = []
                agents = []
            }
            busy = false
            return false
        }
    }

    func selectCompany(_ id: String) async {
        guard companies.contains(where: { $0.id == id }), let profile = selectedProfile, let user else { return }
        // 公司变化：旧公司的实时通道立即断开，事件不能落到新公司页面。
        stopLive()
        revision = UUID()
        busy = false
        issues = []
        agents = []
        liveIssueIDs = []
        companyID = id
        nextOffset = 0
        hasMore = false
        defaults.set(id, forKey: companyKey(profile: profile, user: user.id))
        await refresh()
        startLive()
    }

    func refresh(loadMore: Bool = false) async {
        guard !busy, let client, let user, !companyID.isEmpty else { return }
        let stamp = revision
        let company = companyID
        let offset = loadMore ? nextOffset : 0
        busy = true
        // 三个读请求并行、各自独立更新：以前串行且任一失败整次作废。
        // 刷新只重读第一页；后续页保留，按 id 合并。
        async let issueRows = Self.capture { try await client.issues(companyID: company, userID: user.id, offset: offset) }
        async let agentRows = Self.capture { try await client.agents(companyID: company, userID: user.id) }
        async let runRows = Self.capture { try await client.companyLiveRuns(companyID: company, userID: user.id) }
        let (issuesResult, agentsResult, runsResult) = await (issueRows, agentRows, runRows)
        guard stamp == revision else { return }
        var failure: Error?
        switch issuesResult {
        case .success(let rows):
            if loadMore {
                let known = Set(issues.map(\.id))
                issues += rows.filter { !known.contains($0.id) }
                nextOffset = offset + rows.count
                hasMore = !rows.isEmpty && rows.count.isMultiple(of: 100)
            } else if issues.count > 100 {
                issues = PaperclipPollingPolicy.merge(firstPage: rows, into: issues)
                nextOffset = max(nextOffset, rows.count)
            } else {
                issues = rows
                nextOffset = rows.count
                hasMore = !rows.isEmpty && rows.count.isMultiple(of: 100)
            }
        case .failure(let error): failure = error
        }
        switch agentsResult {
        case .success(let rows): agents = rows
        case .failure(let error): failure = failure ?? error
        }
        switch runsResult {
        case .success(let rows): liveIssueIDs = Set(rows.compactMap(\.issueId))
        case .failure(let error):
            // 运行遥测需要额外权限；403 只是不显示“运行中”标识，不算同步失败。
            if (error as? PaperclipError)?.underlying != .forbidden { failure = failure ?? error }
        }
        if let failure {
            self.error = PaperclipLabels.error(failure)
            // 过期或切换账号后不继续显示旧账号内容。
            let reason = (failure as? PaperclipError)?.underlying
            if reason == .signedOut || reason == .identityChanged { invalidateSession() }
        } else {
            error = nil
        }
        if stamp == revision { busy = false }
    }

    private static func capture<T>(_ work: @MainActor () async throws -> T) async -> Result<T, Error> {
        do { return .success(try await work()) } catch { return .failure(error) }
    }

    /// 登录失效或身份变化：断开实时通道、作废客户端并清掉旧账号内容。
    private func invalidateSession() {
        stopLive()
        user = nil
        client?.invalidate()
        client = nil
        issues = []
        agents = []
        liveIssueIDs = []
    }

    // MARK: - 实时通道

    /// 前后台切换：离开前台主动断开；回到前台重新确认身份、连接并全量补拉。
    func setForeground(_ active: Bool) async {
        guard active != foreground else { return }
        foreground = active
        if active {
            await refresh()
            startLive()
        } else {
            live?.stop()
        }
    }

    private func startLive() {
        guard foreground, let client, let user, let profile = selectedProfile, !companyID.isEmpty,
              client.profile.id == profile.id else { return }
        if let live, live.companyID == companyID, live.userID == user.id, live.profile.id == profile.id {
            live.resumeFromBackground()
            return
        }
        stopLive()
        let company = companyID
        let userID = user.id
        let connection: PaperclipLiveConnection
        if let makeLiveSocket {
            connection = PaperclipLiveConnection(profile: profile, companyID: company, userID: userID,
                makeRequest: { try await client.liveSocketRequest(companyID: company, userID: userID) },
                makeSocket: makeLiveSocket)
        } else {
            connection = PaperclipLiveConnection(profile: profile, companyID: company, userID: userID,
                makeRequest: { try await client.liveSocketRequest(companyID: company, userID: userID) })
        }
        let stamp = revision
        connection.$state.sink { [weak self] state in
            guard let self, self.revision == stamp, self.live === connection else { return }
            self.liveState = state
            if case .stopped(let reason) = state, reason == .signedOut || reason == .identityChanged {
                // 身份确认来自新鲜 get-session：与 REST 失效同样处理，提示重新登录。
                self.error = PaperclipLabels.error(reason == .signedOut ? PaperclipError.signedOut : PaperclipError.identityChanged)
                self.invalidateSession()
            }
        }.store(in: &liveSubscriptions)
        connection.events.sink { [weak self] event in
            guard let self, self.revision == stamp, self.live === connection else { return }
            self.handle(event)
        }.store(in: &liveSubscriptions)
        connection.reconnected.dropFirst().sink { [weak self] in
            guard let self, self.revision == stamp, self.live === connection else { return }
            // 服务器不重放断线期间的事件：重连后全量补拉。
            Task { await self.refresh() }
        }.store(in: &liveSubscriptions)
        live = connection
        connection.start()
    }

    private func stopLive() {
        listRefreshTask?.cancel(); listRefreshTask = nil
        liveSubscriptions.removeAll()
        live?.stop()
        live = nil
        liveState = .idle
    }

    private func handle(_ event: PaperclipLiveEvent) {
        switch event.type {
        case "heartbeat.run.queued", "heartbeat.run.status":
            if let issue = event.issueID, let status = event.string("status"), status == "queued" || status == "running" {
                liveIssueIDs.insert(issue)
            }
            scheduleListRefresh()
        case "activity.logged":
            if event.string("entityType") == "issue" { scheduleListRefresh() }
        default: break
        }
    }

    func setListVisible(_ visible: Bool) {
        listVisible = visible
        guard visible, listStale else { return }
        listStale = false
        scheduleListRefresh()
    }

    /// 事件风暴合并为一次列表刷新。
    private func scheduleListRefresh() {
        guard listVisible else { listStale = true; return }
        guard listRefreshTask == nil else { return }
        listRefreshTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(1_200))
            guard let self, !Task.isCancelled else { return }
            // 修复丢更新：以前撞上进行中的刷新时 refresh() 因 busy 直接返回，事件带来的变化要等 60 秒兜底轮询。
            while self.busy {
                try? await Task.sleep(for: .milliseconds(200))
                if Task.isCancelled { return }
            }
            self.listRefreshTask = nil
            await self.refresh()
        }
    }

    private func vault(for profile: PaperclipProfile) -> PaperclipCookieVault {
        if let vault = cookieVaults[profile.id] { return vault }
        let vault = makeCookieVault(profile)
        cookieVaults[profile.id] = vault
        return vault
    }

    private func companyKey(profile: PaperclipProfile, user: String) -> String {
        "leo.paperclip.company.\(profile.id.uuidString).\(user)"
    }
}

/// Cookie 写入和清除串行化；旧请求不能在退出完成后重新填回登录 Cookie。
@MainActor
protocol PaperclipCookieStorage: AnyObject {
    func allCookies() async -> [HTTPCookie]
    func setCookie(_ cookie: HTTPCookie) async
    func removeAllData() async
}

@MainActor
private final class PaperclipWebCookieStorage: PaperclipCookieStorage {
    let store: WKWebsiteDataStore
    init(store: WKWebsiteDataStore) { self.store = store }
    func allCookies() async -> [HTTPCookie] { await store.httpCookieStore.allCookies() }
    func setCookie(_ cookie: HTTPCookie) async { await store.httpCookieStore.setCookie(cookie) }
    func removeAllData() async {
        await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
    }
}

@MainActor
final class PaperclipCookieVault {
    // 工作区关闭后旧网络任务可能仍在结束；所有同配置实例共用撤销代际和写入队列。
    private static var sharedVaults: [UUID: PaperclipCookieVault] = [:]
    static func shared(for profile: PaperclipProfile) -> PaperclipCookieVault {
        if let vault = sharedVaults[profile.id] { return vault }
        let vault = PaperclipCookieVault(store: PaperclipWorkspaceStore.websiteData(for: profile))
        sharedVaults[profile.id] = vault
        return vault
    }
    /// 删除配置后释放对 WKWebsiteDataStore 的引用，WebKit 才能删除该容器。
    static func forget(_ id: UUID) { sharedVaults[id] = nil }
    private(set) var generation = UUID()
    private let storage: any PaperclipCookieStorage
    private var pending: Task<Void, Never>?
    init(storage: any PaperclipCookieStorage) { self.storage = storage }
    convenience init(store: WKWebsiteDataStore) { self.init(storage: PaperclipWebCookieStorage(store: store)) }

    func read(generation expected: UUID) async -> [HTTPCookie] {
        await pending?.value
        guard generation == expected else { return [] }
        let cookies = await storage.allCookies()
        return generation == expected ? cookies : []
    }
    func write(_ cookies: [HTTPCookie], generation expected: UUID) async {
        let previous = pending
        let operation = Task { @MainActor [weak self] in
            await previous?.value
            guard let self, self.generation == expected else { return }
            for cookie in cookies {
                guard self.generation == expected else { return }
                await self.storage.setCookie(cookie)
            }
        }
        pending = operation
        await operation.value
    }
    func clear() async {
        generation = UUID()
        let previous = pending
        let storage = storage
        let operation = Task { @MainActor in
            await previous?.value
            await storage.removeAllData()
        }
        pending = operation
        await operation.value
    }
}
