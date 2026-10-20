import Foundation

/// [fix-remote] 直连与中继都连不上时的 SSH 兜底：经 tailnet 直接 SSH 到 Mac，在登录 shell 里无界面跑所选 CLI，
/// 把输出当成一轮回复流式显示。没有审批；claude / codex 的工具调用显示成工具行，下一轮用 CLI 报的会话号续上上下文。
enum MacSSHFallback {
    static let notice = "当前为 SSH 兜底：直连和中继都连不上，经 Tailscale 直接在 Mac 上跑。没有审批；消息按顺序一轮一轮执行，Claude Code / Codex 会接着上一轮的上下文。"

    /// 这台 Mac 现在能不能走 SSH 兜底（有目标、有固定的主机公钥、有这台 iPhone 的钥匙、CLI 支持）。
    @MainActor
    static func readiness(hostId: String?, cliKey: String) -> (RemoteHost?, String?) {
        guard let hostId, let host = GatewayHostStore.shared.hosts.first(where: { $0.id == hostId }) else {
            return (nil, "找不到这台 Mac 的配置")
        }
        guard SSHFallbackCLI.supports(cliKey) else { return (nil, "SSH 兜底只能跑 Claude Code / Codex / Gemini / opencode / Grok") }
        guard let target = host.resolvedSSHTarget else { return (nil, "不知道这台 Mac 的 SSH 地址：在 设置 → 远程机器 里填") }
        guard let key = host.sshHostKey else { return (nil, "还没固定这台 Mac 的 SSH 主机公钥：先经直连或中继连上一次") }
        // 导入的私钥也算：只导入、没生成设备钥匙的用户同样能走兜底。
        guard RemoteHostStore.hasAnyKey else { return (nil, "这台 iPhone 还没有 SSH 钥匙：到 设置 → 远程主机 生成或导入") }
        let address = target.address
        // 端口不能写死 22:目标里有就用,否则用「远程主机」里关联到这台 Mac 的那条配置的端口。
        let deviceId = host.device?.deviceId
        let configured = deviceId.flatMap { id in RemoteHostStore.shared.hosts.first { $0.deviceId == id }?.port }
        let port = MacSSHTarget.port(target: target, configured: configured)
        let remote = RemoteHost(
            id: "leo-ssh-fallback-" + host.id, name: host.name, host: address, port: port, username: target.user,
            deviceId: deviceId, trustedHostKey: key,
            trustedHostKeyEndpoint: RemoteSSHTrust.endpoint(host: address, port: port))
        return (remote, nil)
    }

    /// 跑一轮；每行解析出的正文 / 工具 / 会话号回调给界面。返回失败说明（nil = 成功）。
    static func run(remote: RemoteHost, hostId: String, cliKey: String, prompt: String, cwd: String,
                    fullAuto: Bool, resumeId: String?,
                    onEvent: @escaping @Sendable (SSHFallbackEvent) async -> Void) async -> String? {
        guard let command = SSHFallbackCLI.command(key: cliKey, prompt: prompt, cwd: cwd,
                                                   fullAuto: fullAuto, resumeId: resumeId) else { return "不支持这个 CLI" }
        let started = Date()
        let result = await RemoteSSHExecutor.shared.stream(host: remote, command: command, timeout: 1800) { line in
            for event in SSHFallbackCLI.events(key: cliKey, line: line) { await onEvent(event) }
        }
        await GatewayHostStore.shared.recordPath(
            id: hostId, route: .ssh, success: result.succeeded,
            latencyMilliseconds: result.succeeded ? Int(Date().timeIntervalSince(started) * 1000) : nil)
        return result.succeeded ? nil : result.output
    }

    /// 什么样的失败值得退到 SSH：连不上、超时、中继说 Mac 不在线。钥匙被拒、Mac 拒绝这类不是路的问题。
    static func isRouteFailure(_ error: Error) -> Bool {
        if let url = error as? URLError {
            return [.cannotConnectToHost, .cannotFindHost, .dnsLookupFailed, .timedOut, .networkConnectionLost,
                    .secureConnectionFailed].contains(url.code)
        }
        if case GatewayError.http(let status, _) = error { return [502, 503, 504, 530].contains(status) }
        return false
    }
}
