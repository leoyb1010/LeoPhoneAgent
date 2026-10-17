//
//  LeoWatchWidgets.swift
//  LeoWatchWidget — watch face complications, Smart Stack card, Control
//
//  [WP-44] Reads the snapshot the watch app writes into the App Group
//  (`WatchWidgetSnapshot`); never talks to the phone or the network itself.
//  - accessoryCircular: 问 Leo (tap → mic page)
//  - accessoryRectangular: pending approvals / running Mac tasks, else the last answer
//  - accessoryCorner: running count
//  Smart Stack: entries carry TimelineEntryRelevance — a pending approval scores
//  highest so the card rises to the top on its own.
//

import AppIntents
import SwiftUI
import WidgetKit

struct LeoWatchEntry: TimelineEntry {
    let date: Date
    let snapshot: WatchWidgetSnapshot
    var relevance: TimelineEntryRelevance? { TimelineEntryRelevance(score: snapshot.relevanceScore) }
}

struct LeoWatchProvider: TimelineProvider {
    func placeholder(in context: Context) -> LeoWatchEntry {
        LeoWatchEntry(date: .now, snapshot: WatchWidgetSnapshot(macRunning: 1, macWaiting: 0, lastQuestion: "",
                                                                lastAnswer: "", updatedAt: .now))
    }

    func getSnapshot(in context: Context, completion: @escaping (LeoWatchEntry) -> Void) {
        completion(LeoWatchEntry(date: .now, snapshot: .load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<LeoWatchEntry>) -> Void) {
        // The app reloads timelines whenever the snapshot changes; the 30-min refresh only
        // lets a stale "等你确认" decay if the app never ran again.
        let entry = LeoWatchEntry(date: .now, snapshot: .load())
        completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(30 * 60))))
    }
}

private let attention = Color(red: 0xF0 / 255, green: 0xB8 / 255, blue: 0x6E / 255)

struct LeoAskComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "LeoWatchAsk", provider: LeoWatchProvider()) { entry in
            ZStack {
                AccessoryWidgetBackground()
                Image(systemName: entry.snapshot.macWaiting > 0 ? "hand.raised.fill" : "mic.fill")
                    .font(.title3.weight(.semibold))
                    .widgetAccentable()
            }
            .widgetURL(URL(string: entry.snapshot.macWaiting > 0 ? "leobot://watch/mac" : "leobot://watch/ask"))
            .containerBackground(.clear, for: .widget)
        }
        .configurationDisplayName("问 Leo")
        .description("一点就开始语音提问;有 Mac 在等你确认时变成举手图标。")
        .supportedFamilies([.accessoryCircular])
    }
}

struct LeoStatusComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "LeoWatchStatus", provider: LeoWatchProvider()) { entry in
            LeoStatusView(snapshot: entry.snapshot)
                .widgetURL(URL(string: "leobot://watch/mac"))
                .containerBackground(.clear, for: .widget)
        }
        .configurationDisplayName("LeoBot 状态")
        .description("Mac 上等你确认 / 正在跑的任务,或最近一次回答。")
        .supportedFamilies([.accessoryRectangular, .accessoryCorner, .accessoryInline])
    }
}

private struct LeoStatusView: View {
    let snapshot: WatchWidgetSnapshot
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch family {
        case .accessoryCorner:
            Image(systemName: "desktopcomputer")
                .font(.title3)
                .widgetLabel { Text("\(snapshot.macRunning) 个在跑") }
        case .accessoryInline:
            Text(inlineText)
        default:
            VStack(alignment: .leading, spacing: 2) {
                if snapshot.macWaiting > 0 {
                    Label("\(snapshot.macWaiting) 个等你确认", systemImage: "hand.raised.fill")
                        .font(.headline)
                        .foregroundStyle(attention)
                        .widgetAccentable()
                    Text("\(snapshot.macRunning) 个任务在 Mac 上跑").font(.caption2)
                } else if snapshot.macRunning > 0 {
                    Label("\(snapshot.macRunning) 个在跑", systemImage: "desktopcomputer")
                        .font(.headline)
                        .widgetAccentable()
                    Text("Mac · LeoBot").font(.caption2)
                } else if !snapshot.lastAnswer.isEmpty {
                    Text(snapshot.lastQuestion.isEmpty ? "最近的回答" : snapshot.lastQuestion)
                        .font(.caption2.weight(.semibold))
                        .lineLimit(1)
                        .widgetAccentable()
                    Text(snapshot.lastAnswer).font(.caption2).lineLimit(2)
                } else {
                    Label("问 Leo", systemImage: "mic.fill").font(.headline).widgetAccentable()
                    Text("抬腕说出要做的事").font(.caption2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var inlineText: String {
        if snapshot.macWaiting > 0 { return "\(snapshot.macWaiting) 个等你确认" }
        if snapshot.macRunning > 0 { return "Mac \(snapshot.macRunning) 个在跑" }
        return "问 Leo"
    }
}

/// Control Center / Smart Stack control: same intent as the Action Button.
struct LeoAskControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "LeoWatchAskControl") {
            ControlWidgetButton(action: AskLeoIntent()) {
                Label("问 Leo", systemImage: "mic.fill")
            }
        }
        .displayName("问 Leo")
        .description("打开 LeoBot 开始语音提问。")
    }
}

@main
struct LeoWatchWidgetBundle: WidgetBundle {
    var body: some Widget {
        LeoAskComplication()
        LeoStatusComplication()
        LeoAskControl()
    }
}
