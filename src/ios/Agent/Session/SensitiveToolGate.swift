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
//  [T-gate-bg-policy] 后台策略按类别分级,不再一刀切硬拒。
//  ------------------------------------------------------------------
//  这个闸最早只管 Cookie 读写:低频、高危、要求用户回前台确认完全合理,
//  所以写了一条"没有前台就直接拒"的硬规则。后来 shell_execute /
//  file_write / file_edit / remote_* 也被并进来,那条硬规则就成了产品级
//  故障:
//    · app 明确用 beginBackgroundTask("AgentLoop") + 静音保活 +
//      AgentContinuedProcessingManager 让 agent 循环在锁屏后继续跑,
//      「手机休眠后任务继续执行」是主打能力;
//    · 一旦切走/锁屏,下一条 shell 或 file_write 被拒 → 整轮任务结束;
//    · Siri / 快捷指令派发的会话根本没有前台,第一条命令就死;
//    · .inactive(下拉通知中心、来电横幅、App 切换器)同样被拒 → 随机失败。
//
//  现在的分级:
//    · readCredentials / writeCredentials / remoteShell / remoteAgent
//      —— 高危且低频,后台仍然直接拒,并回一句让模型转述的人话。
//      读写登录凭证、以及在别人的机器上执行命令/起 Agent,值得用户
//      专门回一次前台。
//    · shell / fileWrite —— 这两条是本机 iSH 沙盒内的操作,也是任务能不能
//      跑完的命脉。后台不再硬拒:先沿用本会话已有授权;没有授权就把请求
//      挂进队列、发一条本地通知叫用户回来处理,并给一个超时上限(到点判拒,
//      而不是让 agent 循环永远挂着)。这与 ConfigConfirmationGate 后台等待
//      审批的做法是同一套。
//
//  [T-gate-scope] 展示用的 host 和授权用的 key 从这一版起分开:
//    · hostHint  —— 弹窗上给人看的,尽量具体。
//    · grantScope —— 参与 grantKey 的,按"这次授权到底该覆盖多大范围"取。
//  本机 shell / 文件写是会话级授权(一轮任务几十条命令,按命令逐条问等于
//  不可用);remote_* 保持逐条授权,并且用**完整**命令/参数的 SHA-256,
//  不再截断——截断意味着模型只要先拿到一条 ≥160 字符良性命令的"本会话
//  允许",再往后追加 `; rm -rf ~` 就能免审批执行。remote_agent 还要把
//  workdir 算进去:实际执行的是 `zsh -lc 'cd <workdir> && ...'`,换个目录
//  就是另一件事。
//

import CryptoKit
import Foundation
import SwiftUI
import UIKit
// @preconcurrency:UNUserNotificationCenter / UNNotificationCategory 至今没标
// Sendable,注册类别那段闭包会因此报三条 Sendable 警告。编译器自己给的
// 建议就是这个标注,行为不变。
@preconcurrency import UserNotifications

@MainActor
final class SensitiveToolGate: ObservableObject {
    static let shared = SensitiveToolGate()

    /// 后台(无前台 UI)时对某一类别的处理方式。
    enum BackgroundPolicy: Equatable {
        /// 直接拒绝,并让模型转述"请回前台确认一次"。
        case denyImmediately
        /// 挂起等待 + 本地通知提醒,超时判拒。
        case notifyAndWait
    }

    /// 敏感工具类别。按"动作性质"分,而不是按具体工具名——将来加同类
    /// 工具落进同一类,授权语义一致。
    enum Category: String {
        case readCredentials    // 读 Cookie / 凭证
        case writeCredentials   // 写 Cookie(可劫持会话)
        case fileWrite          // 写/改文件
        case shell              // 本机终端
        case remoteShell        // 远程主机终端
        case remoteAgent        // 远程主机 Agent

        var humanName: String {
            switch self {
            case .readCredentials: return "读取网站登录凭证(Cookie)"
            case .writeCredentials: return "写入网站登录凭证(Cookie)"
            case .fileWrite: return "写入或修改本机文件"
            case .shell: return "在本机执行终端命令"
            case .remoteShell: return "在远程主机执行终端命令"
            case .remoteAgent: return "在远程主机启动 Agent 任务"
            }
        }

        /// 见文件头 [T-gate-bg-policy]。
        var backgroundPolicy: BackgroundPolicy {
            switch self {
            case .shell, .fileWrite:
                return .notifyAndWait
            case .readCredentials, .writeCredentials, .remoteShell, .remoteAgent:
                return .denyImmediately
            }
        }

