import Foundation

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
