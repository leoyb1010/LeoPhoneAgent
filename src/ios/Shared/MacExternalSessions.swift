//
//  MacExternalSessions.swift
//  MinisApp
//
//  [takeover] Mac 终端里已开着的 Claude Code 会话:列表与接管回执的线格式
//  (契约 src/mac/leophone/docs/specs/leo-link-takeover.md)。只依赖 Foundation,逻辑测试包直接编进来。
//

import Foundation

struct MacExternalSession: Identifiable, Hashable, Sendable {
    /// Claude Code 的会话 id(uuid,即 ~/.claude/projects 里的 JSONL 文件名)。
    let id: String
    let agent: String
    let cwd: String
    let title: String
    let updatedAt: Date?
    /// 最近 60 秒内文件有写入:终端里那个 claude 多半还开着。
    let running: Bool
    /// 已被接管过:对应的 LeoBot 任务 id(再点一下回到那个任务)。
    let leobotSessionId: String?

    /// 目录最后一段;主目录本身显示「~」。
    var folderName: String {
        let trimmed = cwd.hasSuffix("/") && cwd.count > 1 ? String(cwd.dropLast()) : cwd
        let last = (trimmed as NSString).lastPathComponent
        if last.isEmpty { return "~" }
        // /Users/<name> 就是主目录
        let parts = trimmed.split(separator: "/")
        if parts.count == 2, parts[0] == "Users" { return "~" }
        return last
    }

    var displayTitle: String { title.isEmpty ? folderName : title }
}

/// 接管回执:够会话页直接接上(harness / 名字 / 目录 / 状态 / 已有的 seq)。
struct MacTakeoverResult: Equatable, Sendable {
    let sessionId: String
    let harness: String
    let name: String
    let cwd: String
    let title: String
    let status: String
    let seq: Int
    let mode: String?
    /// Mac 终端里这个会话还开着(两边同时发消息会打架;只提示,不拦)。
    let terminalRunning: Bool
    /// 之前已接管过,回的是那个任务。
    let reused: Bool
}

enum MacExternalSessionsWire {
    static let listPath = "/harness/external-sessions"
    static let createPath = "/harness/sessions"

    static func parseList(_ obj: [String: Any]) -> [MacExternalSession] {
        (obj["sessions"] as? [[String: Any]] ?? []).compactMap { row in
            guard let id = row["id"] as? String, !id.isEmpty else { return nil }
            return MacExternalSession(
                id: id,
                agent: (row["agent"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "claude",
                cwd: row["cwd"] as? String ?? "",
                title: (row["title"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
                updatedAt: date(row["updated_at"]),
                running: row["running"] as? Bool ?? false,
                leobotSessionId: (row["leobot_session_id"] as? String).flatMap { $0.isEmpty ? nil : $0 })
        }
    }

    static func takeoverBody(_ session: MacExternalSession) -> [String: Any] {
        ["resume_external": ["agent": session.agent, "session_id": session.id]]
    }

    /// 回执缺字段时用列表里的那一行补(旧字段名 / 字段不全也能开会话页)。
    static func parseTakeover(_ obj: [String: Any], fallback: MacExternalSession) -> MacTakeoverResult? {
        guard let id = obj["session_id"] as? String, !id.isEmpty else { return nil }
        func text(_ key: String) -> String? { (obj[key] as? String).flatMap { $0.isEmpty ? nil : $0 } }
        return MacTakeoverResult(
            sessionId: id,
            harness: text("harness") ?? fallback.agent,
            name: text("name") ?? "Claude Code",
            cwd: text("cwd") ?? fallback.cwd,
            title: text("title") ?? fallback.displayTitle,
            status: text("status") ?? "idle",
            seq: obj["seq"] as? Int ?? 0,
            mode: text("mode"),
            terminalRunning: text("warning") == "terminal_running",
            reused: obj["reused"] as? Bool ?? false)
    }

    static func date(_ raw: Any?) -> Date? {
        guard let raw = raw as? String else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
    }
}
