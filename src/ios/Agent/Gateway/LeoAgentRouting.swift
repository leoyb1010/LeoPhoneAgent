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
        guard relative.hasPrefix("/harness/") || relative.hasPrefix("/sync/v1/") || relative == "/v1/capabilities" else { return nil }
        guard Date() >= directCooldownUntil else { return nil }
        await enrollDirectIfNeeded()
        guard let route = directRoute, let base = route.endpoint() else { return nil }
        if relative.hasPrefix("/sync/v1/"), !route.supports(scope: "sync", capability: "sync-replica-v1") { return nil }
        if relative.hasPrefix("/harness/"), !(route.grant.scopes ?? ["harness"]).contains("harness") { return nil }
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
                let (data, response) = try await directSession.data(for: probe)
                guard (response as? HTTPURLResponse)?.statusCode == 200,
                      let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let device = json["device"] as? [String: Any], device["deviceId"] as? String == route.device.deviceId
                else { await directFailed(); return nil }
                directProbeUntil = Date().addingTimeInterval(120)
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
            await GatewayHostStore.shared.recordRoute(id: hostId,
                status: GatewayRouteStatus(direct: directOnly, latencyMilliseconds: nil, failedAt: directLastFailure, available: !directOnly))
        }
    }

    private func reportRoute(direct: Bool, start: Date) async {
        if direct { directLastFailure = nil }
        if let hostId {
            await GatewayHostStore.shared.recordRoute(id: hostId,
                status: GatewayRouteStatus(direct: direct,
                    latencyMilliseconds: Int(Date().timeIntervalSince(start) * 1000), failedAt: directLastFailure))
        }
    }

    func routedData(for original: URLRequest) async throws -> (Data, URLResponse) {
        if let direct = await directRequest(for: original) {
            do {
                let start = Date()
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
        if directOnly { throw URLError(.cannotConnectToHost) }
        let start = Date()
        let result = try await session.data(for: original)
        await reportRoute(direct: false, start: start)
        return result
    }

    func routedBytes(for original: URLRequest) async throws -> (URLSession.AsyncBytes, URLResponse) {
        if var direct = await directRequest(for: original) {
            direct.timeoutInterval = 8
            do {
                let result = try await directSession.bytes(for: direct)
                if let response = result.1 as? HTTPURLResponse, [502, 503, 504].contains(response.statusCode) {
                    result.0.task.cancel()
                    await directFailed()
                } else { return result }
            } catch {
                if Task.isCancelled { throw CancellationError() }
                await directFailed()
            }
        }
        if directOnly { throw URLError(.cannotConnectToHost) }
        return try await session.bytes(for: original)
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
