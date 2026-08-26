import Foundation

enum ProviderExportSecrets {
    static let keys = ["apiKey", "manualOAuthToken", "oauthToken", "oauthEmail", "oauthGcpProject"]

    static func stripped(_ dict: [String: Any]) -> [String: Any] {
        var out = dict
        for key in keys { out.removeValue(forKey: key) }
        return out
    }
}

enum SessionWorkspaceBindStore {
    static func load(from url: URL) -> [String: String] {
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: String] else {
            return [:]
        }
        return obj
    }

    static func save(_ map: [String: String], to url: URL) {
        guard let data = try? JSONSerialization.data(withJSONObject: map, options: [.prettyPrinted]) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
