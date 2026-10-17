//
//  MailWatch.swift
//  MinisApp
//
//  [T-mail-watch] 邮件监控:按规则盯收件箱,来了符合条件的新邮件就发本地通知,
//  也可以发出「新邮件」情境信号交给自动化。
//
//  检查时机:App 回到前台(距上次超过 5 分钟)、后台刷新(BGAppRefreshTask,最早 15 分钟一次,
//  实际由系统决定)、规则页「立即检查」、mail_watch 工具的 check_now。iOS 不允许 App 在后台常驻
//  连着 IMAP(IDLE),所以这不是实时推送,说明里要讲清楚。
//
//  只看收件箱、只拉信头(BODY.PEEK,不改已读)。每个邮箱记一个游标(UIDVALIDITY + 已看到的最大 UID):
//  第一次只建游标、不提醒旧邮件;UIDVALIDITY 变了就重建游标。
//  自动化回合拿不到邮件内容(信号里只有规则名),在那种回合里也不能发信、改信(ContextToolPolicy)。
//

import Foundation
import UIKit
import BackgroundTasks
@preconcurrency import UserNotifications

struct MailWatchRule: Codable, Identifiable, Equatable {
    var id: String = UUID().uuidString.lowercased()
    var name: String
    /// nil = 所有邮箱。
    var account: String?
    /// 发件人(名字或地址)包含这些字之一;空 = 不限。多个用逗号分开。
    var fromContains: String = ""
    /// 主题包含这些字之一;空 = 不限。
    var subjectContains: String = ""
    var isEnabled: Bool = true
    var notify: Bool = true
    /// 命中时发出情境信号「新邮件」和「新邮件:<规则名>」。
    var triggerAutomation: Bool = false

    func applies(toAccount email: String) -> Bool {
        guard let account, !account.trimmingCharacters(in: .whitespaces).isEmpty else { return true }
        return account.caseInsensitiveCompare(email) == .orderedSame
    }

    func matches(from: [MailAddress], subject: String) -> Bool {
        let fromHit = Self.keywords(fromContains).isEmpty || Self.keywords(fromContains).contains { key in
            from.contains { $0.email.localizedCaseInsensitiveContains(key) || $0.name.localizedCaseInsensitiveContains(key) }
        }
        let subjectHit = Self.keywords(subjectContains).isEmpty || Self.keywords(subjectContains).contains {
            subject.localizedCaseInsensitiveContains($0)
        }
        return fromHit && subjectHit
    }

    static func keywords(_ raw: String) -> [String] {
        raw.split(whereSeparator: { $0 == "," || $0 == "，" || $0 == ";" || $0 == "；" })
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    /// 情境信号名:自动化规则里选「新邮件」(任何规则命中)或填「新邮件:规则名」(只这一条)。
    var signalName: String { "\(MailWatchLogic.signal):\(name)" }
}

struct MailWatchCursor: Codable, Equatable {
    var uidValidity: Int
    var lastUID: Int
}

/// 纯逻辑:游标怎么推进、这次要看哪些 UID。
enum MailWatchLogic {
    static let signal = "新邮件"
    /// 一次最多处理的新邮件数(积压很多时只看最新的这些,其余只推进游标)。
    static let maxPerCheck = 30
    static let foregroundInterval: TimeInterval = 5 * 60
    static let backgroundInterval: TimeInterval = 15 * 60

    enum Step: Equatable {
        /// 第一次 / UIDVALIDITY 变了:只建游标,不提醒。
        case baseline(MailWatchCursor)
        /// 有新邮件:去拉 UID 大于 after 的信。
        case fetch(after: Int)
        case nothingNew
    }

    static func step(validity: Int?, uidNext: Int?, cursor: MailWatchCursor?) -> Step {
        guard let validity, let uidNext else {
            // 服务器不报 UIDVALIDITY / UIDNEXT:没法安全判断新旧,就当没有新信。
            return .nothingNew
        }
        guard let cursor, cursor.uidValidity == validity else {
            return .baseline(MailWatchCursor(uidValidity: validity, lastUID: max(0, uidNext - 1)))
        }
        return uidNext - 1 > cursor.lastUID ? .fetch(after: cursor.lastUID) : .nothingNew
    }

    /// 拉回来的 UID 里真正新的那些(UID SEARCH n:* 至少会回最后一封,哪怕它不新),只留最新的 maxPerCheck 封。
    static func newUIDs(_ uids: [Int], after last: Int) -> [Int] {
        Array(uids.filter { $0 > last }.sorted().suffix(maxPerCheck))
    }

    /// 命中的规则(按规则顺序,每封信只算第一条命中的规则)。
    static func firstMatch(_ rules: [MailWatchRule], account: String, from: [MailAddress], subject: String) -> MailWatchRule? {
        rules.first { $0.isEnabled && $0.applies(toAccount: account) && $0.matches(from: from, subject: subject) }
    }
}

// MARK: - Store

@MainActor
final class MailWatchStore: ObservableObject {
    static let shared = MailWatchStore()