        static func forToolName(_ name: String) -> Category? {
            switch name {
            case "file_write", "file_edit": return .fileWrite
            case "shell_execute": return .shell
            case "remote_shell": return .remoteShell
            case "remote_agent": return .remoteAgent
            default: return nil
            }
        }

        /// 弹窗上显示给用户看的目标。只用于展示,不参与授权键。
        static func hostHint(tool: String, args: [String: Any]) -> String {
            switch tool {
            case "file_write", "file_edit":
                if let path = args["path"] as? String, !path.isEmpty {
                    return (path as NSString).standardizingPath
                }
                return "本机文件"
            case "shell_execute":
                if let command = args["command"] as? String {
                    let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmed.isEmpty { return String(trimmed.prefix(160)) }
                }
                return "本机终端"
            case "remote_shell", "remote_agent":
                let host = (args["host"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                    .nilIfEmpty ?? "未指定主机"
                let detailKey = tool == "remote_shell" ? "command" : "prompt"
                let detail = (args[detailKey] as? String)?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .nilIfEmpty ?? "空任务"
                return "\(host) · \(String(detail.prefix(160)))"
            default:
                return "本机"
            }
        }

        /// 参与 grantKey 的授权范围。见文件头 [T-gate-scope]。
        ///
        /// - 本机 shell / 文件写:会话级常量。用户点一次「本会话允许」就覆盖
        ///   这一轮任务的全部本机命令/写文件;按命令逐条授权在真实任务里
        ///   等于要点几十次,不是安全设计而是不可用。
        /// - remote_*:逐条授权,键里放**完整**内容的 SHA-256(不截断),
        ///   remote_agent 额外把 workdir 算进去。
        static func grantScope(tool: String, args: [String: Any]) -> String {
            switch tool {
            case "file_write", "file_edit":
                return "local-file"
            case "shell_execute":
                return "local-shell"
            case "remote_shell":
                let host = normalizedHost(args["host"])
                let command = (args["command"] as? String) ?? ""
                return "\(host)|sha256:\(Self.digest(command))"
            case "remote_agent":
                let host = normalizedHost(args["host"])
                let workdir = (args["workdir"] as? String) ?? ""
                let prompt = (args["prompt"] as? String) ?? ""
                // workdir 与 prompt 之间用 \u{0} 分隔:普通文本不会含 NUL,
                // 拼接歧义(workdir="a", prompt="b" 与 workdir="a\nb", prompt="")
                // 就不会撞成同一个哈希。
                return "\(host)|sha256:\(Self.digest(workdir + "\u{0}" + prompt))"
            default:
                return "本机"
            }
        }

        private static func normalizedHost(_ raw: Any?) -> String {
            ((raw as? String)?.trimmingCharacters(in: .whitespacesAndNewlines))
                .flatMap { $0.isEmpty ? nil : $0.lowercased() } ?? "未指定主机"
        }

        static func digest(_ text: String) -> String {
            SHA256.hash(data: Data(text.utf8))
                .map { String(format: "%02x", $0) }
                .joined()
        }
    }

    enum Decision {
        case allowOnce
        case allowSession
        case deny
    }

    /// 审批结果。拒绝的原因要区分开——回给模型的话术不一样,而且
    /// 「后台拒绝」不能让模型当成"用户不同意"去改方案。
    enum Outcome {
        case allowed
        /// 用户明确拒绝。
        case deniedByUser
        /// 后台硬拒类别(凭证 / 远程执行)。
        case deniedInBackground
        /// 后台等待审批超时。
        case deniedByTimeout

        var isAllowed: Bool { if case .allowed = self { return true }; return false }
    }

    /// 后台等待用户回来批准的上限。到点判拒而不是无限挂起:进程随时可能
    /// 被系统挂起,continuation 一旦被冻住,整条 agent run 表现为"卡死"。
    static let backgroundWaitTimeout: TimeInterval = 180

    /// 本会话已授予"整会话允许"的「动作类别 + 授权范围」。会话切换即清空。
    /// 不能只按类别授权，否则给 example.com 的 Cookie 放行会顺带放行
    /// bank.example；个人自用也不该用这种隐式扩大来换便利。
    private var sessionGrants: Set<String> = []

    /// 当前等待用户拍板的审批请求(前台时由聊天视图渲染成弹窗)。
    @Published var pending: PendingApproval?
    private var queued: [PendingApproval] = []
    /// 已发过后台提醒通知的请求 id,避免重复打扰。
    private var notifiedIds: Set<UUID> = []
    private var timeoutTasks: [UUID: Task<Void, Never>] = [:]
    private var didEnterBackgroundObserver: NSObjectProtocol?
    private var didBecomeActiveObserver: NSObjectProtocol?

    /// [T-gate-bg-policy] 本次"离开前台"期间已经等超时过的类别。
    ///
    /// 没有这一条,一轮几十条命令的任务在用户睡着时会变成:每条命令各发一次
    /// 通知、各等满 180 秒 —— 二十条就是一小时的假装在跑,比旧的一刀切硬拒
    /// 还难受。所以只赌一次:同一类别在后台超时过一次,后续同类请求直接判拒
    /// (话术仍是"超时",告诉模型批准后可以重试),让任务尽快收尾。
    /// 用户回到前台即清空 —— 下次再离开时重新给一次机会。
    private var backgroundTimedOutCategories: Set<Category> = []

    struct PendingApproval: Identifiable {
        let id = UUID()
        let category: Category
        let host: String           // 展示用:哪个站点 / 哪条命令
        let grantScope: String     // 授权键用:这次放行覆盖多大范围
        let continuation: CheckedContinuation<Outcome, Never>
    }

    private init() {
        // 前台弹出的审批,用户如果直接切走就再也看不到了——切到后台时
        // 补一条通知,顺便给它套上超时,别让循环无限挂着。
        didEnterBackgroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let request = self.pending else { return }
                guard request.category.backgroundPolicy == .notifyAndWait else { return }
                self.notifyIfNeeded(request)
                self.armTimeoutIfNeeded(request)
            }
        }
        didBecomeActiveObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.backgroundTimedOutCategories.removeAll()
            }
        }
    }

    private func grantKey(_ category: Category, scope: String) -> String {
        "\(category.rawValue)|\(scope.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())"
    }

    /// 会话切换时清空整会话授权 —— 授权不跨会话继承。
    func resetSession() {
        sessionGrants.removeAll()
        timeoutTasks.values.forEach { $0.cancel() }
        timeoutTasks.removeAll()
        notifiedIds.removeAll()
        backgroundTimedOutCategories.removeAll()
        pending?.continuation.resume(returning: .deniedByUser)
        pending = nil
        queued.forEach { $0.continuation.resume(returning: .deniedByUser) }
        queued.removeAll()
    }

    /// 请求执行一个敏感动作。
    /// - host: 给用户看的目标(站点 / 命令摘要)。
    /// - grantScope: 参与授权键的范围;不传就等同于 host(Cookie 那条路径
    ///   本来就是"按站点授权",host 即 scope)。
    func authorize(_ category: Category, host: String, grantScope: String? = nil) async -> Outcome {
        let scope = grantScope ?? host
        let key = grantKey(category, scope: scope)
        // 本会话已整体允许
        if sessionGrants.contains(key) { return .allowed }

        if UIApplication.shared.applicationState != .active {
            // 后台硬拒类别:没有前台 UI 就不能弹审批,更不能挂起等待。
            if category.backgroundPolicy == .denyImmediately {
                return .deniedInBackground
            }
            // 这一类在本次后台期间已经等超时过一次,不再逐条重复等待。
            if backgroundTimedOutCategories.contains(category) {
                return .deniedByTimeout
            }
        }

        return await withCheckedContinuation { (cont: CheckedContinuation<Outcome, Never>) in
            let request = PendingApproval(
                category: category, host: host, grantScope: scope, continuation: cont)
            if self.pending == nil {
                self.pending = request
                if UIApplication.shared.applicationState != .active {
                    // 后台等待型:通知用户回来处理,并起超时。
                    self.notifyIfNeeded(request)
                    self.armTimeoutIfNeeded(request)
                }
            } else {
                // 多工具并发时排队，不能覆盖 pending;覆盖会让前一个
                // continuation 永远不恢复,整条 agent run 看起来像"卡死"。
                self.queued.append(request)
            }
        }
    }

    /// 用户在弹窗上的选择回传。
    ///
    /// 幂等设计:SwiftUI alert 的按钮 action 和 isPresented dismiss setter
    /// 会各回调一次(顺序未定义),第二次必须是 no-op,不能误裁决队列里
    /// 刚被提升的下一条请求。传 `requestId` 时只对该请求生效;当前 pending
    /// 已被裁决(或已换成别的请求)则直接忽略。
    func resolve(_ decision: Decision, requestId: UUID? = nil) {
        guard let p = pending else { return }
        if let requestId, requestId != p.id { return }
        if case .allowSession = decision {
            sessionGrants.insert(grantKey(p.category, scope: p.grantScope))
        }
        let outcome: Outcome = {
            switch decision {
            case .allowOnce, .allowSession: return .allowed
            case .deny: return .deniedByUser
            }
        }()
        finish(p, outcome: outcome)
    }

    /// 超时判拒:和用户点「拒绝」区分开,回给模型的话术不同。
    private func timeOut(requestId: UUID) {
        guard let p = pending, p.id == requestId else { return }
        backgroundTimedOutCategories.insert(p.category)
        finish(p, outcome: .deniedByTimeout)
    }

    private func finish(_ p: PendingApproval, outcome: Outcome) {
        timeoutTasks.removeValue(forKey: p.id)?.cancel()
        notifiedIds.remove(p.id)
        clearNotification(for: p)
        p.continuation.resume(returning: outcome)
        pending = nil
        // 推迟到下一个 runloop 再提升队列下一条:同一轮里 alert 还没
        // 完全 dismiss,同步换 pending 会让迟到的 dismiss 回调打在新
        // 请求上,也会让 SwiftUI 的呈现状态和数据打架。
        Task { @MainActor in
            self.presentNextIfNeeded()
        }
    }

    private func presentNextIfNeeded() {
        while pending == nil, !queued.isEmpty {
            let next = queued.removeFirst()
            let key = grantKey(next.category, scope: next.grantScope)
            if sessionGrants.contains(key) {
                next.continuation.resume(returning: .allowed)
            } else if UIApplication.shared.applicationState != .active,
                      next.category.backgroundPolicy == .denyImmediately {
                next.continuation.resume(returning: .deniedInBackground)
            } else if UIApplication.shared.applicationState != .active,
                      backgroundTimedOutCategories.contains(next.category) {
                // 同一类别本次后台已经等超时过,排队里的同类不再各等一轮。
                next.continuation.resume(returning: .deniedByTimeout)
            } else {
                pending = next
                if UIApplication.shared.applicationState != .active {
                    notifyIfNeeded(next)
                    armTimeoutIfNeeded(next)
                }
            }
        }
    }

    // MARK: - 后台等待:通知 + 超时

    private static let notifyCategoryId = "SENSITIVE_TOOL_PENDING"

    private func armTimeoutIfNeeded(_ request: PendingApproval) {
        guard timeoutTasks[request.id] == nil else { return }
        let id = request.id
        timeoutTasks[id] = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.backgroundWaitTimeout * 1_000_000_000))
            guard !Task.isCancelled else { return }
            guard let self, self.pending?.id == id else { return }
            self.timeOut(requestId: id)
        }
    }

    private func notifyIfNeeded(_ request: PendingApproval) {
        guard !notifiedIds.contains(request.id) else { return }
        notifiedIds.insert(request.id)

        let center = UNUserNotificationCenter.current()
        // [T-siri-approval-notify] set 是整体替换;并集注册,别抹掉其他类别的按钮。
        let category = UNNotificationCategory(
            identifier: Self.notifyCategoryId, actions: [], intentIdentifiers: [])
        center.getNotificationCategories { existing in
            center.setNotificationCategories(existing.union([category]))
        }

        let content = UNMutableNotificationContent()
        content.title = "任务需要你确认一下"
        content.body = "「\(request.category.humanName)」在等你批准:\(String(request.host.prefix(80)))"
        content.sound = .default
        content.categoryIdentifier = Self.notifyCategoryId
        content.userInfo = ["sensitiveToolApprovalId": request.id.uuidString]

        center.add(UNNotificationRequest(
            identifier: Self.notificationId(request),
            content: content,
            trigger: nil))
    }

    private func clearNotification(for request: PendingApproval) {
        let ids = [Self.notificationId(request)]
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: ids)
        center.removePendingNotificationRequests(withIdentifiers: ids)
    }

    private static func notificationId(_ request: PendingApproval) -> String {
        "sensitive-tool-\(request.id.uuidString)"
    }

    /// 后台硬拒类别的回执文案。
    nonisolated static let backgroundDeniedMessage =
        "这个操作需要你在前台确认一次。请打开 app 后重试这一步。"

    /// 后台等待审批超时的回执文案。和上面分开:超时说明通知已经发出去过,
    /// 用户只是没来得及处理,重试是有意义的。
    nonisolated static let backgroundTimeoutMessage =
        "等你确认这一步超时了(已经发过一条通知)。打开 app 批准后就能继续。"

    /// 给模型的拒绝回执。
    nonisolated static func denialMessage(_ outcome: Outcome, category: Category, host: String) -> String {
        switch outcome {
        case .allowed:
            return ""
        case .deniedInBackground:
            return backgroundDeniedMessage
        case .deniedByTimeout:
            return backgroundTimeoutMessage
        case .deniedByUser:
            return "用户拒绝了「\(category.humanName)」(\(host))。不要重试同一动作,改用人话说明需要许可。"
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
