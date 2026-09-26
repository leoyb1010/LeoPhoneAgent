//
//  WatchStandaloneClient.swift
//  LeoWatch
//
//  [T-watch-standalone] Answers straight from the wrist when the iPhone is out
//  of reach — a cellular watch on a run, the phone left at home.
//
//  The phone picks the model (Settings → Apple Watch, or the first API-key
//  member of the default group that speaks OpenAI Chat Completions or
//  Anthropic Messages) and sends endpoint and key over the encrypted
//  WatchConnectivity channel. Set to "always", the wrist answers this way even
//  with the phone in reach. The key is kept in this
//  watch's Keychain, never synced. [T-watch-skills] The phone also shares its
//  remote (HTTP) MCP tools — web search, maps, weather — which the wrist runs
//  itself (WatchAgentLoop); files, shell and in-app skills stay on the phone.
//

import Foundation
import Security

struct WatchStandaloneConfig: Codable, Equatable {
    let format: String          // "openai" | "anthropic"
    let endpoint: String
    let model: String
    let modelName: String
    let providerName: String
    let userAgent: String
    /// Answer directly even when the phone is in reach. Nil in configs saved before 1.45.
    let alwaysDirect: Bool?
    /// Send `max_tokens` (OpenRouter, Mistral) instead of `max_completion_tokens`. Nil before 1.45.
    let legacyMaxTokens: Bool?
}

@MainActor
final class WatchStandaloneClient: ObservableObject {
    static let shared = WatchStandaloneClient()

    @Published private(set) var config: WatchStandaloneConfig?
    /// Why direct answers are off, in the phone's words ("already disabled",
    /// "only OAuth models in the default group", …). Nil when configured.
    @Published private(set) var unavailableReason: String?
    /// [T-watch-skills] Names of the phone-shared tool servers ("联网搜索"…), for the status line.
    @Published private(set) var toolServerNames: [String] = []

    private static let configKey = "leo.watch.standalone.config"
    private static let reasonKey = "leo.watch.standalone.reason"
    private static let keychainService = "com.leoyuan.leophoneagent.watch.standalone"
    private static let keychainAccount = "apiKey"
    /// Resolved MCP servers (URLs / headers may carry keys) — Keychain, not defaults.
    private static let serversAccount = "mcpServers"
    private static let toolCacheKey = "leo.watch.tools.cache.v1"
    /// Tool schemas are refetched at most this often (or when the servers change).
    private static let toolCacheTTL: TimeInterval = 12 * 3600

    /// Small screen, short answers: the wrist is for quick questions.
    static let systemPrompt = "你是 Leo，用户正在 Apple Watch 上问你问题。用简洁的中文纯文本回答，不用 Markdown，尽量控制在 120 字以内；需要列步骤时每步一行。"
    /// Added when tools are on offer: look things up instead of guessing.
    static let toolsPrompt = "\n需要实时信息（新闻、天气、价格、比分、营业时间等）时先调用工具查，再用一两句话回答，不要编造。"

