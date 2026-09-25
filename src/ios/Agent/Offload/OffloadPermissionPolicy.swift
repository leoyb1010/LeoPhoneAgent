import Foundation
import CryptoKit

/// Pure offload-permission helpers compiled into MinisTests without SwiftUI.
enum OffloadPermissionPolicy {
    /// Privacy commands default to ask. Media/system stay bypass when unset.
    /// `stored` is nil when the UserDefaults key has never been written —
    /// `integer(forKey:)` returning 0 must not be treated as explicit Bypass.
    static func resolvedLevel(stored: Int?, isPrivacy: Bool) -> Int {
        if let stored { return stored }
        return isPrivacy ? 1 : 0 // askOnce : bypass
    }

    /// Find an `apple-*` offload even when it is not the first shell token
    /// (`/usr/local/bin/apple-files`, `env apple-camera`, `cd x && apple-files`).
    static func extractOffloadCommand(from shellCommand: String, known: [String]) -> String? {
        let names = Set(known)
        let tokens = shellCommand.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        for token in tokens {
            if names.contains(token) { return token }
            let base = (token as NSString).lastPathComponent
            if names.contains(base) { return base }
        }
        return nil
    }

    static func disabledDenial(command: String) -> String {
        "已拒绝：用户关闭了「\(command)」。可在设置 → 权限中重新打开，或点：[打开权限](leophoneagent://settings/permissions)"
    }

    static func timeoutDenial(command: String) -> String {
        "已拒绝：等待「\(command)」授权超时。可在设置中调整：[打开权限](leophoneagent://settings/permissions)"
    }

    static func declinedDenial(command: String) -> String {
        "已拒绝：用户拒绝了本会话的「\(command)」。可在设置中调整：[打开权限](leophoneagent://settings/permissions)"
    }
}

// Actual native argv, captured after execve. This is never a shell-text parser.
// The registered command is supplied by a fixed native dispatch slot, not argv[0].
struct OffloadPermissionInvocation: Equatable, Sendable {
    let registeredCommand: String
    let command: String
    let action: String
    let arguments: [String]

    init(command registeredCommand: String, arguments: [String]) {
        self.registeredCommand = registeredCommand
        self.arguments = arguments
        let parsed = registeredCommand == "apple-device"
            ? arguments.first(where: { !["--compact", "--quiet", "-q"].contains($0) })
            : Self.subcommand(arguments)
        var action = parsed ?? Self.defaults[registeredCommand] ?? "unknown"
        var command = registeredCommand
        // Only an explicit leading help request is exempt. A direct native
        // route may legitimately write a field whose value is "--help"; it
        // does not run the CLI handler's global help-flag shortcut.
        let first = arguments.first(where: { !["--compact", "--quiet", "-q"].contains($0) })
        if first == "--help" || first == "-h" {
            action = "help"
        } else if registeredCommand == "apple-open" {
            action = "open"
        } else if registeredCommand == "apple-calendar", let alias = Self.reminderAliases[action] {
            command = "apple-reminders"
            action = alias
        }
        self.command = command
        self.action = action
    }

    var isStatusOnly: Bool {
        if command == "apple-device", ["torch", "brightness"].contains(action),
           !arguments.contains("--set") { return true }
        return action == "help" || action == "status"
            || (command == "apple-speech" && action == "languages")
            || (command == "apple-speak" && action == "voices")
    }

    /// [T-smart-approve] What "smart approve" lets through without asking:
    /// reads that touch no personal data (weather, maps, device info, text
    /// analysis…). Reading contacts, photos, health, location, the clipboard or
    /// files still asks — "only reads" is not the same as "harmless".
    var isSmartApprovable: Bool {
        !isMutation && Self.nonPersonalCapabilities.contains(command)
    }

    private static let nonPersonalCapabilities: Set<String> = [
        "apple-device", "apple-weather", "apple-maps", "apple-media", "apple-nlp",
        "apple-vision", "apple-alarm", "apple-shortcuts", "apple-speak",
    ]

    var isMutation: Bool {
        if isStatusOnly { return false }
        if command == "apple-media", action == "volume" { return arguments.contains("--set") }
        return !(Self.readActions[command]?.contains(action) ?? false)
    }

