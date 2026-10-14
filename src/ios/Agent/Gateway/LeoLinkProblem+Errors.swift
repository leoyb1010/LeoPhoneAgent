//
//  LeoLinkProblem+Errors.swift
//  MinisApp
//
//  [T-link-problem] 把 Agent/Gateway 里真实会抛出的错误翻译成 LeoLinkProblem.Signal,
//  再交给 LeoLinkProblem.swift 里的分类表。
//
//  来源(逐个核对过会不会真的抛出):
//  - GatewayError:LeoAgentClient.validate / pumpEvents、LeoAgentHarness.pumpHarness、
//    RelayEventCatchUp.relayEvents、LeoAgentRouting(直连回落中继)、GatewayHostStore.pairDirect
//  - RelayDiscoveryError:RelayMachinesClient.list / join
//  - URLError:URLSession 层(中继与直连)。LeoAgentRouting 里 directOnly 失败抛 URLError(.cannotConnectToHost)
//  - 解析失败:JSONSerialization 的 NSCocoaErrorDomain 3840(中继地址指到了网页)、DecodingError
//

import Foundation

extension LeoLinkProblem {

    /// 失败时用户该看到什么。`context` 说明这次在做什么、目标主机是谁(用来认 Tailscale 地址)。
    /// 取消(CancellationError / URLError.cancelled)是用户离开了页面,调用方应先用 `isCancellation` 排除。
    static func from(error: Error, context: Context = Context()) -> LeoLinkProblem {
        var context = context
        let (found, detail) = signal(for: error, context: &context)
        return from(signal: found, detail: detail, context: context)
    }

    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        return (error as? URLError)?.code == .cancelled
    }

    // MARK: 错误 → Signal

    private static func signal(for error: Error, context: inout Context) -> (Signal, String) {
        switch error {
        case let error as GatewayError:
            return signal(for: error)
        case let error as RelayDiscoveryError:
            switch error {
            case .unauthorized: return (.unauthorized, "RelayDiscoveryError.unauthorized")
            case .badURL: return (.badURL, "RelayDiscoveryError.badURL")
            case .malformed: return (.malformed, "RelayDiscoveryError.malformed")
            case .http(let status): return (.http(status: status, message: nil), "HTTP \(status)")
            }
        case let error as URLError:
            // URLError 自带的失败地址比调用方猜的更准(直连回落中继时目标会变)。
            if let host = error.failingURL?.host, !host.isEmpty { context.host = host }
            return (signal(for: error), urlErrorDetail(error, host: context.host))
        case is CancellationError:
            return (.cancelled, "CancellationError")
        default:
            let nsError = error as NSError
            // JSON 解析失败(NSCocoaErrorDomain 3840)与 DecodingError:拿到的不是预期的 JSON。
            if (nsError.domain == NSCocoaErrorDomain && nsError.code == 3840) || error is DecodingError {
                return (.malformed, "无法解析回应(\(nsError.domain) \(nsError.code))")
            }
            return (.other, "\(type(of: error)): \(error.localizedDescription)")
        }
    }

    private static func signal(for error: GatewayError) -> (Signal, String) {
        switch error {
        case .notConfigured:
            return (.notConfigured, "GatewayError.notConfigured")
        case .harnessNotConfigured:
            return (.addressMissing, "GatewayError.harnessNotConfigured")
        case .badURL:
            return (.badURL, "GatewayError.badURL")
        case .unauthorized:
            return (.unauthorized, "GatewayError.unauthorized")
        case .http(let status, let message):
            let text = (message ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return (.http(status: status, message: message), text.isEmpty ? "HTTP \(status)" : "HTTP \(status): \(text)")
        case .resumeGap(let minAfter):
            return (.eventsExpired, "GatewayError.resumeGap(minAfter: \(minAfter))")
        case .malformedResponse(let detail):
            return (.malformed, "GatewayError.malformedResponse: \(detail)")
        case .uncertainAfterDirectAttempt:
            return (.deliveryUnconfirmed, "GatewayError.uncertainAfterDirectAttempt")
        }
    }

    private static func signal(for error: URLError) -> Signal {
        switch error.code {
        case .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff, .callIsActive:
            return .phoneOffline
        case .timedOut:
            return .timedOut
        case .cannotConnectToHost, .networkConnectionLost:
            return .connectFailed
        case .cannotFindHost, .dnsLookupFailed:
            return .hostNotFound
        case .serverCertificateUntrusted, .serverCertificateHasUnknownRoot,
             .clientCertificateRejected, .clientCertificateRequired:
            return .tlsCertificate
        case .serverCertificateHasBadDate, .serverCertificateNotYetValid:
            return .tlsClock
        case .secureConnectionFailed:
            return .tlsHandshake
        case .badURL, .unsupportedURL, .appTransportSecurityRequiresSecureConnection,
             .httpTooManyRedirects, .redirectToNonExistentLocation:
            return .badURL
        case .userAuthenticationRequired:
            return .unauthorized
        case .cancelled:
            return .cancelled
        default:
            // badServerResponse / cannotParseResponse 等是传输层的异常:HTTP/2 流被掐断、代理吐出半截响应时
            // 都会出现(-1011 / -1017),瞬时居多。不能当「版本对不上」暂停重连,按未知的瞬时故障退避重试。
            return .other
        }
    }

    /// 只带主机名,不带路径和查询串:URLError 的 failingURL 可能带参数。
    private static func urlErrorDetail(_ error: URLError, host: String?) -> String {
        var detail = "URLError \(error.code.rawValue): \(error.localizedDescription)"
        if let host, !host.isEmpty { detail += " · \(host)" }
        return detail
    }
}
