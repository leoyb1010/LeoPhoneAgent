import Foundation
import CryptoKit

struct SyncDeliveryTicket: Codable, Equatable, Sendable {
    let destination: String; let recordType: String; let recordId: String; let revision: Int64
    let changeId: String; let operation: String; let updatedAt: Date
}
struct SyncTransportHealth {
    mutating func succeeded(_ operation: String) {}
    mutating func failed(_ operation: String, error: NSError) {}
}
enum SyncTransportError: Error { case notStarted; case fetchInFlight }
actor LeoAgentClient {
    let base: URL
    init(base: URL) { self.base = base }
    func replicaDeviceId() async -> String? { "6e412b31-4e87-414b-98d3-a293073b42da" }
    func replicaReady() async -> Bool { true }
    func replicaData(path: String, method: String = "GET", body: Data? = nil, requestId: String? = nil,
                     headers: [String:String] = [:]) async throws -> (Data, HTTPURLResponse) {
        var req = URLRequest(url: URL(string: base.absoluteString + path)!)
        req.httpMethod = method; req.httpBody = body
        for (key,value) in headers { req.setValue(value, forHTTPHeaderField:key) }
        let result = try await URLSession.shared.data(for:req)
        return (result.0, result.1 as! HTTPURLResponse)
    }
    func scenario(_ name: String) async throws {
        _ = try await replicaData(path: "/test/" + name, method: "POST")
    }
}
/// Replica-rebuild reseed hook (real one lives in SyncV2Bootstrap); records calls for assertions.
@MainActor enum SyncV2Bootstrap {
    static var reseeded: [String] = []
    static func startReplicaSeed(_ destination: String, restart: Bool = false) { if restart { reseeded.append(destination) } }
}

@main struct TailnetIOSmoke {
    @MainActor static func main() async throws {
        let client = LeoAgentClient(base: URL(string: CommandLine.arguments[1])!)
        let target = "6e412b31-4e87-414b-98d3-a293073b42da"
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("tailnet-io-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        func make(_ directory: String = "main", timeout: Double = 1) throws -> TailnetSyncTransport {
            try TailnetSyncTransport(client:client,targetDeviceId:target,stateDirectory:root.appendingPathComponent(directory),acknowledgementTimeout:timeout)
        }
        try await client.scenario("history")
        let transport = try make()
        let batch = try await transport.fetchChanges(trigger:.manual)
        precondition(batch.records.count == 1 && batch.deletes.isEmpty, "delete then recreate must yield latest record")
        do {
            try await transport.acknowledgeInbound(SyncInboundBatch(records:[],deletes:[],sourceDeviceId:nil))
            preconditionFailure("Unrelated batch may not advance checkpoint")
        } catch SyncTransportError.fetchInFlight {}
        let recovered = try make()
        let replay = try await recovered.fetchChanges(trigger:.manual)
        precondition(replay.records == batch.records)
        try await recovered.acknowledgeInbound(replay)
        let restarted = try make()
        let empty = try await restarted.fetchChanges(trigger:.manual)
        precondition(empty.records.isEmpty && empty.deletes.isEmpty)
        try await restarted.acknowledgeInbound(empty)
        try await client.scenario("reset")
        let reset = try await restarted.fetchChanges(trigger:.manual)
        precondition(reset.records.first?.id.id == "reset")
        try await restarted.acknowledgeInbound(reset)
        let checkpoint = try JSONSerialization.jsonObject(with:Data(contentsOf:root.appendingPathComponent("main/checkpoint.json"))) as! [String:Any]
        precondition(checkpoint["cursor"] as? Int == 1, "Replica reset must lower cursor after ACK")
        precondition(SyncV2Bootstrap.reseeded == [restarted.name], "Rebuilt replica must reseed this device's history")
        try await client.scenario("backwards")
        do { _ = try await restarted.fetchChanges(trigger:.manual); preconditionFailure("Backwards cursor accepted") }
        catch is URLError {}
        try await client.scenario("full")
        let full = try make("full")
        let pending = try await full.fetchChanges(trigger:.manual)
        precondition(pending.records.count == 1)
        var ids = [String]()
        full.observe { batch in
            ids += batch.records.map { $0.id.id }
            Task { @MainActor in try await full.acknowledgeInbound(batch) }
        }
        _ = try await full.fullFetch(trigger:.manual)
        precondition(ids == ["first", "first", "second"], "Recovered inbox must drain before full replay")
        let rejected = try make("no-ack",timeout:0.03)
        rejected.observe { _ in }
        do { _ = try await rejected.fullFetch(trigger:.manual); preconditionFailure("Missing ACK must not hang forever") }
        catch let error as URLError { precondition(error.code == .timedOut) }
        let retry = try make("no-ack")
        let retried = try await retry.fetchChanges(trigger:.manual)
        precondition(retried.records.first?.id.id == "first")
        try await client.scenario("asset")
        let withAsset = try make("assets")
        let first = try await withAsset.fetchChanges(trigger:.manual)
        let file = first.records[0].assets["body"]!.fileURL
        let downloaded = try Data(contentsOf:file)
        precondition(downloaded == Data("abcdef".utf8))
        try await withAsset.acknowledgeInbound(first)
        let local = root.appendingPathComponent("upload.bin")
        try Data("abcdef".utf8).write(to:local)
        let record = PortableRecord(id:.init(type:"MessageV2",id:"upload"),assets:["body":.init(key:"body",fileURL:local,size:6,mimeType:nil)],updatedAt:Date(timeIntervalSinceReferenceDate:1))
        let ticket = SyncDeliveryTicket(destination:withAsset.name,recordType:"MessageV2",recordId:"upload",revision:1,changeId:"upload-1",operation:"upsert",updatedAt:record.updatedAt)
        let result = try await withAsset.send(.init(records:[record],deletes:[],deliveryTickets:[record.id.description:ticket]),trigger:.manual)
        precondition(result == [.success(record.id)], "Real resumable upload must verify server completion and receipt")
        print("Tailnet IO smoke passed: atomic inbox replay/ACK, reset409, backwards rejection, full pagination, ACK timeout, asset download/hash and resumable upload")
    }
}