    @Published private(set) var rules: [MailWatchRule] = []
    @Published private(set) var lastCheckAt: Date?
    @Published private(set) var lastSummary: String?

    private let fileURL: URL
    private static let cursorsKey = "leo.mailWatch.cursors.v1"

    private init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        fileURL = support.appendingPathComponent("mail-watch-rules.json")
        if let data = try? Data(contentsOf: fileURL),
           let decoded = try? JSONDecoder().decode([MailWatchRule].self, from: data) {
            rules = decoded
        }
    }

    var hasActiveRules: Bool { rules.contains(where: \.isEnabled) }

    func upsert(_ rule: MailWatchRule) {
        if let i = rules.firstIndex(where: { $0.id == rule.id }) { rules[i] = rule } else { rules.append(rule) }
        persist()
        MailWatcher.shared.scheduleBackgroundRefresh()
        // 第一次建规则时要通知权限(已决定过的不会再弹)。
        if rule.notify {
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        }
    }

    func delete(id: String) {
        rules.removeAll { $0.id == id }
        persist()
    }

    func cursor(for account: String) -> MailWatchCursor? {
        let all = UserDefaults.standard.dictionary(forKey: Self.cursorsKey) as? [String: [String: Int]] ?? [:]
        guard let raw = all[account.lowercased()], let v = raw["v"], let u = raw["u"] else { return nil }
        return MailWatchCursor(uidValidity: v, lastUID: u)
    }

    func setCursor(_ cursor: MailWatchCursor, for account: String) {
        var all = UserDefaults.standard.dictionary(forKey: Self.cursorsKey) as? [String: [String: Int]] ?? [:]
        all[account.lowercased()] = ["v": cursor.uidValidity, "u": cursor.lastUID]
        UserDefaults.standard.set(all, forKey: Self.cursorsKey)
    }

    func recordCheck(summary: String) {
        lastCheckAt = Date()
        lastSummary = summary
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(rules) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }
}

// MARK: - Watcher

@MainActor
final class MailWatcher {
    static let shared = MailWatcher()
    static let refreshTaskId = "com.leoyuan.leophoneagent.mailwatch"

    private let logger = AppLogger(category: "MailWatch")
    /// 命中「触发自动化」的规则时调用(信号名, 是否锁屏)。App 启动时接到 AutomationEngine;
    /// 这里不直接引用它,好让这个文件能编进逻辑测试 target。
    var onSignal: ((String, Bool) -> Void)?
    private var running = false
    private var registered = false
    private var activeObserver: NSObjectProtocol?

