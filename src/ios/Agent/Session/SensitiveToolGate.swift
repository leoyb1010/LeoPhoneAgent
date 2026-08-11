//
//  SensitiveToolGate.swift
//  MinisApp
//
//  [T-cred-approval] 敏感工具的按次审批闸。
//
//  审计画的外泄链:恶意网页文本 → 模型被提示调 get_cookies → 拿到含
//  HttpOnly 的登录凭证 → 写进 offload 文件 → shell/curl 外传。A2(系统
//  提示"网页=数据")堵了第一道,这是第二道:读凭证这个动作本身要人确认。
//
//  用户选的是"本会话允许一次":首次在前台弹确认,选「本会话允许」后
//  同类工具本会话不再问;选「允许一次」只放行这一次;选「拒绝」则拒绝。
//
//  关键安全设计——后台安全拒绝:后台任务、Siri 派发的会话没有前台 UI
//  可弹审批。naive 的同步审批闸会把它们**挂死**。所以没有前台时一律
//  拒绝(而不是等一个永远不会来的点击),并给出清楚的回执让模型转述:
//  "读取登录凭证需要在前台确认一次,请打开 app 后重试。"
//

import Foundation
import SwiftUI
import UIKit

@MainActor
final class SensitiveToolGate: ObservableObject {
    static let shared = SensitiveToolGate()

    /// 敏感工具类别。按"动作性质"分,而不是按具体工具名——将来加同类
    /// 工具落进同一类,授权语义一致。
    enum Category: String {
        case readCredentials    // 读 Cookie / 凭证
        case writeCredentials   // 写 Cookie(可劫持会话)

        var humanName: String {
            switch self {
            case .readCredentials: return "读取网站登录凭证(Cookie)"
            case .writeCredentials: return "写入网站登录凭证(Cookie)"
            }
        }
    }

    enum Decision {
        case allowOnce
        case allowSession
        case deny
    }

    /// 本会话已授予"整会话允许"的类别。会话切换即清空(见 resetSession)。
    private var sessionGrants: Set<String> = []

    /// 当前等待用户拍板的审批请求(前台时由聊天视图渲染成弹窗)。
    @Published var pending: PendingApproval?

    struct PendingApproval: Identifiable {
        let id = UUID()
        let category: Category
        let host: String           // 哪个站点的凭证
        let continuation: CheckedContinuation<Decision, Never>
    }

    private init() {}

    /// 会话切换时清空整会话授权 —— 授权不跨会话继承。
    func resetSession() {
        sessionGrants.removeAll()
        pending?.continuation.resume(returning: .deny)
        pending = nil
    }

    /// 请求执行一个敏感动作。返回是否放行。
    /// - host: 目标站点,给用户看"是哪个网站的凭证"。
    func authorize(_ category: Category, host: String) async -> Bool {
        // 本会话已整体允许
        if sessionGrants.contains(category.rawValue) { return true }

        // 后台安全拒绝:没有前台 UI 就不能弹审批,更不能挂起等待。
        guard UIApplication.shared.applicationState == .active else {
            return false
        }

        let decision = await withCheckedContinuation { (cont: CheckedContinuation<Decision, Never>) in
            self.pending = PendingApproval(category: category, host: host, continuation: cont)
        }

        switch decision {
        case .allowSession:
            sessionGrants.insert(category.rawValue)
            return true
        case .allowOnce:
            return true
        case .deny:
            return false
        }
    }

    /// 用户在弹窗上的选择回传。
    func resolve(_ decision: Decision) {
        guard let p = pending else { return }
        p.continuation.resume(returning: decision)
        pending = nil
    }

    /// 后台拒绝时给模型的回执文案。
    static let backgroundDeniedMessage =
        "读取/写入网站登录凭证需要你在前台确认一次。请打开 app 后重试这一步。"
}
