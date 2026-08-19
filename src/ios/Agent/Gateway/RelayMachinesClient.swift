import Foundation

struct RelayDiscoveredMachine: Equatable, Sendable {
    let name: String
    let online: Bool
    let platform: String?
    let server: String?
    let version: String?

    var isAndroidBody: Bool { platform == "android" || server == "minis" }
}

enum RelayDiscoveryError: Error {
    case unauthorized
    case badURL
    case http(Int)
    case malformed
}

enum RelayMachinesClient {
    static let defaultApiRoot = "https://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/api"

    static func parse(_ data: Data) throws -> [RelayDiscoveredMachine] {
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw RelayDiscoveryError.malformed
        }
        let rows = obj["machines"] as? [[String: Any]] ?? []
        return rows.compactMap { row in
            guard let name = row["name"] as? String, !name.isEmpty else { return nil }
            return RelayDiscoveredMachine(
                name: name,
                online: row["online"] as? Bool ?? true,
                platform: row["platform"] as? String,
                server: row["server"] as? String,
                version: row["version"] as? String
            )
        }
    }

    static func list(apiRoot: String = defaultApiRoot, key: String) async throws -> [RelayDiscoveredMachine] {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 16 else { throw RelayDiscoveryError.unauthorized }
        guard var parts = URLComponents(string: apiRoot.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            throw RelayDiscoveryError.badURL
        }
        let basePath = parts.path.hasSuffix("/") ? String(parts.path.dropLast()) : parts.path
        parts.path = basePath + "/machines"
        guard let url = parts.url, url.scheme?.lowercased() == "https" else { throw RelayDiscoveryError.badURL }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(trimmed)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.timeoutInterval = 12
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw RelayDiscoveryError.malformed
        }
        if http.statusCode == 401 || http.statusCode == 403 { throw RelayDiscoveryError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
            throw RelayDiscoveryError.http(http.statusCode)
        }
        return try parse(data)
    }

    static func harnessURL(for machine: String, apiRoot: String = defaultApiRoot) -> String {
        let root = normalizeApiRoot(apiRoot)
        return root + "/m/" + machine
    }

    static func normalizeApiRoot(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    static func sameApiRoot(_ lhs: String, _ rhs: String) -> Bool {
        normalizeApiRoot(lhs).lowercased() == normalizeApiRoot(rhs).lowercased()
    }

    static func apiRoot(fromHarnessURL raw: String?) -> String? {
        guard let raw, let range = raw.range(of: "/m/", options: .backwards) else { return nil }
        let root = normalizeApiRoot(String(raw[..<range.lowerBound]))
        guard root.lowercased().hasPrefix("https://") else { return nil }
        return root
    }

    static func sanitizeMachine(_ raw: String) -> String? {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= 80 else { return nil }
        guard name.rangeOfCharacter(from: CharacterSet(charactersIn: "/\\?#%")) == nil else { return nil }
        guard !name.contains("..") else { return nil }
        return name
    }

    static func displayName(for machine: String) -> String {
        switch machine {
        case "LeoyuandeMacBook-Pro-2": return "MacBook Pro"
        case "LeodeMac-mini-2": return "Mac mini · cortex"
        case "LeoMac-Studio-2": return "Mac Studio"
        default: return machine
        }
    }
}

/// QR / paste payload for adding a body. Key never goes in the code.
struct RelayPairPayload: Equatable, Sendable {
    static let prefix = "leoagent-body:v1|"

    let apiRoot: String
    let machine: String

    var harnessURL: String {
        RelayMachinesClient.harnessURL(for: machine, apiRoot: apiRoot)
    }

    func encode() -> String {
        let obj: [String: String] = [
            "apiRoot": apiRoot.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
            "machine": machine,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let json = String(data: data, encoding: .utf8) else {
            return Self.prefix + "{\"apiRoot\":\"\",\"machine\":\"\"}"
        }
        return Self.prefix + json
    }

    static func parse(_ raw: String) -> RelayPairPayload? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let jsonText: String
        if text.hasPrefix(prefix) {
            jsonText = String(text.dropFirst(prefix.count))
        } else if text.hasPrefix("{") {
            jsonText = text
        } else {
            return nil
        }
        guard let data = jsonText.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        let apiRoot = (obj["apiRoot"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/")) ?? ""
        let machine = RelayMachinesClient.sanitizeMachine(obj["machine"] as? String ?? "") ?? ""
        guard !apiRoot.isEmpty, !machine.isEmpty else { return nil }
        guard apiRoot.lowercased().hasPrefix("https://") else { return nil }
        return RelayPairPayload(apiRoot: apiRoot, machine: machine)
    }
}
