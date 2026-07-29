//
//  WidgetDataMirror.swift
//  MinisApp
//
//  [T-widget-mirror] The widget process can only read the App Group, while
//  the chat database, usage stats and memory files all live in the app's
//  sandbox. This is the single place that copies those three things across
//  for the briefing / today-overview / memory widgets. Everything here is
//  best-effort: a failed mirror leaves the previous snapshot in place rather
//  than blanking a widget.
//

import Foundation
import WidgetKit

private let logger = AppLogger(category: "WidgetMirror")

enum WidgetDataMirror {

    // MARK: - Daily briefing

    /// Records a finished task's reply as the briefing card. Skips writing
    /// when Privacy Mode is on — a redacted card carries no value and the
    /// summary is the most sensitive thing we mirror.
    /// - Returns: true when a card was written.
    @discardableResult
    @MainActor
    static func recordBriefing(taskName: String, sessionId: String) async -> Bool {
        guard !BackgroundKeepAliveManager.shared.liveActivityPrivacyMode else {
            logger.info("briefing skipped (privacy mode) session=\(sessionId.prefix(8))")
            return false
        }
        let messages = await ChatStore.shared.loadMessages(sessionId: sessionId)
        guard let last = messages.last(where: { $0.role == .assistant }) else {
            logger.info("briefing not ready — no assistant message yet session=\(sessionId.prefix(8))")
            return false
        }

        let text = last.parts.compactMap { part -> String? in
            if case .text(let value) = part { return value }
            return nil
        }.joined(separator: "\n")

        let summary = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !summary.isEmpty else {
            logger.info("briefing not ready — assistant reply has no text session=\(sessionId.prefix(8))")
            return false
        }

        WidgetBriefingStore.save(WidgetBriefing(
            // [T-briefing-timestamp] Use the reply's own timestamp. Using
            // `Date()` meant a briefing published on the next foreground —
            // which is the normal path for an overnight scheduled run — was
            // stamped "now", so the card claimed to be from just now and the
            // "· Not today" marker could never appear.
            generatedAt: last.createdAt,
            taskName: taskName,
            sessionId: sessionId,
            summary: String(summary.prefix(400))
        ))
        WidgetCenter.shared.reloadTimelines(ofKind: LeoWidgetKind.briefing)
        WidgetCenter.shared.reloadTimelines(ofKind: LeoWidgetKind.iPadConsole)
        logger.info("briefing recorded task=\(taskName) session=\(sessionId.prefix(8)) chars=\(summary.count)")
        return true
    }

    /// [T-widget-briefing-pending] Resolves every widget-launched session that
    /// still owes a briefing. Safe to call repeatedly and from any lifecycle
    /// point — sessions whose reply has not landed yet simply stay pending.
    @MainActor
    static func resolvePendingBriefings(reason: String) async {
        let pending = WidgetPendingBriefingStore.loadEntries()
        guard !pending.isEmpty else { return }
        logger.info("resolving \(pending.count) pending briefing(s) reason=\(reason)")
        // [T-pending-briefing-order] Oldest first, so when several resolve in
        // the same pass the NEWEST one wins the single briefing slot. Iterating
        // a Dictionary left that to the hash seed.
        for entry in pending {
            // Stale check FIRST: a session wedged in activeSessions by a bug
            // used to dodge the sweep forever and hold one of the 10 slots.
            if Date().timeIntervalSince(entry.addedAt) > 24 * 3600 {
                logger.info("dropping stale pending briefing session=\(entry.sessionId.prefix(8))")
                WidgetPendingBriefingStore.remove(sessionId: entry.sessionId)
                continue
            }
            // Never resolve a session that is still working — its final
            // message is not written yet.
            if SessionActivityTracker.shared.activeSessions.contains(entry.sessionId) { continue }
            if await recordBriefing(taskName: entry.taskName, sessionId: entry.sessionId) {
                WidgetPendingBriefingStore.remove(sessionId: entry.sessionId)
                // [T-scheduled-report] Close the loop for scheduled runs: the
                // user asked for this work in advance, tell them it landed.
                if entry.origin == "scheduled" {
                    ScheduledTaskRunner.notify(
                        title: String(localized: "Scheduled task finished"),
                        body: entry.taskName,
                        sessionId: entry.sessionId)
                }
            }
        }
    }

    // MARK: - Usage summary

    /// Aggregates token usage into today's totals plus a 7-day trend.
    /// Mirrors the Usage screen's cache-hit definition: only models that
    /// actually report cache activity contribute to the denominator.
    @MainActor
    static func refreshUsage() async {
        let records = await ChatStore.shared.fetchUsageStats()
        guard !records.isEmpty else { return }

        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())

        var todayTokens = 0
        var todaySessions = Set<String>()
        var tokensByDay: [Date: Int] = [:]
        var tokensByModel: [String: Int] = [:]
        var todayTokensByModel: [String: Int] = [:]
        var cacheCapableInput = 0
        var cacheRead = 0

