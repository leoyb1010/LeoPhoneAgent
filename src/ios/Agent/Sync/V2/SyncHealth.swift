import Foundation

/// 只保留诊断所需的结构化字段，禁止把可能含正文/凭据的 userInfo 原样展示。
struct SyncFailure: Equatable {
    let operation: String
    let occurredAt: Date
    let domain: String
    let code: Int
    let underlyingDomain: String?
    let underlyingCode: Int?
    let httpStatus: Int?
    let requestID: String?

    init(operation: String, error: NSError, at now: Date = Date()) {
        self.operation = operation
        occurredAt = now
        domain = Self.safeDomain(error.domain)
        code = error.code
        let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError
        underlyingDomain = underlying.map { Self.safeDomain($0.domain) }
        underlyingCode = underlying?.code
        let status = (error.userInfo["CKHTTPStatus"] ?? underlying?.userInfo["CKHTTPStatus"]) as? Int
        httpStatus = status.flatMap { (100...599).contains($0) ? $0 : nil }
        let request = (error.userInfo["RequestUUID"] ?? underlying?.userInfo["RequestUUID"]) as? String
        requestID = request.flatMap { UUID(uuidString: $0)?.uuidString }
    }

    var diagnostic: String {
        var parts = ["\(domain) \(code)"]
        if let underlyingDomain, let underlyingCode { parts.append("\(underlyingDomain) \(underlyingCode)") }
        if let httpStatus { parts.append("HTTP \(httpStatus)") }
        if let requestID { parts.append("Request \(requestID)") }
        return parts.joined(separator: " · ")
    }

    private static func safeDomain(_ value: String) -> String {
        guard value.count <= 100, value.range(of: "^[A-Za-z0-9_.-]+$", options: .regularExpression) != nil else { return "Error" }
        return value
    }
}

struct SyncTransportHealth {
    enum State: Equatable {
        case starting, healthy, degraded, unavailable

        var localizedLabel: String {
            switch self {
            case .starting: return String(localized: "Starting")
            case .healthy: return String(localized: "Sync available")
            case .degraded: return String(localized: "Some sync operations need attention")
            case .unavailable: return String(localized: "Sync connection unavailable")
            }
        }
    }

    private(set) var lastContactAt: Date?
    private(set) var lastSendAt: Date?
    private(set) var lastFetchAt: Date?
    private(set) var issues: [String: SyncFailure] = [:]

    var state: State {
        let wholeFailure = issues.values.filter {
            !["query:", "save:", "zone:"].contains(where: $0.operation.hasPrefix)
        }.map(\.occurredAt).max()
        if let wholeFailure, wholeFailure > (lastContactAt ?? .distantPast) { return .unavailable }
        if !issues.isEmpty { return .degraded }
        return lastContactAt == nil ? .starting : .healthy
    }

    mutating func failed(_ operation: String, error: NSError, at now: Date = Date()) {
        issues[operation] = SyncFailure(operation: operation, error: error, at: now)
    }

    mutating func succeeded(_ operation: String, at now: Date = Date()) {
        lastContactAt = now
        issues.removeValue(forKey: operation)
        if operation == "send" || operation == "fetch" {
            issues.removeValue(forKey: "initialize")
            issues.removeValue(forKey: "probe")
        }
        if operation == "send" { lastSendAt = now }
        if operation == "fetch" { lastFetchAt = now }
    }
}
