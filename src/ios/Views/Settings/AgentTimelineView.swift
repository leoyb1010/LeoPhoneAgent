//
//  AgentTimelineView.swift
//  MinisApp
//
//  [T-agent-timeline] 2.0 pillar 9: "what did Leo do" on one screen. Reads
//  the existing AgentActivityLog (append-only SQLite) — no new tracking, just
//  visibility. Rows deep-link back into their session.
//
//  Rows are precomputed structs: the first version fed raw events through
//  heavy builder expressions and segfaulted the type checker.
//

import SwiftUI

struct AgentTimelineView: View {
    fileprivate struct Row: Identifiable {
        let id: String
        let sessionId: String
        let symbol: String
        let title: String
        let subtitle: String
        let warning: String?
    }

    fileprivate struct DayGroup: Identifiable {
        let id: String
        let rows: [Row]
    }

    @State private var groups: [DayGroup] = []

    var body: some View {
        List {
            if groups.isEmpty {
                Text("No agent activity recorded yet.")
                    .foregroundStyle(.secondary)
            }
            ForEach(groups) { group in
                Section(group.id) {
                    ForEach(group.rows) { row in
                        TimelineRowView(row: row)
                    }
                }
            }
        }
        .navigationTitle(Text("Agent Timeline"))
        .task { reload() }
        .refreshable { reload() }
    }

    private func reload() {
        let events = AgentActivityLog.shared.recent(limit: 300)
        let dayFormatter = DateFormatter()
        dayFormatter.dateStyle = .medium
        let timeFormatter = DateFormatter()
        timeFormatter.timeStyle = .short

        var byDay: [String: [Row]] = [:]
        var dayOrder: [String] = []
        for event in events.sorted(by: { $0.at > $1.at }) {
            let day = dayFormatter.string(from: event.at)
            let title: String
            if let tool = event.toolName, !tool.isEmpty {
                title = AgentToolPresentation.displayName(for: tool)
            } else {
                title = event.phase.rawValue.capitalized
            }
            let symbol: String
            if let tool = event.toolName, !tool.isEmpty {
                symbol = AgentToolPresentation.symbol(for: tool)
            } else {
                symbol = "circle.dashed"
            }
            let subtitle = timeFormatter.string(from: event.at)
                + " · " + String(event.sessionId.prefix(8))
            let warning = event.reason.map { String(describing: $0) }
            let row = Row(id: event.id, sessionId: event.sessionId,
                          symbol: symbol, title: title,
                          subtitle: subtitle, warning: warning)
            if byDay[day] == nil { dayOrder.append(day) }
            byDay[day, default: []].append(row)
        }
        groups = dayOrder.map { DayGroup(id: $0, rows: byDay[$0] ?? []) }
    }
}

private struct TimelineRowView: View {
    let row: AgentTimelineView.Row

    var body: some View {
        Button {
            NotificationCenter.default.post(
                name: .openSessionFromIntent, object: nil,
                userInfo: ["sessionId": row.sessionId])
        } label: {
            HStack(spacing: 10) {
                Image(systemName: row.symbol)
                    .font(.caption)
                    .foregroundStyle(.teal)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(row.title)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                    Text(row.subtitle)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if let warning = row.warning {
                    Text(warning)
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
            }
        }
    }
}
