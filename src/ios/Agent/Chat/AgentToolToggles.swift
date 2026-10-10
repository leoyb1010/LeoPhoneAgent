//
//  AgentToolToggles.swift
//  MinisApp
//
//  [F2-tool-toggles] Settings › 工具开关: the browser, sub agents and the
//  agent's self-scheduled follow-ups can each be switched off on their own.
//  A switched-off tool is not offered to the model at all (and its handler
//  refuses, as defence in depth). Sub agents keep their existing key so the
//  switch on the Sub Agents page and this page are the same setting.
//
//  Pure logic (no UIKit) so the logic-test target compiles it.
//

import Foundation

enum AgentToolToggles {
    static let browserUseKey = "tools.browserUse.enabled"
    static let selfSchedulingKey = "tools.selfScheduling.enabled"
    static let browserToolName = "browser_use"

    static var browserUseEnabled: Bool {
        get { UserDefaults.standard.object(forKey: browserUseKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: browserUseKey) }
    }

    static var selfSchedulingEnabled: Bool {
        get { UserDefaults.standard.object(forKey: selfSchedulingKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: selfSchedulingKey) }
    }

    /// Whether this conversation may be offered `schedule_followup`: only a
    /// top-level, attended, on-device conversation with the switch on.
    static func offersSelfScheduling(enabled: Bool, isSubAgentChild: Bool,
                                     blocksSideEffectTools: Bool, isRemote: Bool) -> Bool {
        enabled && !isSubAgentChild && !blocksSideEffectTools && !isRemote
    }

    /// Applies the switches to a tool list.
    static func apply<T>(_ tools: [T], name: (T) -> String, browserUse: Bool,
                         selfScheduling: T?) -> [T] {
        var result = browserUse ? tools : tools.filter { name($0) != browserToolName }
        if let selfScheduling, !result.contains(where: { name($0) == name(selfScheduling) }) {
            result.append(selfScheduling)
        }
        return result
    }

    /// System-prompt note while the browser is off, so the model does not reach
    /// for the shell wrapper the base prompt still describes. nil = nothing to say
    /// (the prompt stays byte-identical to before this switch existed).
    static func promptFragment(browserUse: Bool) -> String? {
        guard !browserUse else { return nil }
        return "## Tool switches\nThe user has turned the browser OFF in Settings › Tool Switches: browser_use and the minis-browser-use CLI are unavailable. Do not try them; use other tools, or tell the user the browser is switched off."
    }

    static let disabledBrowserMessage = "Error: the browser is turned off in Settings › Tool Switches. Ask the user to turn it back on if browsing is needed."
}

extension ScheduledFollowUp {
    /// The `schedule_followup` tool schema.
    static var toolDefinition: AgentToolDefinition {
        AgentToolDefinition(
            name: toolName,
            description: "Schedule a follow-up for YOURSELF in this same conversation. when=\"once\": run `prompt` at a time (`at` = ISO-8601 local time like 2026-10-10T15:30, or `delay_minutes`), 1 minute to 30 days ahead. when=\"after_completion\": run `prompt` right after the current turn finishes normally. Use it when the user asks you to check back, remind, or continue later. Timing is best-effort: iOS cannot wake the app on a clock, so a due follow-up runs the next time LeoBot is awake, and a reminder notification fires at the due time. Daily limit \(dailyLimit) follow-ups, at most \(perSessionPendingLimit) pending per conversation. The prompt is delivered later as a labelled message in this conversation — write it as a complete instruction to your future self (what to check, what to report).",
            parameters: [
                "tool_title": AgentToolParam(type: .string, description: "A concise 5-10 word summary shown to the user. Use the same language as the user."),
                "when": AgentToolParam(type: .string, description: "\"once\" (at a time) or \"after_completion\" (right after this turn).", enumValues: Trigger.allCases.map(\.rawValue)),
                "title": AgentToolParam(type: .string, description: "Short label the user sees in Settings and the reminder, max \(titleMaxLength) chars. Use the same language as the user."),
                "prompt": AgentToolParam(type: .string, description: "The full instruction to run later, max \(promptMaxLength) chars."),
                "at": AgentToolParam(type: .string, description: "For once: ISO-8601 time. Without an offset it is the device's local time."),
                "delay_minutes": AgentToolParam(type: .integer, description: "For once, instead of `at`: minutes from now (1-43200)."),
            ],
            required: ["tool_title", "when", "title", "prompt"],
            propertyOrdering: ["tool_title", "when", "title", "prompt", "at", "delay_minutes"]
        )
    }
}
