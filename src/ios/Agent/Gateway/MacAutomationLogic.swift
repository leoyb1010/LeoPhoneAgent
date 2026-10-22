//
//  MacAutomationLogic.swift
//  MinisApp
//
//  [P3] 定时任务交给常开的 Mac 执行(手机后台不可靠)。这里只放纯逻辑,编进 MinisTests:
//  选哪台 Mac、把模型给的参数整理成 Leo Link /automations 的请求、跑完事件的提示文案。
//  请求的契约见 src/mac/leophone/docs/specs/leo-link-automations.md。
//

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

    /// 只认已知的几个字段:未知字段不往 Mac 转,模型乱填的东西不会变成请求。
    static func request(action: Action, args: [String: Any]) throws -> Request {
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
            var body: [String: Any] = ["prompt": prompt, "schedule": try schedule(args["schedule"])]
            if let name = args["name"] as? String, !name.isEmpty { body["name"] = name }
            if let dir = args["workspace"] as? String, !dir.isEmpty { body["workspace"] = dir }
            if let agent = args["agent"] as? String, !agent.isEmpty { body["harness"] = agent }
            return Request(method: "POST", path: "/automations", body: body)
        case .update:
            var body: [String: Any] = [:]
            if let name = args["name"] as? String, !name.isEmpty { body["name"] = name }
            if let prompt = args["prompt"] as? String, !prompt.isEmpty { body["prompt"] = prompt }
            if args["schedule"] != nil { body["schedule"] = try schedule(args["schedule"]) }
            if let enabled = args["enabled"] as? Bool { body["enabled"] = enabled }
            guard !body.isEmpty else { throw ArgumentError.invalid("update 至少要改 name / prompt / schedule / enabled 之一") }
            return Request(method: "PATCH", path: "/automations/" + (try needId()), body: body)
        case .delete:
            return Request(method: "DELETE", path: "/automations/" + (try needId()), body: nil)
        case .run:
            return Request(method: "POST", path: "/automations/" + (try needId()) + "/run", body: [:])
        }
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
