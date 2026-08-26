import Foundation

struct RelayDiscoveredMachine: Equatable, Sendable {
    let name: String
    let online: Bool
    let platform: String?
    let server: String?
    let version: String?

    var isAndroidBody: Bool { platform == "android" || server == "minis" }
}

struct RelayCredentialCandidate: Equatable, Sendable {
    let harnessURL: String?
    let key: String?
}

struct RelayCredential: Equatable, Sendable {
    let apiRoot: String
    let key: String
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
            // Relay rows historically put platform/server at the top level.
            // Current leocodebox `/machines` nests them under `info`.
            // Read both so Android-as-body still classifies when either shape arrives.
            return RelayDiscoveredMachine(
                name: name,
                online: row["online"] as? Bool ?? true,
                platform: nestedOrTop(row, "platform"),
                server: nestedOrTop(row, "server"),
                version: nestedOrTop(row, "version")
            )
        }
    }

    static func join(apiRoot: String, token: String) async throws -> (key: String, machine: String) {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw RelayDiscoveryError.malformed }
        guard var parts = URLComponents(string: normalizeApiRoot(apiRoot)) else {
            throw RelayDiscoveryError.badURL
        }
        let basePath = parts.path.hasSuffix("/") ? String(parts.path.dropLast()) : parts.path
        parts.path = basePath + "/join"
        guard let url = parts.url, url.scheme?.lowercased() == "https" else { throw RelayDiscoveryError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["token": trimmed])
        req.timeoutInterval = 12
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw RelayDiscoveryError.malformed }
        if http.statusCode == 401 || http.statusCode == 403 { throw RelayDiscoveryError.unauthorized }
        guard (200..<300).contains(http.statusCode) else { throw RelayDiscoveryError.http(http.statusCode) }
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let key = obj["accessKey"] as? String,
              key.count >= 16 else {
            throw RelayDiscoveryError.malformed
        }
        return (key, obj["machine"] as? String ?? "")
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

    /// [T-relay-key-fallback] 去重判据是「中继根 + 密钥」,不再是「中继根」。
    ///
    /// 原来只按 apiRoot 去重,同一个中继根下只保留第一台主机的密钥。于是
    /// hosts[0] 的密钥一旦过期/写坏,整条发现链就 401 到底,即使 hosts[1]
    /// 存着一把好的也永远轮不到——没有任何回退。改成保留同一根下的多把
    /// 不同密钥(顺序不变),调用方可以逐把试。
    /// `credential(matching:)` 仍然取第一条匹配,行为不变。
    static func credentials(from candidates: [RelayCredentialCandidate]) -> [RelayCredential] {
        var seen = Set<String>()
        return candidates.compactMap { candidate in
            guard let root = apiRoot(fromHarnessURL: candidate.harnessURL),
                  let key = candidate.key?.trimmingCharacters(in: .whitespacesAndNewlines),
                  key.count >= 16 else { return nil }
            let normalized = normalizeApiRoot(root).lowercased() + "\u{0}" + key
            guard seen.insert(normalized).inserted else { return nil }
            return RelayCredential(apiRoot: root, key: key)
        }
    }

    static func credential(
        matching apiRoot: String,
        from candidates: [RelayCredentialCandidate]
    ) -> RelayCredential? {
        credentials(from: candidates).first { sameApiRoot($0.apiRoot, apiRoot) }
    }

    /// `platform` / `server` / `version` may sit at the row root or under `info`.
    static func nestedOrTop(_ row: [String: Any], _ key: String) -> String? {
        if let direct = row[key] as? String, !direct.isEmpty { return direct }
        if let info = row["info"] as? [String: Any],
           let nested = info[key] as? String, !nested.isEmpty {
            return nested
        }
        return nil
    }

    /// Match a stored host to a relay machine id. Display names like
    /// "MacBook Pro" must not win over the real hostname `LeoyuandeMacBook-Pro-2`.
    static func hostMatches(hostId: String, displayName: String, machine: String) -> Bool {
        let needle = machine.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return false }
        let lower = needle.lowercased()
        if hostId.lowercased() == lower { return true }
        if let sanitized = sanitizeMachine(needle), sanitized.lowercased() == hostId.lowercased() {
            return true
        }
        if displayName == needle || displayName.lowercased() == lower { return true }
        if Self.displayName(for: needle) == displayName { return true }
        return false
    }

    static func pickHostIndex(
        hostIds: [String],
        displayNames: [String],
        hostId: String,
        machine: String
    ) -> Int? {
        if !hostId.isEmpty, let i = hostIds.firstIndex(where: { $0 == hostId }) {
            return i
        }
        for i in hostIds.indices {
            if hostMatches(hostId: hostIds[i], displayName: displayNames[i], machine: machine) {
                return i
            }
        }
        if hostIds.count == 1 { return 0 }
        return nil
    }
}

/// QR / paste payload for adding a body. Key never goes in the code.
struct RelayPairPayload: Equatable, Sendable {
    static let prefix = "leoagent-body:v1|"
    static let prefixV2 = "leoagent-body:v2|"

    let apiRoot: String
    let machine: String
    let join: String?
    let exp: Double?

    var harnessURL: String {
        RelayMachinesClient.harnessURL(for: machine, apiRoot: apiRoot)
    }

    func encode() -> String {
        var obj: [String: Any] = [
            "apiRoot": apiRoot.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
            "machine": machine,
        ]
        if let join, !join.isEmpty {
            obj["join"] = join
            if let exp { obj["exp"] = exp }
        }
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let json = String(data: data, encoding: .utf8) else {
            return Self.prefix + "{\"apiRoot\":\"\",\"machine\":\"\"}"
        }
        return (join?.isEmpty == false ? Self.prefixV2 : Self.prefix) + json
    }

    static func parse(_ raw: String) -> RelayPairPayload? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let jsonText: String
        if text.hasPrefix(prefixV2) {
            jsonText = String(text.dropFirst(prefixV2.count))
        } else if text.hasPrefix(prefix) {
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
        let join = (obj["join"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let exp = obj["exp"] as? Double ?? (obj["exp"] as? Int).map(Double.init)
        return RelayPairPayload(
            apiRoot: apiRoot,
            machine: machine,
            join: join?.isEmpty == false ? join : nil,
            exp: exp
        )
    }
}
