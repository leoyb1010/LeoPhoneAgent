//
//  GatewayError.swift
//  MinisApp
//
//  [T-leogateway] 手机连 Mac 网关时会抛出的错误。
//
//  原先和 LeoAgentClient 写在一个文件里;单独成文件(只依赖 Foundation)是为了让
//  逻辑测试包也能编进它——LeoLinkProblem 要把这些真实错误映射成「谁的问题 + 一个按钮」,
//  表驱动测试必须能直接构造真实的 GatewayError,而不是自己再造一个替身。
//

import Foundation

enum GatewayError: LocalizedError {
    case notConfigured
    case harnessNotConfigured
    case badURL
    case unauthorized
    case http(status: Int, message: String?)
    case resumeGap(minAfter: Int)
    case malformedResponse(String)
    /// The request was handed to a route (direct) that may have reached the Mac
    /// before the fallback failed; the outcome is unknown, never "not sent".
    case uncertainAfterDirectAttempt

    var errorDescription: String? {
        switch self {
        case .uncertainAfterDirectAttempt:
            return String(localized: "直连已发出但没有收到回应，中继也连不上；这条的结果未确认。")
        case .notConfigured:
            return String(localized: "No Mac is connected.")
        case .harnessNotConfigured:
            // The engine and the harness service listen on different ports;
            // pointing harness traffic at the engine used to 404 (or worse,
            // read as "no CLI installed"). Now it is a named setup step.
            return String(localized: "This Mac has no harness address set. Edit the Mac and fill in the LeoAgent service address (port 8647).")
        case .badURL:
            return String(localized: "That Mac address is not a valid URL.")
        case .unauthorized:
            // Deliberately no key echo — this string reaches logs and UI.
            return String(localized: "密钥被拒绝。在那台 Mac 的终端里运行 cat ~/.leoagent/key,把结果重新粘贴到「设置 → 远程机器」。")
        case .http(let status, let message):
            if let message, !message.isEmpty {
                return String(localized: "LeoAgent error \(status): \(message)")
            }
            return String(localized: "LeoAgent error \(status)")
        case .resumeGap:
            return String(localized: "Remote events expired; resyncing from the available watermark.")
        case .malformedResponse(let detail):
            return String(localized: "Unexpected response from LeoAgent: \(detail)")
        }
    }
}