        for record in records {
            let usage = record.usage
            let total = usage.inputTokens + usage.outputTokens
                + usage.cacheCreationTokens + usage.cacheReadTokens
            let day = calendar.startOfDay(for: record.date)
            tokensByDay[day, default: 0] += total
            tokensByModel[record.modelId, default: 0] += total

            // [T-today-overview-scope] Everything rendered under the "Today"
            // heading has to BE today's. The cache-hit rate and the top model
            // used to accumulate over all history while the tokens and task
            // count next to them were same-day, so the widget showed a lifetime
            // number under a today label.
            guard day == today else { continue }
            todayTokens += total
            todaySessions.insert(record.sessionId)
            todayTokensByModel[record.modelId, default: 0] += total
            if usage.cacheReadTokens > 0 || usage.cacheCreationTokens > 0 {
                cacheCapableInput += usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens
                cacheRead += usage.cacheReadTokens
            }
        }

        let recentDays: [WidgetUsageSummary.DayBucket] = (0..<7).compactMap { offset in
            guard let day = calendar.date(byAdding: .day, value: -offset, to: today) else { return nil }
            return .init(day: day, tokens: tokensByDay[day] ?? 0)
        }.reversed()

        let summary = WidgetUsageSummary(
            updatedAt: Date(),
            todayTasks: todaySessions.count,
            todayTokens: todayTokens,
            cacheHitRate: cacheCapableInput > 0
                ? Double(cacheRead) / Double(cacheCapableInput) * 100
                : 0,
            // Today's busiest model, matching the label above it. The
            // all-time `tokensByDay` still feeds the 7-day sparkline, which is
            // explicitly labelled as a 7-day trend.
            topModel: todayTokensByModel.max(by: { $0.value < $1.value })?.key ?? "",
            recentDays: recentDays
        )
        WidgetUsageStore.save(summary)
        WidgetCenter.shared.reloadTimelines(ofKind: LeoWidgetKind.todayOverview)
    }

    // MARK: - Memory lens

    /// Mirrors today's memory log: entry count plus the newest line. Under
    /// Privacy Mode the count is still published but the text is withheld,
    /// so the widget can show activity without leaking content.
    @MainActor
    static func refreshMemory() {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        let fileURL = AIChatViewModel.minisMemoryPersistentDir
            .appendingPathComponent("\(formatter.string(from: Date())).md")

        let redacted = BackgroundKeepAliveManager.shared.liveActivityPrivacyMode
        guard let content = try? String(contentsOf: fileURL, encoding: .utf8) else {
            WidgetMemoryStore.save(WidgetMemorySnapshot(
                updatedAt: Date(), todayCount: 0, latestEntry: "", isRedacted: redacted
            ))
            WidgetCenter.shared.reloadTimelines(ofKind: LeoWidgetKind.memory)
            return
        }

        // Daily logs are bullet lists; count the bullets and take the last one.
        let entries = content
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.hasPrefix("- ") || $0.hasPrefix("* ") }
            .map { String($0.dropFirst(2)) }

        WidgetMemoryStore.save(WidgetMemorySnapshot(
            updatedAt: Date(),
            todayCount: entries.count,
            latestEntry: redacted ? "" : String((entries.last ?? "").prefix(180)),
            isRedacted: redacted
        ))
        WidgetCenter.shared.reloadTimelines(ofKind: LeoWidgetKind.memory)
    }

    // MARK: - Artifacts

    /// [T-widget-artifacts] Mirrors the most recent artifacts. Titles are
    /// user-facing filenames, so this follows the same Privacy Mode rule as
    /// the briefing card: under redaction we publish the count and kinds but
    /// not the names.
    @MainActor
    static func refreshArtifacts() async {
        let redacted = BackgroundKeepAliveManager.shared.liveActivityPrivacyMode
        guard let snapshots = try? await ArtifactRepository.shared.list() else { return }
        let recent = snapshots
            .sorted { $0.artifact.updatedAt > $1.artifact.updatedAt }
            .prefix(8)
        let items = recent.map { snap in
            WidgetArtifactItem(
                id: snap.artifact.id,
                title: redacted ? kindLabel(snap.artifact.kind) : snap.artifact.title,
                kind: snap.artifact.kind.rawValue,
                sessionId: snap.artifact.sessionId,
                updatedAt: snap.artifact.updatedAt,
                symbolName: symbol(for: snap.artifact.kind)
            )
        }
        WidgetArtifactsStore.save(Array(items))
        WidgetCenter.shared.reloadTimelines(ofKind: LeoWidgetKind.artifacts)
    }

    private static func symbol(for kind: ArtifactKind) -> String {
        switch kind {
        case .document: return "doc.text.fill"
        case .image: return "photo.fill"
        case .audio: return "waveform"
        case .video: return "film.fill"
        case .code: return "chevron.left.forwardslash.chevron.right"
        case .archive: return "shippingbox.fill"
        case .file: return "doc.fill"
        }
    }

    private static func kindLabel(_ kind: ArtifactKind) -> String {
        switch kind {
        case .document: return "文档"
        case .image: return "图片"
        case .audio: return "音频"
        case .video: return "视频"
        case .code: return "代码"
        case .archive: return "压缩包"
        case .file: return "文件"
        }
    }

    /// Convenience for app lifecycle hooks that just want everything current.
    @MainActor
    static func refreshAll() async {
        await refreshUsage()
        refreshMemory()
        await refreshArtifacts()
    }
}
