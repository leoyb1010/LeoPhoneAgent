import Foundation

/// SSH 身份只来自用户经可信渠道粘贴的公钥，不从第一次网络连接自动信任。
/// 地址和端口变更会使旧的信任记录失效；无需修改或删除用户已有凭据。
enum RemoteSSHTrust {
    static func endpoint(host: String, port: Int) -> String {
        "[\(host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())]:\(port)"
    }

    static func normalizedPublicKey(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let fields = trimmed.split(whereSeparator: { $0.isWhitespace })
        guard fields.count >= 2,
              ["ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521"].contains(String(fields[0])),
              let bytes = Data(base64Encoded: String(fields[1])), !bytes.isEmpty,
              !trimmed.contains("\n"), !trimmed.contains("\r") else { return nil }
        return "\(fields[0]) \(fields[1])"
    }

    static func pinnedKey(host: String, port: Int, key: String?, trustedEndpoint: String?) -> String? {
        guard (1...65535).contains(port), trustedEndpoint == endpoint(host: host, port: port),
              let key else { return nil }
        return normalizedPublicKey(key)
    }

    static func singleQuoted(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// 网关与最终目标分别验证。仅使用本次显式 pin 创建私有临时 known_hosts，
    /// 不接受 accept-new，也不继承网关上其他目标的主机密钥信任。
    static func relayCommand(host: String, port: Int, username: String, publicKey: String, command: String) -> String? {
        guard (1...65535).contains(port), !host.isEmpty, !username.isEmpty,
              !host.hasPrefix("-"), !host.contains(where: { $0.isWhitespace || $0.isNewline }),
              !host.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              let key = normalizedPublicKey(publicKey) else { return nil }
        let knownHost = "leo-pinned-target \(key)"
        return "( leo_known_hosts=$(mktemp /tmp/leo-known-hosts.XXXXXX) || exit 255; "
            + "trap 'rm -f \"$leo_known_hosts\"' EXIT HUP INT TERM; "
            + "chmod 600 \"$leo_known_hosts\" || exit 255; "
            + "printf '%s\\n' \(singleQuoted(knownHost)) > \"$leo_known_hosts\" || exit 255; "
            + "ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o CheckHostIP=no "
            + "-o HostKeyAlias=leo-pinned-target -o UserKnownHostsFile=\"$leo_known_hosts\" "
            + "-o GlobalKnownHostsFile=/dev/null -o ConnectTimeout=8 -p \(port) "
            + "-l \(singleQuoted(username)) -- \(singleQuoted(host)) \(singleQuoted(command)) )"
    }
}
