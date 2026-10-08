import Foundation

/// [B4] 网络失败的细分类:决定怎么重试,也写进诊断日志。
enum LLMNetworkFailure: Equatable, Sendable {
    /// -1005:连接中途断了(常见于切网、飞行模式开关)。
    case connectionLost
    /// -1009 等:手机现在没网。
    case notConnected
    case timedOut
    case cancelled
    /// 服务端 5xx;取不到状态码时为 0。
    case server(status: Int)
    case other
}

extension LLMError {
    var networkFailure: LLMNetworkFailure? {
        switch self {
        case .networkError(let underlying): return Self.classify(underlying)
        case .transientError(let message, let code): return .server(status: code ?? Self.serverStatus(in: message) ?? 0)
        case .cancelled: return .cancelled
        default: return nil
        }
    }

    static func classify(_ error: Error) -> LLMNetworkFailure {
        let ns = error as NSError
        guard ns.domain == NSURLErrorDomain else { return .other }
        switch ns.code {
        case NSURLErrorNetworkConnectionLost: return .connectionLost
        case NSURLErrorNotConnectedToInternet, NSURLErrorDataNotAllowed, NSURLErrorInternationalRoamingOff:
            return .notConnected
        case NSURLErrorTimedOut: return .timedOut
        case NSURLErrorCancelled: return .cancelled
        default: return .other
        }
    }

    /// 从 "HTTP 503: …" / "Gemini API error 502: …" / "[529] …" 里取第一个 5xx 状态码。
    static func serverStatus(in message: String) -> Int? {
        var digits = ""
        for ch in message + " " {
            if ch.isASCII, ch.isNumber { digits.append(ch); continue }
            if digits.count == 3, let code = Int(digits), (500...599).contains(code) { return code }
            digits = ""
        }
        return nil
    }
}

/// [B2][B3][B4] 打开模型流失败后的重试策略与展示,纯函数(编进 App 和 MinisTests)。
enum LLMRetryPolicy {
    enum Wait: Equatable, Sendable {
        /// 不等,马上再试。
        case immediate
        /// 手机没网:等网络恢复再试,不空转倒计时(最多等 `maxSeconds`)。
        case untilNetwork(maxSeconds: Int)
        /// 照常倒计时。
        case countdown(seconds: Int)
    }

    static let networkWaitLimit = 60

    /// [T-fallback-503-budget] Short budget for a 5xx the SERVER answered with, used
    /// only when the group has another member to fall back to: 2s + 5s instead of the
    /// full 63s ladder that read as "fallback never happened".
    static let serverCapacityDelays = [2, 5]

    /// Retry budget on the current model before the group falls back. Statusless
    /// transients (dropped link, DNS, TTFB stall, empty response) keep the full ladder —
    /// switching models does not fix them — and so does a session with nowhere to go.
    static func delays(for error: Error, hasFallbackTarget: Bool, full: [Int]) -> [Int] {
        guard hasFallbackTarget, (error as? LLMError)?.isServerCapacityTransient == true else { return full }
        return serverCapacityDelays
    }

    /// - Parameters:
    ///   - failure: 上一次失败的分类。
    ///   - attempt: 即将进行的第几次重试(从 1 起)。
    ///   - immediateUsed: 本次请求里是否已经用过一次"立刻重试"。
    static func wait(after failure: LLMNetworkFailure?, attempt: Int, immediateUsed: Bool,
                     delays: [Int]) -> Wait {
        switch failure {
        case .connectionLost? where !immediateUsed:
            // 还没收到任何字节就断开:多半是旧连接死了,立刻换新连接重试一次。
            return .immediate
        case .notConnected?:
            return .untilNetwork(maxSeconds: networkWaitLimit)
        default:
            let index = min(max(attempt, 1), delays.count) - 1
            return .countdown(seconds: delays.isEmpty ? 0 : delays[index])
        }
    }

    /// [B3] 对话状态卡与灵动岛上的文案。
    static func reconnectingLabel(attempt: Int) -> String {
        "重连中 · 第 \(attempt) 次"
    }

    /// [B2] 倒计时结束、准备重试:把这次的失败原因收进"已恢复"列表再清空 error。
    /// 列表最多留 `recoveredLimit` 条,每条截断到 200 字。
    static let recoveredLimit = 10

    static func recover(error: inout String?, into recovered: inout [String]) {
        guard let reason = error?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty else {
            error = nil
            return
        }
        recovered.append(String(reason.prefix(200)))
        if recovered.count > recoveredLimit { recovered.removeFirst(recovered.count - recoveredLimit) }
        error = nil
    }

    /// [B2] 消息底部那行小字。
    static func recoveredSummary(count: Int) -> String {
        "中途断开 \(count) 次,已自动恢复"
    }
}
