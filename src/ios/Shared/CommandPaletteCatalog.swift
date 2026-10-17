//
//  CommandPaletteCatalog.swift
//  MinisApp
//
//  [WP-43] The ⌘K palette's fixed commands (besides sessions and quick tasks):
//  which ones are offered right now, in what order, with which shortcut hint.
//  Pure so the logic tests can pin it; CommandPaletteView renders it and
//  ContentView runs the picked command.
//

import Foundation

enum PaletteCommand: String, CaseIterable, Identifiable {
    case newTask, search, settings
    case switchModel, stopRun, approve, deny
    case contextDetails, macScreen
    case automations, macConsole, timeline, scheduledTasks

    var id: String { rawValue }

    var title: String {
        switch self {
        case .newTask: "新任务"
        case .search: "搜索会话"
        case .settings: "设置"
        case .switchModel: "切换模型 / Agent"
        case .stopRun: "停止当前任务"
        case .approve: "审批：允许这一次"
        case .deny: "审批：拒绝"
        case .contextDetails: "文件/工具详情"
        case .macScreen: "Mac 画面"
        case .automations: "Automations"
        case .macConsole: "Mac 控制台"
        case .timeline: "Agent Timeline"
        case .scheduledTasks: "Scheduled Tasks"
        }
    }

    var symbol: String {
        switch self {
        case .newTask: "square.and.pencil"
        case .search: "magnifyingglass"
        case .settings: "gear"
        case .switchModel: "cpu"
        case .stopRun: "stop.circle"
        case .approve: "checkmark.shield"
        case .deny: "xmark.shield"
        case .contextDetails: "sidebar.right"
        case .macScreen: "display"
        case .automations: "bolt.badge.clock"
        case .macConsole: "desktopcomputer"
        case .timeline: "list.bullet.rectangle.portrait"
        case .scheduledTasks: "clock.badge.checkmark"
        }
    }

    /// Shown on the row's trailing side; same keys as LeoCommands.
    var shortcut: String? {
        switch self {
        case .newTask: "⌘N"
        case .search: "⌘F"
        case .settings: "⌘,"
        case .stopRun: "⌘."
        case .contextDetails: "⌥⌘I"
        case .macScreen: "⇧⌘M"
        default: nil
        }
    }
}

enum CommandPaletteCatalog {
    struct Context: Equatable {
        /// A chat (or a new-chat draft) is on screen in this window.
        var hasChat = false
        var isProcessing = false
        /// The on-device agent is waiting on an approval (SensitiveToolGate).
        var hasApproval = false
        var macFleetEnabled = false
        /// The iPad split layout, where the chat has a third column.
        var splitLayout = false
    }

    /// Urgent first (answer the approval, stop the run), then the chat's own
    /// commands, then app-wide ones and pages.
    static func commands(_ c: Context) -> [PaletteCommand] {
        var out: [PaletteCommand] = []
        if c.hasApproval { out += [.approve, .deny] }
        if c.hasChat && c.isProcessing { out.append(.stopRun) }
        if c.hasChat { out.append(.switchModel) }
        if c.hasChat && c.splitLayout {
            out.append(.contextDetails)
            if c.macFleetEnabled { out.append(.macScreen) }
        }
        out += [.newTask, .search, .settings, .automations]
        if c.macFleetEnabled { out.append(.macConsole) }
        out += [.timeline, .scheduledTasks]
        return out
    }
}
