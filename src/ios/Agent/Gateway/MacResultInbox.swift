//
//  MacResultInbox.swift
//  MinisApp
//
//  [E5] Mac 任务的结果回到派出它的手机对话。
//
//  从对话派出的 Mac 任务带着 phone_session_id;它结束时中继的事件(回前台补齐时拉到)
//  带回同一个 id 和输出。这里按手机会话暂存这些结果,打开那个对话时作为一条提示显示,
//  不写进对话历史(不进模型上下文,也不参与同步)。纯 Foundation,编进 MinisTests。
//

import Foundation

struct MacResultEntry: Codable, Equatable {
    var phoneSessionId: String
    var machine: String
    var harnessSessionId: String
    var failed: Bool
    var output: String
    var receivedAt: Date

    /// 对话里那条提示的文字。
    var noticeText: String {
        let head = failed ? "\(machine) 上的 Mac 任务失败了" : "\(machine) 上的 Mac 任务已完成"
        let body = output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return head + "。完整过程在首页的 Mac 任务里。" }
        return head + ":\n" + String(body.prefix(MacResultInbox.outputLimit))
    }
}

enum MacResultInbox {
    static let storageKey = "leo.macResultInbox.v1"
    static let changed = Notification.Name("leo.macResultInbox.changed")
    static let outputLimit = 800
    static let capacity = 20
    static let maxAge: TimeInterval = 7 * 24 * 3600

    static func load(_ defaults: UserDefaults = .standard) -> [MacResultEntry] {
        guard let data = defaults.data(forKey: storageKey),
              let entries = try? JSONDecoder().decode([MacResultEntry].self, from: data) else { return [] }
        return entries
    }

    private static func save(_ entries: [MacResultEntry], _ defaults: UserDefaults) {
        guard let data = try? JSONEncoder().encode(entries) else { return }
        defaults.set(data, forKey: storageKey)
    }

    /// 记下一次结束。同一个 Mac 任务再结束一次(接着聊后又完成一轮)替换旧的那条。
    static func record(_ entry: MacResultEntry, defaults: UserDefaults = .standard, now: Date = Date()) {
        var entries = load(defaults).filter {
            $0.harnessSessionId != entry.harnessSessionId && now.timeIntervalSince($0.receivedAt) < maxAge
        }
        var stored = entry
        stored.output = String(entry.output.prefix(outputLimit))
        entries.append(stored)
        if entries.count > capacity { entries = Array(entries.suffix(capacity)) }
        save(entries, defaults)
    }

    /// 取走这个对话的全部结果(按到达顺序),取走即删除:只提示一次。
    static func take(phoneSessionId: String, defaults: UserDefaults = .standard) -> [MacResultEntry] {
        let entries = load(defaults)
        let mine = entries.filter { $0.phoneSessionId == phoneSessionId }
        guard !mine.isEmpty else { return [] }
        save(entries.filter { $0.phoneSessionId != phoneSessionId }, defaults)
        return mine.sorted { $0.receivedAt < $1.receivedAt }
    }

    /// 中继事件 → 结果条目。只认 run.completed / run.failed 且带 phone_session_id 的。
    static func entry(event: [String: Any], machine: String, receivedAt: Date) -> MacResultEntry? {
        let name = event["event"] as? String
        guard name == "run.completed" || name == "run.failed",
              let phone = (event["phone_session_id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !phone.isEmpty,
              let harness = event["session_id"] as? String, !harness.isEmpty else { return nil }
        let failed = name == "run.failed"
        let output = (failed ? event["error"] as? String : event["output"] as? String) ?? ""
        return MacResultEntry(phoneSessionId: String(phone.prefix(200)), machine: machine,
                              harnessSessionId: harness, failed: failed, output: output, receivedAt: receivedAt)
    }
}
