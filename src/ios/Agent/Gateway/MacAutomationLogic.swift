//
//  MacAutomationLogic.swift
//  MinisApp
//
//  [P3] 定时任务交给常开的 Mac 执行(手机后台不可靠)。这里只放纯逻辑,编进 MinisTests:
//  选哪台 Mac、把模型给的参数整理成 Leo Link /automations 的请求、跑完事件的提示文案。
//  请求的契约见 src/mac/leophone/docs/specs/leo-link-automations.md。
//

import CryptoKit
import Foundation

enum MacAutomationLogic {
    /// 设置里记住的执行者(主机 id);没设就按名字找 Studio,再退到第一台。
    static let executorDefaultsKey = "macAutomation.executorHostId"

    struct HostRef: Equatable {
        let id: String
        let name: String
    }

    /// 选执行的 Mac:模型点名的(名字包含即可,不分大小写)> 设置里记住的 > 名字带 Studio 的 > 第一台。
    static func pickHost(_ hosts: [HostRef], requested: String?, rememberedId: String?) -> HostRef? {
        let asked = requested?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        if !asked.isEmpty {
            return hosts.first { $0.name.lowercased() == asked }
                ?? hosts.first { $0.name.lowercased().contains(asked) || asked.contains($0.name.lowercased()) }
        }
        if let rememberedId, let host = hosts.first(where: { $0.id == rememberedId }) { return host }
        return hosts.first { $0.name.lowercased().contains("studio") } ?? hosts.first
    }

    enum Action: String, CaseIterable {
        case list, create, update, delete, run
    }

    /// [up3-ios] 手机能指定的权限模式(Mac 的 yolo 只认 Mac 本机,手机不给)。不传 = Mac 默认 build,
    /// 无人值守跑不合适:只读的任务用 plan,要跑命令的用 guarded。
    static let modes: [String] = ["plan", "guarded", "build"]