    // A read approval does not authorize a write. Writes also bind the exact
    // native arguments, so a grant to edit one item cannot edit another item.
    var grantScope: String {
        let base = "\(command).\(action)"
        guard isMutation else { return base }
        let data = (try? JSONSerialization.data(withJSONObject: arguments)) ?? Data()
        return base + "." + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static let defaults = ["apple-device": "info", "apple-clipboard": "get",
                                   "apple-media": "now-playing", "apple-location": "current",
                                   "apple-weather": "current", "apple-files": "list",
                                   "apple-motion": "steps"]
    private static let reminderAliases = ["reminders": "list", "remind": "create",
                                          "update-reminder": "update", "complete-reminder": "complete",
                                          "delete-reminder": "delete"]
    private static let readActions: [String: Set<String>] = [
        "apple-healthkit": ["steps", "basal-energy", "heart-rate", "sleep", "workouts", "cadence", "elevation", "weight", "blood-oxygen", "blood-glucose", "hrv", "resting-heart-rate", "vo2-max", "nutrition", "summary", "types", "characteristic", "ecg", "audiogram", "vision-rx", "assessment", "state-of-mind", "batch"],
        "apple-calendar": ["list", "freebusy", "calendars"],
        "apple-reminders": ["list"],
        "apple-contacts": ["list", "search", "get", "groups"],
        "apple-photos": ["list", "near", "albums", "album", "stats", "export"],
        "apple-location": ["current", "geocode", "forward"],
        "apple-homekit": ["list", "search", "get", "scenes"],
        "apple-bluetooth": ["scan", "services", "read"],
        "apple-nfc": ["scan", "tag-info", "tag-read", "read-emv", "lookup-tag", "lookup-aid", "search"],
        "apple-clipboard": ["get"],
        "apple-files": ["list"],
        "apple-motion": ["steps", "activity"],
        "apple-shortcuts": ["list"],
        "apple-speech": ["transcribe"],
        "apple-player": ["list"],
        "apple-media": ["now-playing", "search", "volume"],
        "apple-device": ["info", "battery", "storage"],
        "apple-notification": ["pending", "delivered", "settings"],
        "apple-alarm": ["list"],
        "apple-maps": ["search", "route", "eta"],
        "apple-weather": ["current", "hourly", "daily", "alerts", "report"],
        "apple-nlp": ["language", "tokenize", "pos", "ner", "sentiment", "embed", "analyze"],
        "apple-vision": ["similarity", "overlap", "ocr", "barcode", "classify", "detect", "faces", "analyze"]
    ]

    // Matches noff_get_subcommand's actual argument consumption. A quoted value
    // is already a single argv element and shell operators are ordinary data.
    private static func subcommand(_ arguments: [String]) -> String? {
        var i = 0
        while i < arguments.count {
            let argument = arguments[i]
            if !argument.hasPrefix("-") { return argument }
            if argument.hasPrefix("--"), i + 1 < arguments.count,
               !arguments[i + 1].hasPrefix("-") { i += 1 }
            i += 1
        }
        return nil
    }
}

extension OffloadPermissionPolicy {
    static func isSameActiveRun(requestedRunID: String?, currentRunID: String?, isActive: Bool) -> Bool {
        guard isActive, let requestedRunID else { return false }
        return currentRunID == requestedRunID
    }

    static func resolvedNativeLevel(family: Int, actionOverride: Int?) -> Int {
        if family == 2 { return 2 } // A per-action grant never overrides a disabled family.
        return actionOverride.flatMap { (0...2).contains($0) ? $0 : nil } ?? family
    }
}

enum OffloadPermissionDecision: Equatable, Sendable {
    case allowed, denied, disabled, needsForeground, cancelled, timedOut, busy, unknownCapability

    var errorCode: String? {
        switch self {
        case .allowed: return nil
        case .denied, .disabled: return "authorization_denied"
        case .needsForeground: return "needs_foreground"
        case .cancelled: return "cancelled"
        case .timedOut: return "authorization_timeout"
        case .busy: return "authorization_busy"
        case .unknownCapability: return "unknown_capability"
        }
    }

    func message(command: String) -> String? {
        switch self {
        case .allowed: return nil
        case .disabled: return OffloadPermissionPolicy.disabledDenial(command: command)
        case .denied: return OffloadPermissionPolicy.declinedDenial(command: command)
        case .timedOut: return OffloadPermissionPolicy.timeoutDenial(command: command)
        case .needsForeground: return "需要在前台解锁 LeoPhoneAgent 后确认「\(command)」权限，请打开应用后重试。"
        case .cancelled: return "已取消「\(command)」授权，设备操作没有执行。"
        case .busy: return "等待授权的设备操作过多，请先处理当前请求后重试。"
        case .unknownCapability: return "设备能力「\(command)」尚未登记授权策略，操作未执行。"
        }
    }
}

/// The UI and native bridge share this bounded queue. The queue owns every
/// continuation until exactly one response/cancellation/timeout resolves it.
@MainActor
final class OffloadPermissionQueue {
    struct Pending: Equatable, Sendable {
        let id: String
        let invocation: OffloadPermissionInvocation
        let sessionID: String?
    }
    private struct Entry {
        let pending: Pending
        let continuation: CheckedContinuation<OffloadPermissionDecision, Never>
        let timeout: Task<Void, Never>
    }
    private var entries: [Entry] = []
    private let timeoutNanoseconds: UInt64
    var onChange: ((Pending?) -> Void)?
    var current: Pending? { entries.first?.pending }
    var count: Int { entries.count }

    init(timeoutNanoseconds: UInt64 = 30_000_000_000) {
        self.timeoutNanoseconds = timeoutNanoseconds
    }

    func enqueue(_ pending: Pending) async -> OffloadPermissionDecision {
        guard entries.count < 32 else { return .busy }
        return await withTaskCancellationHandler {
            guard !Task.isCancelled else { return .cancelled }
            return await withCheckedContinuation { continuation in
                let timeout = Task { @MainActor [weak self] in
                    guard let self else { return }
                    do { try await Task.sleep(nanoseconds: self.timeoutNanoseconds) }
                    catch { return }
                    self.cancel(where: { $0.id == pending.id }, decision: .timedOut)
                }
                entries.append(.init(pending: pending, continuation: continuation, timeout: timeout))
                onChange?(current)
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.cancel(where: { $0.id == pending.id }, decision: .cancelled)
            }
        }
    }

    func respond(id: String, decision: OffloadPermissionDecision) {
        guard current?.id == id else { return }
        cancel(where: { $0.id == id }, decision: decision)
    }

    func cancel(where predicate: (Pending) -> Bool, decision: OffloadPermissionDecision) {
        let resolved = entries.filter { predicate($0.pending) }
        guard !resolved.isEmpty else { return }
        entries.removeAll { predicate($0.pending) }
        resolved.forEach {
            $0.timeout.cancel()
            $0.continuation.resume(returning: decision)
        }
        onChange?(current)
    }
}
