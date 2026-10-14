import SwiftUI
import UIKit

/// [T-link-problem] 连接失败的统一呈现:「是谁的问题」徽章 + 一句话 + 唯一的主按钮,技术细节折叠。
/// 设置页的机器行、Mac 控制台、编辑页的「测试连接」、一键添加共用这一块。
///
/// 复用现成的 LeoInlineError(一句话 + 「重试」)和 LeoCapsuleBadge;主按钮是「重试」时就是
/// LeoInlineError 自带的那个,其它动作用同一宽度的实心按钮。
/// 主按钮按场景给处理函数:某个动作在这个场景里没有对应的处理(例如编辑页、控制台里不能改地址 / 扫码),
/// 退回「重试」——用户在别处处理完回来,点一下就是重新连;连「重试」都没有时才不显示按钮,
/// 宁可不给按钮,也不给一个点了没用的按钮。
struct LeoLinkProblemView: View {
    let problem: LeoLinkProblem
    /// 正在重新检测:主按钮置灰,避免连点叠出多个探测。
    var isBusy = false
    /// 「重试」在每个场景里含义不同(重新探测 / 重连 / 重新发现),由调用方给。
    var onRetry: (() -> Void)?
    /// 扫码配对:设置页和控制台各有入口。
    var onRescan: (() -> Void)?
    /// 去改地址(主机编辑页)。
    var onEditAddress: (() -> Void)?
    /// 任何主按钮点下时先调:调用方借此解除这台主机「等用户处理」的暂停,让轮询重新开始。
    var onActed: (() -> Void)?

    @State private var showDetail = false
    @State private var showRepairGuide = false

    var body: some View {
        VStack(alignment: .leading, spacing: LeoTheme.Spacing.xs) {
            LeoCapsuleBadge(text: problem.owner.blame, systemImage: problem.owner.symbol, tint: tint)
            LeoInlineError(message: problem.message,
                           retryTitle: action.title,
                           retryDisabled: isBusy,
                           onRetry: inlineRetry)
            actionButton
            if !problem.technicalDetail.isEmpty { details }
        }
        .accessibilityElement(children: .contain)
        .alert("在 Mac 上重新配对", isPresented: $showRepairGuide) {
            if let onRescan { Button("扫码") { onRescan() } }
            Button(onRescan == nil ? "好" : "取消", role: .cancel) {}
        } message: {
            Text("1. 在 Mac 的 LeoBot 打开「连接手机」，出示配对二维码。\n2. 回到这里点「扫码」。")
        }
    }

    /// 这个场景里真正能做的主按钮:问题给出的动作有处理就用它,没有就退回「重试」。
    private var action: LeoLinkProblem.PrimaryAction {
        if problem.primaryAction == .retry || handler(for: problem.primaryAction) != nil { return problem.primaryAction }
        return .retry
    }

    /// 主按钮是「重试」时:LeoInlineError 自带的那个按钮就是主按钮。
    private var inlineRetry: (() -> Void)? {
        guard action == .retry, let onRetry else { return nil }
        return {
            onActed?()
            onRetry()
        }
    }

    @ViewBuilder private var actionButton: some View {
        if action != .retry, let handler = handler(for: action) {
            Button {
                onActed?()
                handler()
            } label: {
                Label(action.title, systemImage: action.symbol)
                    .font(.footnote.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: LeoTheme.TouchTarget.minimum)
            }
            .buttonStyle(.borderedProminent)
            .disabled(isBusy)
        }
    }

    private func handler(for action: LeoLinkProblem.PrimaryAction) -> (() -> Void)? {
        switch action {
        case .retry: return onRetry
        case .openTailscale: return { Self.openTailscale() }
        case .repairOnMac: return { showRepairGuide = true }
        case .rescan: return onRescan
        case .checkRelayAddress: return onEditAddress
        case .copyDiagnostics: return { copyDiagnostics() }
        }
    }

    private var details: some View {
        DisclosureGroup(isExpanded: $showDetail) {
            VStack(alignment: .leading, spacing: LeoTheme.Spacing.xs) {
                Text(verbatim: problem.technicalDetail)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if action != .copyDiagnostics {
                    Button { copyDiagnostics() } label: {
                        Label("复制诊断信息", systemImage: "doc.on.doc").font(.caption)
                    }
                    .buttonStyle(.borderless)
                }
            }
            .padding(.top, LeoTheme.Spacing.xxs)
        } label: {
            Text("技术细节")
                .font(.caption)
                .foregroundStyle(LeoTheme.ColorToken.secondaryText)
        }
    }

    /// 可重试的问题用橙色(过一会儿多半就好),要用户动手的用红色。
    private var tint: Color {
        problem.retryable ? LeoTheme.ColorToken.warning : LeoTheme.ColorToken.destructive
    }

    private func copyDiagnostics() {
        UIPasteboard.general.string = problem.diagnosticsText
        LeoHaptics.notification(.success)
    }

    /// 直接拉起 Tailscale;没装(拉不起来)就去 App Store。
    /// `tailscale://` 只是打开 App,不带任何指令,Tailscale 不允许其它 App 通过它控制 VPN,所以仍要用户自己点连接。
    @MainActor
    static func openTailscale() {
        guard let app = URL(string: "tailscale://") else { return }
        UIApplication.shared.open(app, options: [:]) { opened in
            guard !opened, let store = URL(string: "https://apps.apple.com/app/tailscale/id1470499037") else { return }
            UIApplication.shared.open(store)
        }
    }
}

private extension LeoLinkProblem.Owner {
    var symbol: String {
        switch self {
        case .iPhone: return "iphone"
        case .mac: return "desktopcomputer"
        case .network: return "wifi.exclamationmark"
        case .relay: return "server.rack"
        }
    }
}

private extension LeoLinkProblem.PrimaryAction {
    var symbol: String {
        switch self {
        case .retry: return "arrow.clockwise"
        case .openTailscale: return "arrow.up.forward.app"
        case .repairOnMac: return "desktopcomputer"
        case .rescan: return "qrcode.viewfinder"
        case .checkRelayAddress: return "link"
        case .copyDiagnostics: return "doc.on.doc"
        }
    }
}
