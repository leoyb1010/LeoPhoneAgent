//
//  MacAutomationTool.swift
//  MinisApp
//
//  [P3] mac_automation 工具:在常开的 Mac 上建 / 改 / 删 / 立即跑定时任务。
//  执行在 Mac(手机关着也照跑),跑完由中继推 automation.run.completed 回手机。
//  纯逻辑在 MacAutomationLogic.swift。
//

import Foundation

enum MacAutomationTool {
    static let name = "mac_automation"

    @MainActor
    static var hosts: [MacAutomationLogic.HostRef] {
        GatewayHostStore.shared.activeHosts
            .filter { $0.runsLeoPhoneAgent && !$0.isAndroidBody }
            .map { MacAutomationLogic.HostRef(id: $0.id, name: $0.name) }
    }

    @MainActor
    static func definition() -> AgentToolDefinition? {
        let names = hosts.map(\.name)
        guard !names.isEmpty else { return nil }
        let phoneZone = TimeZone.current.identifier
        return AgentToolDefinition(
            name: name,
            description: "Create and manage recurring or one-off scheduled tasks that RUN ON ONE OF THE USER'S MACS (always-on, so they fire even when this phone is locked or offline; results come back as a notification). Use this — not Apple Shortcuts — whenever the user wants something done on a schedule (每天/每周/每小时/明早 8 点…). Actions: list, create (prompt + schedule), update (id + fields; enabled=false pauses), delete (id), run (id, run once now). The prompt must be fully self-contained: it runs later on the Mac with no access to this conversation. Confirm the time and what it will do with the user before create/delete. Macs: \(names.joined(separator: ", ")).",
            parameters: [
                "tool_title": AgentToolParam(type: .string, description: "A concise 5-10 word summary shown to the user. Use the same language as the user."),
                "action": AgentToolParam(type: .string, description: "list | create | update | delete | run"),
                "mac": AgentToolParam(type: .string, description: "Which Mac runs it (name). Omit to use the user's default executor Mac."),
                "id": AgentToolParam(type: .string, description: "Automation id (from list) for update / delete / run."),
                "name": AgentToolParam(type: .string, description: "Short name shown in lists and notifications."),
                "prompt": AgentToolParam(type: .string, description: "The self-contained task the Mac agent will run each time."),
                "schedule": AgentToolParam(type: .string, description: "A 5-field cron, or a JSON object: {\"kind\":\"daily\",\"time\":\"08:00\"}, {\"kind\":\"weekly\",\"time\":\"09:00\",\"weekdays\":[1,3,5]} (0=Sunday), {\"kind\":\"hourly\",\"minute\":15}, {\"kind\":\"once\",\"date\":\"2026-10-23\",\"time\":\"08:00\"}. Write times in the phone's time zone (\(phoneZone)). once is converted to an absolute time for you; cron / hourly / daily / weekly fire in the Mac's local time zone (usually the same — the result says if it differs)."),
                "enabled": AgentToolParam(type: .boolean, description: "update only: false pauses, true resumes."),
                "workspace": AgentToolParam(type: .string, description: "Optional absolute folder on the Mac to run in (default: the folder phone tasks use)."),
                "agent": AgentToolParam(type: .string, description: "Optional agent on the Mac: zcode (default, LeoBot) or an installed CLI such as claude / codex."),
                // [up3-ios] 不传就是 Mac 默认的 build,无人值守跑不合适。
                "mode": AgentToolParam(type: .string, description: "Permission mode for create / update. Runs are unattended, so pick one: plan for read-only tasks (summaries, briefs, research, reading files), guarded for tasks that run commands or change files. build only when the user explicitly wants full edit access.", enumValues: MacAutomationLogic.modes),
            ],
            required: ["tool_title", "action"],
            propertyOrdering: ["tool_title", "action", "mac", "id", "name", "prompt", "schedule", "enabled", "workspace", "agent", "mode"]
        )
    }

    /// 返回给模型的文本(JSON 或一句错误),以及是否成功。
    @MainActor
    static func execute(argsJson: String) async -> (output: String, success: Bool) {
        let args = (try? JSONSerialization.jsonObject(with: Data(argsJson.utf8)) as? [String: Any]) ?? [:]
        guard let action = MacAutomationLogic.Action(rawValue: (args["action"] as? String ?? "").lowercased()) else {
            return ("Error: action 必须是 list / create / update / delete / run 之一", false)
        }
        let remembered = UserDefaults.standard.string(forKey: MacAutomationLogic.executorDefaultsKey)
        guard let ref = MacAutomationLogic.pickHost(hosts, requested: args["mac"] as? String, rememberedId: remembered),
              let host = GatewayHostStore.shared.activeHosts.first(where: { $0.id == ref.id }),
              let client = GatewayHostStore.shared.client(for: host) else {
            return ("Error: 找不到可用的 Mac(在 设置 → 远程机器 里添加,或换个名字)", false)
        }
        let phoneZone = TimeZone.current
        do {
            let request = try MacAutomationLogic.request(action: action, args: args, timeZone: phoneZone)
            let raw = try await client.automationCall(request)
            if action == .create {
                // 用户在哪台上建过,下次默认还用那台。
                UserDefaults.standard.set(ref.id, forKey: MacAutomationLogic.executorDefaultsKey)
            }
            // 手机时区写进结果;Mac 报了时区(结果里或 capabilities 里)且不同,就明说。
            let macZone = MacAutomationLogic.macTimeZone(from: try? JSONSerialization.jsonObject(with: Data(raw.utf8)))
                ?? GatewayHostStore.shared.macTimeZones[ref.id]
            var output = "{\"mac\":\(jsonString(ref.name)),\"phone_time_zone\":\(jsonString(phoneZone.identifier))"
            if let warning = MacAutomationLogic.timeZoneWarning(phone: phoneZone.identifier, mac: macZone) {
                output += ",\"time_zone_warning\":\(jsonString(warning))"
            }
            return (output + ",\"result\":\(raw)}", true)
        } catch let error as MacAutomationLogic.ArgumentError {
            return ("Error: \(error.localizedDescription)", false)
        } catch {
            if LeoAgentClient.isNotFound(error) {
                // 带 id 的 404:列表通 = 路由在、id 不在这台;列表也 404 = Mac 太旧。
                var listReachable: Bool?
                if action != .list && action != .create {
                    do {
                        _ = try await client.automationCall(try MacAutomationLogic.request(action: .list, args: [:]))
                        listReachable = true
                    } catch {
                        listReachable = LeoAgentClient.isNotFound(error) ? false : nil
                    }
                }
                let kind = MacAutomationLogic.classifyNotFound(action: action, listReachable: listReachable)
                return (MacAutomationLogic.notFoundMessage(kind, mac: ref.name), false)
            }
            return ("Error: \(ref.name): \(error.localizedDescription)", false)
        }
    }

    private static func jsonString(_ text: String) -> String {
        (try? JSONSerialization.data(withJSONObject: [text], options: []))
            .flatMap { String(data: $0, encoding: .utf8) }
            .map { String($0.dropFirst().dropLast()) } ?? "\"\""
    }
}