    private let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 60
        configuration.waitsForConnectivity = false
        configuration.allowsExpensiveNetworkAccess = true
        configuration.allowsConstrainedNetworkAccess = true
        return URLSession(configuration: configuration)
    }()

    private init() {
        let defaults = UserDefaults.standard
        if let data = defaults.data(forKey: Self.configKey),
           let saved = try? JSONDecoder().decode(WatchStandaloneConfig.self, from: data),
           Self.loadKey() != nil {
            config = saved
        }
        unavailableReason = defaults.string(forKey: Self.reasonKey)
        toolServerNames = Self.loadServers().map(\.id)
    }

    var isReady: Bool { config != nil }

    /// Picked "always answer on the watch" on the phone.
    var prefersDirect: Bool { config?.alwaysDirect == true }

    /// The phone's config message (see WatchBridge.syncStandaloneConfigIfNeeded).
    func apply(_ info: [String: Any]) {
        let defaults = UserDefaults.standard
        if (info["clear"] as? Bool) == true {
            Self.deleteKey()
            Self.saveServers([])
            toolServerNames = []
            defaults.removeObject(forKey: Self.configKey)
            config = nil
            unavailableReason = info["reason"] as? String
            defaults.set(unavailableReason, forKey: Self.reasonKey)
            return
        }
        guard let format = info["format"] as? String,
              let endpoint = info["endpoint"] as? String,
              let model = info["model"] as? String,
              let key = info["apiKey"] as? String, !key.isEmpty,
              Self.saveKey(key) else { return }
        let next = WatchStandaloneConfig(
            format: format,
            endpoint: endpoint,
            model: model,
            modelName: (info["modelName"] as? String) ?? model,
            providerName: (info["providerName"] as? String) ?? "",
            userAgent: (info["userAgent"] as? String) ?? "",
            alwaysDirect: info["alwaysDirect"] as? Bool,
            legacyMaxTokens: info["legacyMaxTokens"] as? Bool
        )
        if let data = try? JSONEncoder().encode(next) { defaults.set(data, forKey: Self.configKey) }
        defaults.removeObject(forKey: Self.reasonKey)
        config = next
        unavailableReason = nil
        // [T-watch-skills] Remote tools the phone shared (absent from older phones = none).
        let servers = ((info["mcpServers"] as? [[String: Any]]) ?? []).compactMap { entry -> WatchMCPServer? in
            guard let id = entry["id"] as? String, let url = entry["url"] as? String, !url.isEmpty else { return nil }
            return WatchMCPServer(id: id, url: url, headers: (entry["headers"] as? [String: String]) ?? [:])
        }
        if servers != Self.loadServers() {
            Self.saveServers(servers)
            defaults.removeObject(forKey: Self.toolCacheKey)
            Task { for server in servers { await WatchMCPClient.shared.reset(server.id) } }
        }
        toolServerNames = servers.map(\.id)
    }

    /// One plain-chat turn. `history` is oldest-first (question, answer).
    func ask(_ text: String, history: [(question: String, answer: String)]) async throws -> String {
        let (config, request) = try makeRequest(text, history: history)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw WatchStandaloneError.network(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw WatchStandaloneError.http(status, WatchAgentLoop.errorDetail(from: data))
        }
        let reply = Self.replyText(from: data, format: config.format)
        guard !reply.isEmpty else { throw WatchStandaloneError.emptyReply }
        return WatchAgentLoop.plain(reply)
    }

    /// [T-watch-stream] One direct answer, streamed: `onEvent` gets the answer
    /// so far and what is happening ("正在搜索…"). Tools come from the phone's
    /// shared servers; a server that can't be reached is left out, never fatal.
    func askStreaming(_ text: String, history: [(question: String, answer: String)],
                      onEvent: @escaping (WatchAgentEvent) -> Void) async throws -> String {
        guard let config, let key = Self.loadKey() else {
            throw WatchStandaloneError.notConfigured(unavailableReason ?? "还没有可直连的模型。打开一次 iPhone 上的 LeoPhoneAgent 同步。")
        }
        let servers = Self.loadServers()
        let tools = await availableTools(servers)
        let loop = WatchAgentLoop(
            endpoint: WatchModelEndpoint(format: config.format, endpoint: config.endpoint, model: config.model,
                                         apiKey: key, userAgent: config.userAgent,
                                         legacyMaxTokens: config.legacyMaxTokens != false),
            tools: tools,
            servers: servers,
            mcp: WatchMCPClient.shared,
            session: session,
            systemPrompt: Self.systemPrompt + (tools.isEmpty ? "" : Self.toolsPrompt)
        )
        return try await loop.run(question: text, history: history, onEvent: onEvent)
    }

    private struct ToolCache: Codable {
        let signature: String
        let tools: [WatchMCPTool]
        let fetchedAt: Date
    }

    /// Tool schemas for the shared servers, cached (they rarely change and
    /// listing costs a round trip per server on a watch radio).
    private func availableTools(_ servers: [WatchMCPServer]) async -> [WatchMCPTool] {
        guard !servers.isEmpty else { return [] }
        let signature = servers.map { "\($0.id)|\($0.url.count)|\($0.headers.keys.sorted())" }.joined(separator: ";")
        if let data = UserDefaults.standard.data(forKey: Self.toolCacheKey),
           let cache = try? JSONDecoder().decode(ToolCache.self, from: data),
           cache.signature == signature, Date().timeIntervalSince(cache.fetchedAt) < Self.toolCacheTTL {
            return cache.tools
        }
        var tools: [WatchMCPTool] = []
        await withTaskGroup(of: [WatchMCPTool].self) { group in
            for server in servers {
                group.addTask { (try? await WatchMCPClient.shared.listTools(server)) ?? [] }
            }
            for await listed in group { tools += listed }
        }
        // Stable order keeps the request prefix identical between asks.
        tools.sort { ($0.server, $0.name) < ($1.server, $1.name) }
        if !tools.isEmpty, let data = try? JSONEncoder().encode(ToolCache(signature: signature, tools: tools, fetchedAt: Date())) {
            UserDefaults.standard.set(data, forKey: Self.toolCacheKey)
        }
        return tools
    }

    private func makeRequest(_ text: String,
                             history: [(question: String, answer: String)]) throws -> (WatchStandaloneConfig, URLRequest) {
        guard let config, let key = Self.loadKey(), let url = URL(string: config.endpoint) else {
            throw WatchStandaloneError.notConfigured(unavailableReason ?? "还没有可直连的模型。打开一次 iPhone 上的 LeoPhoneAgent 同步。")
        }
        var turns: [[String: String]] = []
        for pair in history {
            turns.append(["role": "user", "content": pair.question])
            turns.append(["role": "assistant", "content": pair.answer])
        }
        turns.append(["role": "user", "content": text])

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !config.userAgent.isEmpty { request.setValue(config.userAgent, forHTTPHeaderField: "User-Agent") }
        // Room for reasoning models to think before the short answer the prompt asks for.
        let maxTokens = 2000
        let body: [String: Any]
        if config.format == "anthropic" {
            request.setValue(key, forHTTPHeaderField: "x-api-key")
            request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
            body = ["model": config.model, "max_tokens": maxTokens, "system": Self.systemPrompt, "messages": turns]
        } else {
            request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
            // GPT-5 / o-series reject `max_tokens`; OpenRouter and Mistral reject the newer name.
            let tokenParam = config.legacyMaxTokens == false ? "max_completion_tokens" : "max_tokens"
            body = ["model": config.model, tokenParam: maxTokens, "stream": false,
                    "messages": [["role": "system", "content": Self.systemPrompt]] + turns]
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return (config, request)
    }

    // MARK: - Background delivery

    /// watchOS suspends the app soon after the wrist drops, and a foreground
    /// request dies with it. A background URLSession hands the transfer to the
    /// system, which finishes it (over cellular if needed) and wakes us with
    /// the result; the answer then arrives as a notification.
    static let backgroundSessionId = "com.leoyuan.leophoneagent.watch.direct"

    private struct PendingBackgroundAsk: Codable {
        let question: String
        let format: String
        let createdAt: Date
    }
    private static let pendingKey = "leo.watch.standalone.pending"

    /// Result of a background ask, delivered on the main actor — possibly after
    /// the system relaunched the app just for it.
    var onBackgroundAnswer: ((_ requestId: String, _ question: String, _ result: Result<String, Error>) -> Void)?

    private lazy var backgroundSession: URLSession = {
        let configuration = URLSessionConfiguration.background(withIdentifier: Self.backgroundSessionId)
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        configuration.allowsCellularAccess = true
        configuration.allowsExpensiveNetworkAccess = true
        configuration.allowsConstrainedNetworkAccess = true
        configuration.timeoutIntervalForResource = 15 * 60
        return URLSession(configuration: configuration, delegate: BackgroundAskDelegate.shared, delegateQueue: nil)
    }()

    /// Background sessions only accept upload tasks with a file body.
    func askInBackground(requestId: String, text: String,
                         history: [(question: String, answer: String)]) throws {
        let (config, request) = try makeRequest(text, history: history)
        guard let body = request.httpBody else { throw WatchStandaloneError.emptyReply }
        let file = Self.bodyFile(requestId)
        try body.write(to: file, options: .atomic)
        var upload = request
        upload.httpBody = nil
        var pending = Self.loadPending()
        pending[requestId] = PendingBackgroundAsk(question: text, format: config.format, createdAt: Date())
        Self.savePending(pending)
        let task = backgroundSession.uploadTask(with: upload, fromFile: file)
        task.taskDescription = requestId
        task.resume()
    }

    /// Stop from the wrist: drop the record (a late answer is then ignored) and
    /// the transfer itself.
    func cancelBackground(requestId: String) {
        var pending = Self.loadPending()
        guard pending.removeValue(forKey: requestId) != nil else { return }
        Self.savePending(pending)
        try? FileManager.default.removeItem(at: Self.bodyFile(requestId))
        backgroundSession.getAllTasks { tasks in
            tasks.first { $0.taskDescription == requestId }?.cancel()
        }
    }

    /// Recreating the session with the same identifier is what lets the
    /// system deliver events for transfers that finished while we were away.
    func reconnectBackgroundSession() {
        _ = backgroundSession
    }

    fileprivate func completeBackground(requestId: String, data: Data, status: Int, error: Error?) {
        var pending = Self.loadPending()
        guard let ask = pending.removeValue(forKey: requestId) else { return }
        Self.savePending(pending)
        try? FileManager.default.removeItem(at: Self.bodyFile(requestId))
        let result: Result<String, Error>
        if let error {
            result = .failure(WatchStandaloneError.network(error.localizedDescription))
        } else if !(200..<300).contains(status) {
            result = .failure(WatchStandaloneError.http(status, WatchAgentLoop.errorDetail(from: data)))
        } else {
            let reply = Self.replyText(from: data, format: ask.format)
            result = reply.isEmpty ? .failure(WatchStandaloneError.emptyReply) : .success(WatchAgentLoop.plain(reply))
        }
        onBackgroundAnswer?(requestId, ask.question, result)
    }

    private static func bodyFile(_ requestId: String) -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("leo-ask-\(requestId).json")
    }

    private static func loadPending() -> [String: PendingBackgroundAsk] {
        guard let data = UserDefaults.standard.data(forKey: pendingKey),
              let saved = try? JSONDecoder().decode([String: PendingBackgroundAsk].self, from: data) else { return [:] }
        // A transfer the system never finished within a day is not coming back.
        return saved.filter { Date().timeIntervalSince($0.value.createdAt) < 24 * 3600 }
    }

    private static func savePending(_ pending: [String: PendingBackgroundAsk]) {
        UserDefaults.standard.set(try? JSONEncoder().encode(pending), forKey: pendingKey)
    }

    // MARK: - Response parsing

    static func replyText(from data: Data, format: String) -> String {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return "" }
        if format == "anthropic" {
            let blocks = json["content"] as? [[String: Any]] ?? []
            return blocks.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }
                .joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let choices = json["choices"] as? [[String: Any]] ?? []
        let message = choices.first?["message"] as? [String: Any]
        return ((message?["content"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Keychain (this device only, never synced)

    private static func baseQuery() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: keychainService,
         kSecAttrAccount as String: keychainAccount]
    }

    private static func saveKey(_ key: String) -> Bool {
        let data = Data(key.utf8)
        let update: [String: Any] = [kSecValueData as String: data,
                                     kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        if SecItemUpdate(baseQuery() as CFDictionary, update as CFDictionary) == errSecSuccess { return true }
        var add = baseQuery()
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    private static func loadKey() -> String? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func deleteKey() {
        SecItemDelete(baseQuery() as CFDictionary)
    }

    private static func serversQuery() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: keychainService,
         kSecAttrAccount as String: serversAccount]
    }

    static func loadServers() -> [WatchMCPServer] {
        var query = serversQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data,
              let servers = try? JSONDecoder().decode([WatchMCPServer].self, from: data) else { return [] }
        return servers
    }

    private static func saveServers(_ servers: [WatchMCPServer]) {
        SecItemDelete(serversQuery() as CFDictionary)
        guard !servers.isEmpty, let data = try? JSONEncoder().encode(servers) else { return }
        var add = serversQuery()
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
}

/// Collects background-session responses. Runs on URLSession's own queue.
final class BackgroundAskDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    static let shared = BackgroundAskDelegate()

    private let lock = NSLock()
    private var buffers: [Int: Data] = [:]
    private var eventsFinished: (() -> Void)?

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.withLock { buffers[dataTask.taskIdentifier, default: Data()].append(data) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let data = lock.withLock { buffers.removeValue(forKey: task.taskIdentifier) ?? Data() }
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        let requestId = task.taskDescription ?? ""
        Task { @MainActor in
            WatchStandaloneClient.shared.completeBackground(requestId: requestId, data: data, status: status, error: error)
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let done = lock.withLock { () -> (() -> Void)? in
            defer { eventsFinished = nil }
            return eventsFinished
        }
        done?()
    }

    /// Holds the system's background-task assertion until the session has
    /// delivered everything it woke us for (bounded, so a lost callback can't
    /// keep the task open until watchOS kills us).
    /// `afterArming` reconnects the session: it can deliver everything at once,
    /// and a "finished" callback that finds nothing armed is lost (then this
    /// waits out the whole timeout).
    func waitForEvents(timeout seconds: Double = 25, afterArming: @escaping @Sendable () -> Void) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let once = OnceFlag()
            let finish: @Sendable () -> Void = { if once.claim() { continuation.resume() } }
            lock.withLock { eventsFinished = finish }
            afterArming()
            DispatchQueue.global().asyncAfter(deadline: .now() + seconds, execute: finish)
        }
    }
}

/// Lets exactly one of several racing callbacks resume a continuation.
private final class OnceFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false
    func claim() -> Bool {
        lock.withLock {
            defer { claimed = true }
            return !claimed
        }
    }
}
