import Foundation

/// A grant must never follow redirects to another origin, including same-tailnet hosts.
final class GatewayNoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

extension LeoAgentClient {
    /// The original relay URL remains the canonical task address. Routing only
    /// substitutes transport/credentials, preserving body, operation ID and SSE cursor.
    func directRequest(for original: URLRequest) async -> URLRequest? {
        guard let source = original.url, let relay = harnessBaseURL,
              source.absoluteString.hasPrefix(relay.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/")
        else { return nil }
        let relative = String(source.absoluteString.dropFirst(relay.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")).count))
        // [WP-50] /screen/ (看屏) rides the direct route too; the Mac checks the grant's harness scope.
        guard relative.hasPrefix("/harness/") || relative.hasPrefix("/operations/") || relative.hasPrefix("/sync/v1/")
                || relative.hasPrefix("/screen/") || relative == "/v1/capabilities" else { return nil }
        guard Date() >= directCooldownUntil, Date() >= directSlowUntil else { return nil }
        await enrollDirectIfNeeded()
        guard let route = directRoute, let base = route.endpoint() else { return nil }
        if relative.hasPrefix("/sync/v1/"), !route.supports(scope: "sync", capability: "sync-replica-v1") { return nil }
        if relative.hasPrefix("/harness/") || relative.hasPrefix("/operations/") || relative.hasPrefix("/screen/"),
           !(route.grant.scopes ?? ["harness"]).contains("harness") { return nil }
        if original.httpMethod != "GET", original.httpMethod != "HEAD",
           !route.device.capabilities.contains("operation-receipts") { return nil }
        var request = original
        request.url = URL(string: base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + relative)
        request.setValue("Bearer \(route.grant.token)", forHTTPHeaderField: "Authorization")
        request.setValue(route.device.deviceId, forHTTPHeaderField: "X-Leo-Device-ID")
        request.timeoutInterval = 8
        if let id = original.value(forHTTPHeaderField: "X-Leo-Request-Id") {
            request.setValue(id, forHTTPHeaderField: "X-Request-ID")
        }
        if Date() >= directProbeUntil {
            var probe = request
            probe.url = URL(string: base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/v1/capabilities")
            probe.httpMethod = "GET"
            probe.httpBody = nil
            for header in ["Content-Type", "Content-Length", "Content-Range", "Upload-Reset", "Range", "If-Match", "If-None-Match"] {
                probe.setValue(nil, forHTTPHeaderField: header)
            }
            probe.timeoutInterval = 3
            do {
                let probeStart = Date()
                let (data, response) = try await directSession.data(for: probe)
                let probeMs = Date().timeIntervalSince(probeStart) * 1000
                guard (response as? HTTPURLResponse)?.statusCode == 200,
                      let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let device = json["device"] as? [String: Any], device["deviceId"] as? String == route.device.deviceId
                else { await directFailed(); return nil }
                directProbeUntil = Date().addingTimeInterval(120)
                // [up-link] 直连只在真的更快时用：中继（Mac mini）是默认路。没测过中继时，直连要像局域网一样快才用。
                if DirectRoutePolicy.isSlower(directMs: probeMs, relayMs: relayLightLatencyMs) {
                    directSlowUntil = Date().addingTimeInterval(DirectRoutePolicy.slowBackoff)
                    await pinRelayE2E(from: json, source: .direct)
                    return nil
                }
                // [e2e] 直连是 TLS 到 Mac 本机、并核对过设备 id:这里拿到的中继加密公钥可以固定(老手机不用重扫码)。
                await pinRelayE2E(from: json, source: .direct)
            } catch { await directFailed(); return nil }
        }
        return request
    }

    private func enrollDirectIfNeeded() async {
        guard directRoute?.endpoint() == nil, !directEnrollmentAttempted, Date() >= directEnrollmentAfter, supportsDirectDiscovery, !directOnly else { return }
        directEnrollmentAttempted = true
        // A Mac without direct enabled answers no; ask again rarely, not before every request.
        defer { directEnrollmentAttempted = false; directEnrollmentAfter = Date().addingTimeInterval(300) }
        do {
            var request = try request("/direct-grants", method: "POST", body: Data("{}".utf8), service: .harness)
            request.timeoutInterval = 5
            let (data, response) = try await directSession.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let route = DirectDeviceRoute.decode(data, expectedDeviceId: expectedDeviceId) else { return }
            directRoute = route
            if let hostId, let json = String(data: data, encoding: .utf8) {
                GatewayHostStore.saveAccessKey(json, hostId: hostId + ".direct")
                await GatewayHostStore.shared.recordRoute(id: hostId,
                    status: GatewayRouteStatus(direct: false, latencyMilliseconds: nil, failedAt: nil), device: route.device)
            }
        } catch { /* Old servers remain relay-only; no write is retried during discovery. */ }
    }

    func directFailed() async {
        directLastFailure = Date()
        directCooldownUntil = Date().addingTimeInterval(30)
        directProbeUntil = .distantPast
        if let hostId {
            await GatewayHostStore.shared.recordPath(id: hostId, route: .direct, success: false)
            // [fix-remote] 直连失败且地址被解析到 198.18.x：手机上的代理 App 对 *.ts.net 做了 fake-ip。
            if let host = directRoute?.endpoint()?.host {
                let fake = await Self.resolvesToFakeIP(host)
                await GatewayHostStore.shared.markFakeIP(hostId, detected: fake)
            }
        }
        if let hostId {
            await GatewayHostStore.shared.recordRoute(id: hostId,
                status: GatewayRouteStatus(direct: directOnly, latencyMilliseconds: nil, failedAt: directLastFailure, available: !directOnly))
        }
    }

    /// 解析一次主机名，看是否落在 198.18.0.0/15（fake-ip）。
    nonisolated static func resolvesToFakeIP(_ host: String) async -> Bool {
        await Task.detached {
            var hints = addrinfo(ai_flags: 0, ai_family: AF_INET, ai_socktype: SOCK_STREAM, ai_protocol: 0,
                                 ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil)
            var result: UnsafeMutablePointer<addrinfo>?
            guard getaddrinfo(host, nil, &hints, &result) == 0, let first = result else { return false }
            defer { freeaddrinfo(first) }
            var cursor: UnsafeMutablePointer<addrinfo>? = first
            while let info = cursor {
                if let addr = info.pointee.ai_addr, info.pointee.ai_family == AF_INET {
                    let ip = addr.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { pointer -> String in
                        var address = pointer.pointee.sin_addr
                        var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                        inet_ntop(AF_INET, &address, &buffer, socklen_t(INET_ADDRSTRLEN))
                        return String(cString: buffer)
                    }
                    if FakeIPAdvisor.isFakeIP(ip) { return true }
                }
                cursor = info.pointee.ai_next
            }
            return false
        }.value
    }

    /// 中继上的轻量请求记一笔耗时，给「直连是否更快」做对照。
    func noteRelayLatency(_ original: URLRequest, start: Date) {
        guard original.httpMethod == nil || original.httpMethod == "GET",
              let path = original.url?.path,
              path.hasSuffix("/v1/capabilities") || path.hasSuffix("/harness/sessions") else { return }
        let ms = Date().timeIntervalSince(start) * 1000
        relayLightLatencyMs = relayLightLatencyMs.map { $0 * 0.7 + ms * 0.3 } ?? ms
    }

    private func reportRoute(direct: Bool, start: Date) async {
        if let hostId {
            await GatewayHostStore.shared.recordPath(id: hostId, route: direct ? .direct : .relay, success: true,
                                                     latencyMilliseconds: Int(Date().timeIntervalSince(start) * 1000))
            if direct { await GatewayHostStore.shared.markFakeIP(hostId, detected: false) }
        }
        if direct { directLastFailure = nil }
        if let hostId {
            await GatewayHostStore.shared.recordRoute(id: hostId,
                status: GatewayRouteStatus(direct: direct,
                    latencyMilliseconds: Int(Date().timeIntervalSince(start) * 1000), failedAt: directLastFailure))
        }
    }

    func routedData(for original: URLRequest) async throws -> (Data, URLResponse) {
        // A direct POST that timed out may already have reached the Mac; if the
        // relay fallback then fails for a local reason, the caller must treat the
        // result as unknown rather than "never sent".
        var directAttempted = false
        if let direct = await directRequest(for: original) {
            do {
                let start = Date()
                directAttempted = true
                let result = try await directSession.data(for: direct)
                if let response = result.1 as? HTTPURLResponse, [502, 503, 504].contains(response.statusCode) {
                    await directFailed()
                } else {
                    await reportRoute(direct: true, start: start)
                    return result // 4xx/business errors are authoritative, not route failures.
                }
            } catch {
                if Task.isCancelled { throw CancellationError() }
                await directFailed()
            }
        }
        let mutating = !["GET", "HEAD", nil].contains(original.httpMethod?.uppercased())
        if directOnly {
            throw directAttempted && mutating ? GatewayError.uncertainAfterDirectAttempt : URLError(.cannotConnectToHost)
        }
        let start = Date()
        do {
            // [fix-remote] 中继有多个入口：按更快的发，入口坏了换同组另一个（RelayRootRouter）。
            let result = try await relayData(for: original)
            noteRelayLatency(original, start: start)
            await reportRoute(direct: false, start: start)
            return result
        } catch let error as URLError {
            if error.code != .cancelled, let hostId {
                await GatewayHostStore.shared.recordPath(id: hostId, route: .relay, success: false)
            }
            if directAttempted && mutating { throw error.code == .cancelled ? error : GatewayError.uncertainAfterDirectAttempt }
            throw error
        }
    }

    /// 流:直连优先,中继兜底(有固定公钥就走 /e2e/events)。按行给出,调用方只认 `data:` 行。
    func routedLines(for original: URLRequest) async throws -> (AsyncThrowingStream<String, Error>, URLResponse) {
        if var direct = await directRequest(for: original) {
            direct.timeoutInterval = 8
            do {
                let result = try await directSession.bytes(for: direct)
                if let response = result.1 as? HTTPURLResponse, [502, 503, 504].contains(response.statusCode) {
                    result.0.task.cancel()
                    await directFailed()
                } else { return (Self.lines(result.0), result.1) }
            } catch {
                if Task.isCancelled { throw CancellationError() }
                await directFailed()
            }
        }
        if directOnly { throw URLError(.cannotConnectToHost) }
        if let sealed = relaySealed(original, stream: true) {
            let (bytes, response) = try await RelayRootRouter.shared.perform(sealed.request, discard: { $0.task.cancel() }) {
                try await session.bytes(for: $0)
            }
            // 非 200 是中继自己的回答(钥匙不对、Mac 离线),里面没有业务内容。
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return (Self.lines(bytes), response) }
            return (e2eLines(bytes, keys: sealed.keys, fallback: original), response)
        }
        let (bytes, response) = try await relayPlainBytes(original)
        return (Self.lines(bytes), response)
    }

    nonisolated static func lines(_ bytes: URLSession.AsyncBytes) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await line in bytes.lines { continuation.yield(line) }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel(); bytes.task.cancel() }
        }
    }
}

