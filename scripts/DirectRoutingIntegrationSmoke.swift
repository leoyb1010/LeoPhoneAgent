import Foundation

// Compile the production routing extension with a minimal host shell so the
// real request/fallback logic can be fault-injected without an iOS installation.
enum GatewayError: Error { case badURL; case malformedResponse(String); case http(status: Int, message: String?) }
@MainActor final class GatewayHostStore {
    static let shared = GatewayHostStore()
    nonisolated static func saveAccessKey(_ value: String, hostId: String) {}
    func recordRoute(id: String, status: GatewayRouteStatus, device: LeoDeviceDescriptor? = nil) {}
}
actor LeoAgentClient {
    let harnessBaseURL: URL? = URL(string: "https://relay.test/m/target")!
    let hostId: String? = nil
    let session: URLSession
    let directSession: URLSession
    let supportsDirectDiscovery = false
    let expectedDeviceId: String? = nil
    let directOnly = false
    var directRoute: DirectDeviceRoute?
    var directEnrollmentAttempted = false
    var directEnrollmentAfter = Date.distantPast
    var directProbeUntil = Date.distantPast
    var directCooldownUntil = Date.distantPast
    var directLastFailure: Date?
    init(route: DirectDeviceRoute) {
        directRoute = route
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RouteProtocol.self]
        session = URLSession(configuration: config)
        directSession = URLSession(configuration: config)
    }
    enum Service { case harness }
    func request(_ path: String, method: String, body: Data?, service: Service) throws -> URLRequest {
        var request = URLRequest(url: URL(string: harnessBaseURL!.absoluteString + path)!)
        request.httpMethod = method; request.httpBody = body
        request.setValue("Bearer relay-secret", forHTTPHeaderField: "Authorization")
        return request
    }
}
final class RouteProtocol: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    static var requests = [URLRequest]()
    static var bodies = [Data]()
    static var wrongIdentity = false
    static var directStatus = 503
    static var failReplicaTransport = false
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var bodyData = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                bodyData.append(contentsOf: buffer.prefix(count))
            }
        }
        Self.lock.lock(); Self.requests.append(request); Self.bodies.append(bodyData); let wrong = Self.wrongIdentity; Self.lock.unlock()
        let path = request.url!.path
        let isDirect = request.url!.host == "direct.test"
        if path.hasPrefix("/sync/v1/"), Self.failReplicaTransport {
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost)); return
        }
        let status = path == "/v1/capabilities" ? 200 : isDirect ? Self.directStatus : 200
        let body = path == "/v1/capabilities" ? "{\"device\":{\"deviceId\":\"\(wrong ? "wrong" : target)\"}}" : "{\"session_id\":\"same-task\"}"
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
let target = "6e412b31-4e87-414b-98d3-a293073b42da"
@main struct RoutingSmoke {
    static func main() async throws {
        let device = LeoDeviceDescriptor(schemaVersion: 1, deviceId: target, name: "Target", platform: "macos", capabilities: ["remote-control", "operation-receipts"], endpoints: [.init(id: "direct", kind: "direct", baseURL: "https://direct.test", expiresAt: nil)], aliases: nil)
        let route = DirectDeviceRoute(device: device, grant: .init(token: "scoped-direct-token", targetDeviceId: target, expiresAt: Date().timeIntervalSince1970 + 3600))
        var request = URLRequest(url: URL(string: "https://relay.test/m/target/harness/sessions")!)
        request.httpMethod = "POST"; request.httpBody = Data("{\"prompt\":\"once\"}".utf8)
        request.setValue("Bearer relay-secret", forHTTPHeaderField: "Authorization")
        request.setValue("stable-operation", forHTTPHeaderField: "X-Leo-Request-Id")
        let client = LeoAgentClient(route: route)
        let result = try await client.routedData(for: request)
        precondition((result.1 as? HTTPURLResponse)?.statusCode == 200)
        let requests = RouteProtocol.requests
        precondition(requests.count == 3)
        precondition(requests[1].value(forHTTPHeaderField: "X-Request-ID") == "stable-operation")
        precondition(requests[2].value(forHTTPHeaderField: "X-Leo-Request-Id") == "stable-operation")
        precondition(requests[1].value(forHTTPHeaderField: "Authorization") == "Bearer scoped-direct-token")
        precondition(requests[2].value(forHTTPHeaderField: "Authorization") == "Bearer relay-secret")
        RouteProtocol.requests = []; RouteProtocol.wrongIdentity = true
        _ = try await LeoAgentClient(route: route).routedData(for: request)
        precondition(RouteProtocol.requests.count == 2, "Wrong target must receive no mutation")
        precondition(RouteProtocol.requests[1].url?.host == "relay.test")
        RouteProtocol.requests = []; RouteProtocol.wrongIdentity = false; RouteProtocol.directStatus = 403
        let denied = try await LeoAgentClient(route: route).routedData(for: request)
        precondition((denied.1 as? HTTPURLResponse)?.statusCode == 403)
        precondition(RouteProtocol.requests.count == 2, "Business authorization denial must not replay through relay")
        RouteProtocol.requests = []; RouteProtocol.directStatus = 503
        var events = URLRequest(url: URL(string: "https://relay.test/m/target/harness/sessions/s1/events?after=41")!)
        events.setValue("Bearer relay-secret", forHTTPHeaderField: "Authorization")
        let stream = try await LeoAgentClient(route: route).routedBytes(for: events)
        precondition((stream.1 as? HTTPURLResponse)?.statusCode == 200)
        precondition(RouteProtocol.requests.count == 3)
        precondition(RouteProtocol.requests[1].url?.query == "after=41")
        precondition(RouteProtocol.requests[2].url?.query == "after=41")
        stream.0.task.cancel()
        RouteProtocol.requests = []
        let notReady = await LeoAgentClient(route: route).replicaReady()
        precondition(!notReady, "Harness pairing must not implicitly authorize sync")
        RouteProtocol.requests = []; RouteProtocol.bodies = []; RouteProtocol.directStatus = 503
        let replicaDevice = LeoDeviceDescriptor(schemaVersion: 1, deviceId: target, name: "Replica", platform: "macos",
            capabilities: ["operation-receipts", "sync-replica-v1"], endpoints: device.endpoints, aliases: nil)
        let replica = DirectDeviceRoute(device: replicaDevice, grant: .init(token: "replica-scoped-token", targetDeviceId: target,
            expiresAt: Date().timeIntervalSince1970 + 3600, scopes: ["sync"]))
        let replicaClient = LeoAgentClient(route: replica)
        let payload = Data([1, 2, 3])
        let uploaded = try await replicaClient.replicaData(path: "/sync/v1/assets/hash", method: "PUT", body: payload,
            requestId: "chunk-0", headers: ["Content-Range": "bytes 0-2/3", "Upload-Reset": "true", "Content-Type": "application/octet-stream"])
        precondition(uploaded.1.statusCode == 503)
        precondition(RouteProtocol.requests.count == 2 && RouteProtocol.requests.allSatisfy { $0.url?.host == "direct.test" }, "Replica must not fall back to relay")
        precondition(RouteProtocol.requests[0].value(forHTTPHeaderField: "Content-Range") == nil, "Upload headers must not leak into identity probe")
        let chunk = RouteProtocol.requests.last!
        precondition(chunk.httpMethod == "PUT" && chunk.value(forHTTPHeaderField: "Content-Range") == "bytes 0-2/3")
        precondition(chunk.value(forHTTPHeaderField: "Upload-Reset") == "true")
        precondition(chunk.value(forHTTPHeaderField: "Content-Type") == "application/octet-stream")
        precondition(chunk.value(forHTTPHeaderField: "X-Request-ID") == "chunk-0")
        precondition(RouteProtocol.bodies.last == payload)
        RouteProtocol.requests = []; RouteProtocol.directStatus = 200
        _ = try await replicaClient.replicaData(path: "/sync/v1/assets/hash", method: "HEAD")
        _ = try await replicaClient.replicaData(path: "/sync/v1/assets/hash", headers: ["Range": "bytes=3-"])
        precondition(RouteProtocol.requests[0].httpMethod == "HEAD")
        precondition(RouteProtocol.requests[1].value(forHTTPHeaderField: "Range") == "bytes=3-")
        RouteProtocol.requests = []; RouteProtocol.failReplicaTransport = true
        do {
            _ = try await replicaClient.replicaData(path: "/sync/v1/assets/hash", method: "PUT", body: payload,
                headers: ["Content-Range": "bytes 0-2/3"])
            preconditionFailure("Injected transport failure must surface")
        } catch is URLError { }
        precondition(RouteProtocol.requests.count == 1 && RouteProtocol.requests[0].url?.host == "direct.test")
        RouteProtocol.requests = []; RouteProtocol.failReplicaTransport = false
        do {
            _ = try await replicaClient.replicaData(path: "/sync/v1/assets/hash", headers: ["Authorization": "Bearer wrong"])
            preconditionFailure("Replica headers may not override credentials")
        } catch GatewayError.badURL { }
        precondition(RouteProtocol.requests.isEmpty)
        do {
            _ = try await replicaClient.replicaData(path: "/sync/v1/%2e%2e/management")
            preconditionFailure("Encoded traversal must be rejected")
        } catch GatewayError.badURL { }
        precondition(RouteProtocol.requests.isEmpty)
        print("Production routing smoke passed: target binding, isolated credentials, stable-ID fallback, no 403 replay, SSE cursor, scoped replica readiness, asset headers/HEAD/body and no replica relay fallback")
    }
}