    static func mode(_ raw: Any?) throws -> String? {
        guard let text = (raw as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !text.isEmpty else { return nil }
        guard modes.contains(text) else { throw ArgumentError.invalid("mode 只能是 \(modes.joined(separator: " / "))") }
        return text
    }

    struct Request: Equatable {
        let method: String
        let path: String
        /// JSON 正文(键排序,便于比较);GET / DELETE 为 nil。
        let body: String?

        init(method: String, path: String, body: [String: Any]?) {
            self.method = method
            self.path = path
            self.body = body.flatMap { try? JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys]) }
                .flatMap { String(data: $0, encoding: .utf8) }
        }
    }

    enum ArgumentError: Error, Equatable, LocalizedError {
        case missing(String)
        case invalid(String)

        var errorDescription: String? {
            switch self {
            case .missing(let name): return "缺少参数 \(name)"
            case .invalid(let detail): return detail
            }
        }
    }

    /// 模型给的 schedule:cron 字符串、JSON 字符串或对象都收,原样转给 Mac(Mac 负责校验与换算)。
    static func schedule(_ raw: Any?) throws -> Any {
        if let dict = raw as? [String: Any] { return try jsonObject(dict) }
        guard let text = (raw as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
            throw ArgumentError.missing("schedule")
        }
        if text.hasPrefix("{"), let data = text.data(using: .utf8),
           let dict = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            return try jsonObject(dict)
        }
        guard text.split(separator: " ").count == 5 else {
            throw ArgumentError.invalid("schedule 要么是 5 段 cron,要么是 {\"kind\":\"daily\",\"time\":\"09:00\"} 这类对象")
        }
        return text
    }

    /// once 交给 Mac 前换成带手机时区偏移的绝对时间 `at`:模型按手机时区(Sent at 里带)想时间,
    /// Mac 按自己的时区解释 date/time,两边时区不同就会差几个小时。其它计划原样返回。
    static func anchorOnce(_ schedule: Any, timeZone: TimeZone) throws -> Any {
        guard let dict = schedule as? [String: Any], (dict["kind"] as? String)?.lowercased() == "once" else { return schedule }
        let local = DateFormatter()
        local.locale = Locale(identifier: "en_US_POSIX")
        local.timeZone = timeZone
        var date: Date?
        if let at = (dict["at"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !at.isEmpty {
            if hasExplicitOffset(at) { return ["kind": "once", "at": at] }
            for format in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm"] where date == nil {
                local.dateFormat = format
                date = local.date(from: at)
            }
        } else if let day = (dict["date"] as? String)?.trimmingCharacters(in: .whitespaces),
                  let time = (dict["time"] as? String)?.trimmingCharacters(in: .whitespaces) {
            local.dateFormat = "yyyy-MM-dd HH:mm"
            date = local.date(from: "\(day) \(time)")
        }
        guard let date else {
            throw ArgumentError.invalid("once 要写 {\"kind\":\"once\",\"date\":\"2026-10-23\",\"time\":\"08:00\"} 或带时区的 at")
        }
        let iso = ISO8601DateFormatter()
        iso.timeZone = timeZone
        iso.formatOptions = [.withInternetDateTime]
        return ["kind": "once", "at": iso.string(from: date)]
    }

    /// `…Z` / `…+08:00` / `…-0500`:已经是绝对时间。
    private static func hasExplicitOffset(_ at: String) -> Bool {
        guard let t = at.firstIndex(of: "T") else { return false }
        let tail = at[t...]
        if tail.hasSuffix("Z") || tail.hasSuffix("z") { return true }
        return tail.range(of: #"[+-]\d{2}:?\d{2}$"#, options: .regularExpression) != nil
    }

    /// Mac 报的时区(IANA id)。现在的 Mac 还不报;将来出现在 capabilities / 列表 / 单个任务里都认。
    static func macTimeZone(from json: Any?) -> String? {
        guard let obj = json as? [String: Any] else { return nil }
        for key in ["time_zone", "timezone", "tz"] {
            if let tz = obj[key] as? String, !tz.isEmpty { return tz }
        }
        for key in ["device", "automation", "schedule"] {
            if let tz = macTimeZone(from: obj[key]) { return tz }
        }
        return macTimeZone(from: (obj["automations"] as? [Any])?.first)
    }

    /// 两边时区不同时的提醒;相同或不知道 Mac 时区时为 nil。
    static func timeZoneWarning(phone: String, mac: String?) -> String? {
        guard let mac, !mac.isEmpty, mac != phone else { return nil }
        if let m = TimeZone(identifier: mac), let p = TimeZone(identifier: phone),
           m.secondsFromGMT() == p.secondsFromGMT() { return nil }
        return "Mac 的时区是 \(mac),手机是 \(phone):cron / hourly / daily / weekly 按 Mac 时区触发,告诉用户前先换算;once 已按手机时区换成绝对时间。"
    }

    enum NotFound: Equatable {
        /// 整条 /automations 路由都没有:Mac 上的 LeoBot 太旧。
        case routeMissing
        /// 路由在,这个 id 不在这台 Mac 上。
        case idMissing
    }

    /// 404 是哪一种。不带 id 的动作(list / create)只可能是路由缺失;带 id 的看 `GET /automations` 通不通。
    static func classifyNotFound(action: Action, listReachable: Bool?) -> NotFound {
        switch action {
        case .list, .create: return .routeMissing
        case .update, .delete, .run: return listReachable == false ? .routeMissing : .idMissing
        }
    }

    static func notFoundMessage(_ kind: NotFound, mac: String) -> String {
        switch kind {
        case .routeMissing:
            return "Error: \(mac) 上的 LeoBot 不支持定时任务接口(需要 Mac 1.14.0 或更新)"
        case .idMissing:
            return "Error: \(mac):这台 Mac 上没有这个任务（id 可能在另一台）；先用 list 查(可带 mac 指定哪台)"
        }
    }

    /// 只认已知的几个字段:未知字段不往 Mac 转,模型乱填的东西不会变成请求。
    static func request(action: Action, args: [String: Any], timeZone: TimeZone = .current) throws -> Request {
        let id = (args["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        func needId() throws -> String {
            guard !id.isEmpty, !id.contains("/"), !id.contains("..") else { throw ArgumentError.missing("id") }
            return id
        }
        switch action {
        case .list:
            return Request(method: "GET", path: "/automations", body: nil)
        case .create:
            guard let prompt = (args["prompt"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !prompt.isEmpty else { throw ArgumentError.missing("prompt") }
            var body: [String: Any] = ["prompt": prompt,
                                       "schedule": try anchorOnce(try schedule(args["schedule"]), timeZone: timeZone)]
            if let name = args["name"] as? String, !name.isEmpty { body["name"] = name }
            if let dir = args["workspace"] as? String, !dir.isEmpty { body["workspace"] = dir }
            if let agent = args["agent"] as? String, !agent.isEmpty { body["harness"] = agent }
            if let picked = try mode(args["mode"]) { body["mode"] = picked }
            return Request(method: "POST", path: "/automations", body: body)
        case .update:
            var body: [String: Any] = [:]
            if let name = args["name"] as? String, !name.isEmpty { body["name"] = name }
            if let prompt = args["prompt"] as? String, !prompt.isEmpty { body["prompt"] = prompt }
            if args["schedule"] != nil { body["schedule"] = try anchorOnce(try schedule(args["schedule"]), timeZone: timeZone) }
            if let enabled = args["enabled"] as? Bool { body["enabled"] = enabled }
            if let picked = try mode(args["mode"]) { body["mode"] = picked }
            guard !body.isEmpty else { throw ArgumentError.invalid("update 至少要改 name / prompt / schedule / enabled / mode 之一") }
            return Request(method: "PATCH", path: "/automations/" + (try needId()), body: body)
        case .delete:
            return Request(method: "DELETE", path: "/automations/" + (try needId()), body: nil)
        case .run:
            return Request(method: "POST", path: "/automations/" + (try needId()) + "/run", body: [:])
        }
    }

    /// Mac 的结果摘要上限(Mac 端同一个数)。
    static let summaryLimit = 280

    /// 通知标识:按 run_id 固定(中继 APNs 的 collapse id 用同一个),补拉和推送是同一条、不叠两条。
    /// 没 run_id 的旧事件退到 automation_id + 时间戳。
    /// [up3-ios] APNs collapse id 上限 64 字节,run_id 本身就可能更长:两边都取
    /// "relay-automation-" + SHA-256(key) 的前 40 位小写十六进制(共 57 字符)。key 与中继逐字一致:
    /// run_id 非空就是 run_id,否则是 Python 的 str(automation_id or '') + '-' + str(timestamp or '')。
    static func runNotificationId(event: [String: Any]) -> String {
        let run = pythonStr(event["run_id"])
        let key = run.isEmpty ? pythonStr(event["automation_id"]) + "-" + pythonStr(event["timestamp"]) : run
        let digest = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
        return "relay-automation-" + digest.prefix(40)
    }

    /// 中继的 `str(x or '')`:空 / 0 / 缺省都是 "";整数不带小数点,浮点数按 Python repr(最短往返表示,
    /// 整值也带 ".0")。JSON 解出来的 NSNumber 靠 objCType 分整数和浮点。
    static func pythonStr(_ raw: Any?) -> String {
        switch raw {
        case let text as String:
            return text
        case let number as NSNumber:
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue ? "True" : "" }
            if CFNumberIsFloatType(number) {
                let value = number.doubleValue
                return value == 0 ? "" : "\(value)"
            }
            return number.int64Value == 0 ? "" : String(number.int64Value)
        default:
            return ""
        }
    }

    /// 这次运行在 Mac 上的会话(点通知打开它)。
    static func runSessionId(_ event: [String: Any]) -> String? {
        for key in ["session_id", "task_id"] {
            if let id = event[key] as? String, !id.isEmpty { return id }
        }
        return nil
    }

    /// 带隐私开关的版本:开着时正文不带结果,只说跑完了。
    static func runNotice(machine: String, event: [String: Any], privacy: Bool) -> (title: String, body: String) {
        let notice = runNotice(machine: machine, event: event)
        if privacy { return (notice.title, AppLocalized("打开 App 查看结果")) }
        return (notice.title, String(notice.body.prefix(summaryLimit)))
    }

    /// Mac 推来的 automation.run.completed → 通知标题与正文。
    static func runNotice(machine: String, event: [String: Any]) -> (title: String, body: String) {
        let name = (event["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "定时任务"
        let status = event["status"] as? String ?? ""
        let verb: String
        switch status {
        case "succeeded": verb = "完成"
        case "stopped": verb = "已停止"
        default: verb = "失败"
        }
        let mark = status == "succeeded" ? "✅" : "⏰"
        return ("\(mark) \(machine) 定时任务「\(name)」\(verb)", event["summary"] as? String ?? "")
    }

    private static func jsonObject(_ dict: [String: Any]) throws -> [String: Any] {
        guard JSONSerialization.isValidJSONObject(dict) else { throw ArgumentError.invalid("schedule 不是合法的 JSON 对象") }
        return dict
    }
}

// MARK: - 远程机器页的「定时任务」列表(C3)

extension MacAutomationLogic {
    /// `GET /automations` 里的一条,只取列表要显示的。
    struct Summary: Identifiable, Equatable {
        let id: String
        let name: String
        /// Mac 给的人话计划(「每天 09:00」);没有就退到 cron 原式。
        let scheduleText: String
        let enabled: Bool
        /// active | paused | completed | failed
        let state: String
        let lastRunStatus: String?
        let lastRunAt: Date?
        let nextRunAt: Date?
        /// [up3-ios] 上次运行的结果摘要(失败 / 没派发出去的原因)和那次运行的 Mac 会话。
        var lastRunSummary: String? = nil
        var lastRunSessionId: String? = nil

        /// 一次性任务跑完了:开关没意义。
        var isFinished: Bool { state == "completed" }

        /// 不是成功的那几种状态下,把原因显示成第二行。
        var lastRunProblem: String? {
            guard let status = lastRunStatus, !["succeeded", "running", "pending"].contains(status) else { return nil }
            return lastRunSummary
        }
    }

    static func summaries(fromList json: Any?) -> [Summary] {
        guard let rows = (json as? [String: Any])?["automations"] as? [[String: Any]] else { return [] }
        return rows.compactMap(summary)
    }

    static func summary(_ row: [String: Any]) -> Summary? {
        guard let id = row["id"] as? String, !id.isEmpty else { return nil }
        let schedule = row["schedule"] as? [String: Any]
        let scheduleText = (schedule?["human"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            ?? (schedule?["cron"] as? String) ?? (row["schedule"] as? String) ?? ""
        let lastRun = row["last_run"] as? [String: Any]
        let name = (row["name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            ?? String((row["prompt"] as? String ?? id).prefix(30))
        return Summary(id: id, name: name, scheduleText: scheduleText,
                       enabled: row["enabled"] as? Bool ?? true,
                       state: row["state"] as? String ?? "active",
                       lastRunStatus: lastRun?["status"] as? String,
                       lastRunAt: seconds(lastRun?["at"]),
                       nextRunAt: seconds(row["next_run_at"]),
                       lastRunSummary: (lastRun?["summary"] as? String)
                           .map { String($0.trimmingCharacters(in: .whitespacesAndNewlines).prefix(summaryLimit)) }
                           .flatMap { $0.isEmpty ? nil : $0 },
                       lastRunSessionId: (lastRun?["session_id"] as? String).flatMap { $0.isEmpty ? nil : $0 })
    }

    /// `GET /automations/templates`(Mac 新加的接口)里的一条。字段名宽松:Mac 端还在定。
    struct Template: Identifiable, Equatable {
        let id: String
        let name: String
        let detail: String?
        let scheduleText: String?
        /// 建任务的请求:模板带了 prompt + schedule 就按已知字段建,否则只带模板 id。
        let create: Request
    }

    static func templates(from json: Any?) -> [Template] {
        let rows = ((json as? [String: Any])?["templates"] as? [[String: Any]]) ?? (json as? [[String: Any]]) ?? []
        return rows.compactMap { row in
            guard let id = (row["id"] as? String) ?? (row["key"] as? String), !id.isEmpty else { return nil }
            let name = (row["name"] as? String) ?? (row["title"] as? String) ?? id
            let schedule = row["schedule"]
            let human = ((schedule as? [String: Any])?["human"] as? String)
                ?? (row["schedule_human"] as? String) ?? (schedule as? String)
            let body: [String: Any]
            if let prompt = row["prompt"] as? String, !prompt.isEmpty, let schedule {
                // 计划对象里 human / recurring 是 Mac 回给人看的,建的时候不往回送。
                var sched: Any = schedule
                if var dict = schedule as? [String: Any] {
                    for key in ["human", "recurring"] { dict.removeValue(forKey: key) }
                    sched = dict
                }
                var fields: [String: Any] = ["name": name, "prompt": prompt, "schedule": sched]
                // [up3-ios] 模板带的权限模式(只读的早报是 plan)跟着建;不带就是 Mac 默认 build。
                if let picked = try? mode(row["mode"]) { fields["mode"] = picked }
                body = fields
            } else {
                body = ["template_id": id]
            }
            let create = Request(method: "POST", path: "/automations", body: body)
            guard create.body != nil else { return nil }
            return Template(id: id, name: name,
                            detail: (row["description"] as? String) ?? (row["summary"] as? String),
                            scheduleText: human, create: create)
        }
    }

    static let templatesRequest = Request(method: "GET", path: "/automations/templates", body: nil)

    private static func seconds(_ raw: Any?) -> Date? {
        if let value = raw as? Double, value > 0 { return Date(timeIntervalSince1970: value) }
        if let value = raw as? Int, value > 0 { return Date(timeIntervalSince1970: TimeInterval(value)) }
        return nil
    }
}