    /// 启动结束前调用(AppDelegate didFinishLaunching):注册后台刷新、挂回前台检查。
    func start() {
        if !registered {
            registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshTaskId, using: nil) { task in
                guard let refresh = task as? BGAppRefreshTask else { task.setTaskCompleted(success: false); return }
                Task { @MainActor in MailWatcher.shared.handle(refresh) }
            }
            if !registered { logger.warning("register rejected — identifier missing from Info.plist?") }
        }
        activeObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in await MailWatcher.shared.checkIfDue(reason: "foreground") }
        }
        scheduleBackgroundRefresh()
    }

    func scheduleBackgroundRefresh() {
        guard registered, MailWatchStore.shared.hasActiveRules else { return }
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshTaskId)
        request.earliestBeginDate = Date().addingTimeInterval(MailWatchLogic.backgroundInterval)
        do { try BGTaskScheduler.shared.submit(request) } catch {
            logger.warning("schedule failed: \(error.localizedDescription)")
        }
    }

    private func handle(_ task: BGAppRefreshTask) {
        scheduleBackgroundRefresh()
        let work = Task { @MainActor in
            _ = await self.checkNow(reason: "background")
            task.setTaskCompleted(success: true)
        }
        task.expirationHandler = { work.cancel() }
    }

    func checkIfDue(reason: String) async {
        guard MailWatchStore.shared.hasActiveRules else { return }
        if let last = MailWatchStore.shared.lastCheckAt,
           Date().timeIntervalSince(last) < MailWatchLogic.foregroundInterval { return }
        _ = await checkNow(reason: reason)
    }

    /// 检查一遍所有相关邮箱,返回给人看的摘要。并发调用直接跳过。
    @discardableResult
    func checkNow(reason: String) async -> String {
        guard !running else { return "正在检查中" }
        let store = MailWatchStore.shared
        let rules = store.rules.filter(\.isEnabled)
        guard !rules.isEmpty else { return "没有启用的监控规则" }
        running = true
        defer { running = false }
        let accounts = MailAccountStore.shared.enabledAccounts.filter { account in
            rules.contains { $0.applies(toAccount: account.email) }
        }
        var hits = 0, newCount = 0
        var errors: [String] = []
        var firedSignals = Set<String>()
        for account in accounts {
            if Task.isCancelled { break }
            do {
                let client = try await MailService.openClient(for: account)
                defer { Task { await client.close() } }
                let state = try await client.examineState(mailbox: "INBOX")
                switch MailWatchLogic.step(validity: state.uidValidity, uidNext: state.uidNext,
                                           cursor: store.cursor(for: account.email)) {
                case .baseline(let cursor):
                    store.setCursor(cursor, for: account.email)
                case .nothingNew:
                    break
                case .fetch(let after):
                    let uids = MailWatchLogic.newUIDs(try await client.uidSearch([.keyword("UID \(after + 1):*")]), after: after)
                    let summaries = try await client.fetchSummaries(uids: uids)
                    newCount += summaries.count
                    for s in summaries.sorted(by: { $0.uid < $1.uid }) {
                        guard let rule = MailWatchLogic.firstMatch(rules, account: account.email, from: s.from, subject: s.subject) else { continue }
                        hits += 1
                        if rule.notify { notify(rule: rule, account: account, summary: s) }
                        if rule.triggerAutomation {
                            firedSignals.insert(MailWatchLogic.signal)
                            firedSignals.insert(rule.signalName)
                        }
                    }
                    let newest = max(after, uids.max() ?? after, (state.uidNext ?? after + 1) - 1)
                    if let validity = state.uidValidity {
                        store.setCursor(MailWatchCursor(uidValidity: validity, lastUID: newest), for: account.email)
                    }
                }
                await MailService.recordSuccess(account)
            } catch {
                errors.append("\(account.email):\(error.localizedDescription)")
            }
        }
        let locked = !UIApplication.shared.isProtectedDataAvailable
        for signal in firedSignals.sorted() {
            onSignal?(signal, locked)
        }
        let summary = errors.isEmpty
            ? "检查了 \(accounts.count) 个邮箱:新邮件 \(newCount) 封,命中规则 \(hits) 封"
            : "检查了 \(accounts.count) 个邮箱,\(errors.count) 个出错:\(errors.joined(separator: ";"))"
        store.recordCheck(summary: summary)
        logger.info("[Check] reason=\(reason) accounts=\(accounts.count) new=\(newCount) hits=\(hits) errors=\(errors.count)")
        return summary
    }

    private func notify(rule: MailWatchRule, account: MailAccount, summary: IMAPMessageSummary) {
        let content = UNMutableNotificationContent()
        content.title = AppLocalized("新邮件 · \(rule.name)")
        let from = summary.from.first.map { $0.name.isEmpty ? $0.email : $0.name } ?? account.email
        content.body = "\(from):\(summary.subject.isEmpty ? AppLocalized("(无主题)") : summary.subject)"
        content.sound = .default
        content.threadIdentifier = "mail-watch"
        let request = UNNotificationRequest(identifier: "mail-\(account.email)-\(summary.uid)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}

// MARK: - mail_watch 工具

enum MailWatchTool {
    @MainActor
    static func execute(from json: String) async -> (output: String, success: Bool) {
        let args = MailService.jsonDictionary(json)
        let store = MailWatchStore.shared
        switch (args["action"] as? String) ?? "list" {
        case "list":
            guard !store.rules.isEmpty else {
                return ("No mail watch rules yet. Add one with action=add (e.g. name + from_contains).", true)
            }
            let lines = store.rules.map { r in
                "- \(r.name)\(r.isEnabled ? "" : " (paused)"): account=\(r.account ?? "all"), from~[\(r.fromContains)], subject~[\(r.subjectContains)], notify=\(r.notify), automation=\(r.triggerAutomation)"
            }
            let last = store.lastCheckAt.map { "Last check: \($0.formatted(date: .abbreviated, time: .shortened)) — \(store.lastSummary ?? "")" } ?? "Not checked yet."
            return ((lines + [last]).joined(separator: "\n"), true)
        case "add":
            let name = ((args["name"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { return ("Error: add needs `name`.", false) }
            var account = (args["account"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let wanted = account, !wanted.isEmpty {
                guard let hit = MailAccountStore.shared.account(matching: wanted) else {
                    return ("Error: no authorized mailbox matches \"\(wanted)\".", false)
                }
                account = hit.email
            } else {
                account = nil
            }
            var rule = store.rules.first(where: { $0.name == name }) ?? MailWatchRule(name: name)
            rule.account = account
            rule.fromContains = (args["from_contains"] as? String) ?? ""
            rule.subjectContains = (args["subject_contains"] as? String) ?? ""
            rule.triggerAutomation = MailService.boolValue(args["trigger_automation"])
            rule.isEnabled = true
            store.upsert(rule)
            return ("Saved rule \"\(name)\". LeoBot checks when the app opens and in the background (iOS decides how often, roughly every 15+ minutes); matching new mail shows a notification. Existing mail is not reported.\(rule.triggerAutomation ? " It also fires the automation signals 新邮件 and \(rule.signalName)." : "")", true)
        case "remove":
            let name = ((args["name"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard let rule = store.rules.first(where: { $0.name == name }) else {
                return ("Error: no rule named \"\(name)\".", false)
            }
            store.delete(id: rule.id)
            return ("Removed rule \"\(name)\".", true)
        case "check_now":
            return (await MailWatcher.shared.checkNow(reason: "tool"), true)
        default:
            return ("Error: action must be list / add / remove / check_now.", false)
        }
    }
}
