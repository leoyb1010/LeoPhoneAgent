import Foundation

@main struct DirectRouteSmoke {
    static func main() throws {
        let target = "6e412b31-4e87-414b-98d3-a293073b42da"
        let endpoint = LeoDeviceDescriptor.Endpoint(id: "tailnet", kind: "direct", baseURL: "https://target.ts.net:8443", expiresAt: nil)
        let device = LeoDeviceDescriptor(schemaVersion: 1, deviceId: target, name: "Target", platform: "macos", capabilities: ["remote-control"], endpoints: [endpoint], aliases: nil)
        let route = DirectDeviceRoute(device: device, grant: .init(token: "scoped-0123456789", targetDeviceId: target, expiresAt: Date().timeIntervalSince1970 + 3600))
        precondition(route.endpoint() != nil)
        let data = try JSONEncoder().encode(route)
        precondition(DirectDeviceRoute.decode(data, expectedDeviceId: target) != nil)
        precondition(DirectDeviceRoute.decode(data, expectedDeviceId: UUID().uuidString) == nil)
        precondition(route.endpoint(at: Date().addingTimeInterval(4000)) == nil)
        for invalid in ["http://target.ts.net", "https://secret@target.ts.net", "https://target.ts.net?token=secret", "https://target.ts.net#fragment"] {
            precondition(!LeoDeviceDescriptor.validEndpoint(invalid))
        }
        let validQR = "leoagent-direct:v1|{\"apiRoot\":\"https://target.ts.net\",\"join\":\"0123456789abcdef\",\"exp\":4102444800,\"deviceId\":\"\(target)\"}"
        precondition(DirectPairPayload.parse(validQR)?.deviceId == target)
        precondition(DirectPairPayload.parse(validQR.replacingOccurrences(of: "4102444800", with: "1")) == nil)
        precondition(DirectPairPayload.parse(validQR.replacingOccurrences(of: "https://", with: "http://")) == nil)
        precondition(!route.supports(scope: "sync", capability: "sync-replica-v1"))
        print("Direct route identity, QR expiry, scopes and credential boundary tests passed")
    }
}
