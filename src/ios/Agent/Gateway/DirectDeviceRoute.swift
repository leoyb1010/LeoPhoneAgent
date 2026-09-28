import Foundation

/// Metadata is safe to display; the scoped grant is kept only in local Keychain.
struct LeoDeviceDescriptor: Codable, Hashable, Sendable {
    struct Endpoint: Codable, Hashable, Sendable {
        let id: String
        let kind: String
        let baseURL: String
        let expiresAt: TimeInterval?
    }
    let schemaVersion: Int
    let deviceId: String
    let name: String
    let platform: String
    let capabilities: [String]
    let endpoints: [Endpoint]
    let aliases: [String]?

    var valid: Bool {
        schemaVersion == 1 && UUID(uuidString: deviceId) != nil && !name.isEmpty && name.count <= 128 &&
        capabilities.count <= 64 && endpoints.count <= 8 && Set(endpoints.map(\.id)).count == endpoints.count &&
        endpoints.allSatisfy { Self.validEndpoint($0.baseURL) }
    }
    static func validEndpoint(_ value: String) -> Bool {
        guard let url = URLComponents(string: value) else { return false }
        return url.scheme == "https" && !(url.host ?? "").isEmpty && url.user == nil && url.password == nil &&
            url.query == nil && url.fragment == nil
    }
}

struct DirectDeviceRoute: Codable, Sendable {
    struct Grant: Codable, Sendable {
        let token: String
        let targetDeviceId: String
        let expiresAt: TimeInterval
        var scopes: [String]? = nil
    }
    let device: LeoDeviceDescriptor
    let grant: Grant
    func endpoint(at now: Date = Date()) -> URL? {
        guard device.valid, grant.targetDeviceId == device.deviceId, grant.token.count >= 16,
              grant.expiresAt > now.timeIntervalSince1970 + 30 else { return nil }
        return device.endpoints.first {
            $0.kind == "direct" && ($0.expiresAt ?? .greatestFiniteMagnitude) > now.timeIntervalSince1970 + 30
        }.flatMap { URL(string: $0.baseURL) }
    }

    func supports(scope: String, capability: String) -> Bool {
        endpoint() != nil && device.capabilities.contains(capability) &&
            (grant.scopes ?? ["harness"]).contains(scope)
    }

    static func decode(_ data: Data, expectedDeviceId: String? = nil) -> DirectDeviceRoute? {
        guard let route = try? JSONDecoder().decode(Self.self, from: data), route.endpoint() != nil,
              expectedDeviceId == nil || expectedDeviceId == route.device.deviceId else { return nil }
        return route
    }
}

struct GatewayRouteStatus: Sendable {
    let direct: Bool
    let latencyMilliseconds: Int?
    let failedAt: Date?
    var available: Bool = true
}

struct DirectPairPayload: Decodable {
    let apiRoot: String
    let join: String
    let exp: TimeInterval
    let deviceId: String
    static func parse(_ raw: String) -> Self? {
        let prefix = "leoagent-direct:v1|"
        guard raw.hasPrefix(prefix), let data = String(raw.dropFirst(prefix.count)).data(using: .utf8),
              let pair = try? JSONDecoder().decode(Self.self, from: data),
              LeoDeviceDescriptor.validEndpoint(pair.apiRoot), UUID(uuidString: pair.deviceId) != nil,
              pair.join.count >= 16, pair.exp > Date().timeIntervalSince1970 else { return nil }
        return pair
    }
}

/// Explicit service directory established by authenticated relay pairing. Legacy
/// URL parsing is confined to migration rather than used to infer capabilities.
struct GatewayRelayServices: Codable, Hashable, Sendable {
    let apiRoot: String
    var eventsURL: URL? { URL(string: apiRoot + "/events") }
    var treasuryURL: URL? { URL(string: apiRoot + "/treasury/") }
    init?(apiRoot: String) {
        let root = apiRoot.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard LeoDeviceDescriptor.validEndpoint(root) else { return nil }
        self.apiRoot = root
    }
}