extension LeoAgentClient {
    /// Replica transport shares device authorization and routing, but keeps its
    /// revision IDs/ACK ledger in SyncCore. No caller receives bearer secrets.
    func replicaData(path: String, method: String = "GET", body: Data? = nil,
                     requestId: String? = nil, headers: [String: String] = [:]) async throws -> (Data, HTTPURLResponse) {
        guard let parts = URLComponents(string: path), parts.scheme == nil, parts.host == nil, parts.fragment == nil,
              let decodedPath = parts.percentEncodedPath.removingPercentEncoding,
              decodedPath.hasPrefix("/sync/v1/"), !decodedPath.contains("\\"),
              !decodedPath.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }),
              !path.contains("\r"), !path.contains("\n"),
              ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].contains(method),
              !(method == "GET" || method == "HEAD") || body == nil,
              headers.count <= 6, Set(headers.keys.map { $0.lowercased() }).count == headers.count
        else { throw GatewayError.badURL }
        var request = try request(path, method: method, body: body, service: .harness)
        for (name, value) in headers {
            guard value.utf8.count <= 512, !value.contains("\r"), !value.contains("\n") else { throw GatewayError.badURL }
            let valid: Bool
            switch name.lowercased() {
            case "content-range": valid = value.range(of: #"^bytes (?:[0-9]+-[0-9]+/[0-9]+|\*/0)$"#, options: .regularExpression) != nil
            case "range": valid = value.range(of: #"^bytes=[0-9]+-[0-9]*$"#, options: .regularExpression) != nil
            case "upload-reset": valid = value == "true" || value == "false"
            case "content-type": valid = ["application/json", "application/octet-stream"].contains(value.lowercased())
            case "if-match", "if-none-match": valid = !value.isEmpty
            default: valid = false
            }
            guard valid else { throw GatewayError.badURL }
            request.setValue(value, forHTTPHeaderField: name)
        }
        if let requestId {
            request.setValue(requestId, forHTTPHeaderField: "X-Leo-Request-Id")
            request.setValue(requestId, forHTTPHeaderField: "X-Request-ID")
        }
        guard await replicaReady() else { throw GatewayError.http(status: 403, message: "设备尚未授权同步副本") }
        // Replica is an independent tailnet destination. The application relay
        // does not expose this database and must never receive its payloads.
        guard let direct = await directRequest(for: request) else { throw URLError(.cannotConnectToHost) }
        let (data, response) = try await directSession.data(for: direct)
        guard let http = response as? HTTPURLResponse else { throw GatewayError.malformedResponse("not HTTP") }
        return (data, http)
    }

    func replicaReady() async -> Bool {
        await enrollDirectIfNeeded()
        return directRoute?.supports(scope: "sync", capability: "sync-replica-v1") == true
    }

    func replicaDeviceId() async -> String? {
        await enrollDirectIfNeeded()
        return directRoute?.device.deviceId ?? expectedDeviceId
    }
}


/// [up-link] 直连 vs 中继：默认走中继（Mac mini），直连实测更快才切过去。
enum DirectRoutePolicy {
    /// 直连判定为慢之后多久再试（秒）。
    static let slowBackoff: TimeInterval = 600
    /// 还没有中继对照时，直连探测要快于这个值（毫秒）才算「局域网级」。
    static let unknownRelayCeilingMs: Double = 400

    static func isSlower(directMs: Double, relayMs: Double?) -> Bool {
        guard let relayMs else { return directMs > unknownRelayCeilingMs }
        return directMs > relayMs * 0.9
    }
}
