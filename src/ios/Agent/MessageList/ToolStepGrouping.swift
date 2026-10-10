//
//  ToolStepGrouping.swift
//  MinisApp
//
//  [T-tool-step-collapse] Consecutive finished tool calls of one reply read as
//  one quiet row — "已运行 N 个工具 · 9 秒" — that opens to the capsules.
//  Pure rules (no UIKit), compiled into the logic tests; the message list maps
//  its blocks to `ToolStep`s and renders the entries.
//
//  What folds: a run of at least two successfully finished tool calls, plus
//  thinking / empty text strictly between them. What never folds: a running
//  step, a failed or cancelled step, written text, images and cards (they are
//  barriers that split runs).
//

import Foundation

struct ToolStep: Equatable {
    enum Role: Equatable {
        /// A tool call that finished successfully — foldable.
        case completedTool
        /// Still running (or streaming its arguments): always in view.
        case liveTool
        case failedTool
        case cancelledTool
        /// Thinking, or an empty text block: folds only between two tools.
        case transparent
        /// Text with content, images, cards: splits a run, never folds.
        case barrier
    }

    let id: UUID
    let role: Role
    var toolUseId: String? = nil
    /// What this step did, in the user's words (the call's title), if known.
    var summary: String? = nil
    var startTime: Date? = nil
    var duration: TimeInterval? = nil
}

struct ToolStepGroup: Equatable {
    /// The run's first tool — the summary row's list identity. It doesn't move
    /// when later tools join the run.
    let firstId: UUID
    /// Every block the row stands for, in order (tools + absorbed thinking).
    let memberIds: [UUID]
    let toolCount: Int
    /// Remembers an opened row across reloads (the first call's saved id).
    let expansionKey: String
    /// The most informative last step: the last tool that has a summary.
    let lastSummary: String?
    let elapsed: TimeInterval
}

enum ToolStepEntry: Equatable {
    case group(ToolStepGroup)
    case step(UUID)
}

enum ToolStepGrouping {
    static let minimumTools = 2

    static func groups(_ steps: [ToolStep]) -> [ToolStepGroup] {
        var result: [ToolStepGroup] = []
        var i = 0
        while i < steps.count {
            guard steps[i].role == .completedTool else { i += 1; continue }
            var lastTool = i
            var k = i + 1
            scan: while k < steps.count {
                switch steps[k].role {
                case .completedTool: lastTool = k
                case .transparent: break
                default: break scan
                }
                k += 1
            }
            let members = Array(steps[i...lastTool])
            let tools = members.filter { $0.role == .completedTool }
            if tools.count >= minimumTools {
                let first = steps[i]
                let summary = tools.reversed().lazy.compactMap { step -> String? in
                    let trimmed = step.summary?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    return trimmed.isEmpty ? nil : trimmed
                }.first
                result.append(ToolStepGroup(
                    firstId: first.id,
                    memberIds: members.map(\.id),
                    toolCount: tools.count,
                    expansionKey: first.toolUseId ?? first.id.uuidString,
                    lastSummary: summary,
                    elapsed: elapsed(tools)))
            }
            i = lastTool + 1
        }
        return result
    }

    /// The reply's rows in order: a collapsed group is one entry; an opened
    /// group is its row followed by its members.
    static func layout(_ steps: [ToolStep], expanded: Set<String>) -> [ToolStepEntry] {
        let groupsByFirst = Dictionary(groups(steps).map { ($0.firstId, $0) }, uniquingKeysWith: { a, _ in a })
        var entries: [ToolStepEntry] = []
        var i = 0
        while i < steps.count {
            if let group = groupsByFirst[steps[i].id] {
                entries.append(.group(group))
                if expanded.contains(group.expansionKey) {
                    entries.append(contentsOf: group.memberIds.map { .step($0) })
                }
                i += group.memberIds.count
            } else {
                entries.append(.step(steps[i].id))
                i += 1
            }
        }
        return entries
    }

    /// Wall-clock span when every call has a start and a duration (calls from
    /// one response run in parallel and overlap); after a reload start times
    /// are gone, so the durations are added up.
    static func elapsed(_ tools: [ToolStep]) -> TimeInterval {
        let spans = tools.compactMap { t in
            t.startTime.flatMap { start in t.duration.map { (start, start.addingTimeInterval($0)) } }
        }
        if !spans.isEmpty, spans.count == tools.count,
           let first = spans.map(\.0).min(), let last = spans.map(\.1).max() {
            return max(0, last.timeIntervalSince(first))
        }
        return tools.compactMap(\.duration).reduce(0, +)
    }
}
