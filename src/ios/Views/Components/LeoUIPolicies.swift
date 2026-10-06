import Foundation

// [F5 / F7 / F8] The decisions behind the unified UI, kept free of SwiftUI so
// MinisLogicTests can pin them. Views only render what these return.

// MARK: - F5 首页情境条

/// One session as the home context strip sees it.
struct HomeContextSession: Equatable {
    let id: String
    let title: String
    let updatedAt: Date
    /// Running, suspended, interrupted (paused badge) or finished in the
    /// background and not read yet — i.e. something the user should go back to.
    let unfinished: Bool
}

/// The focus wrap-up the context layer (D) leaves at
/// `leo.context.focusSummary`: `{"title","done","pending","createdAt"}`.
struct HomeFocusWrapUp: Codable, Equatable {
    let title: String
    let done: [String]
    let pending: [String]
    let createdAt: Double
}

struct HomeContextSnapshot: Equatable {
    struct Resume: Equatable {
        let sessionId: String
        let title: String
        let updatedAt: Date
        /// Chosen by the context layer's pin rather than by recency.
        let pinned: Bool
    }

    var focus: HomeFocusWrapUp?
    var resume: Resume?
    var todaySessions = 0
    var pendingCount = 0
    /// The quiet-inbox toggle only means something once sessions are filed
    /// into folders (otherwise "未分组" equals "全部"), while it is on, or
    /// when quiet / context runs left unread results there.
    var showsInboxToggle = false
    var inboxActive = false
    /// Unread results of quiet / context-triggered runs (`source` "quiet" or
    /// "context"), which land unfiled — i.e. in the quiet inbox.
    var quietUnread = 0

    var showsToday: Bool { todaySessions > 0 || pendingCount > 0 }
    /// Every item hides when it has nothing to say; with none left the
    /// whole strip disappears.
    var isEmpty: Bool { focus == nil && resume == nil && !showsToday && !showsInboxToggle }
}

enum HomeContextResolver {
    /// Written by the context layer (D): which session to put on top, and when.
    static let pinnedSessionIdKey = "leo.context.pinnedSessionId"
    static let pinnedAtKey = "leo.context.pinnedAt"
    static let focusSummaryKey = "leo.context.focusSummary"
    /// `ChatSession.source` of sessions the context layer creates (quiet
    /// tasks, context triggers); they land unfiled and unread.
    static let quietSources: Set<String> = ["quiet", "context"]

    static let pinLifetime: TimeInterval = 12 * 3600
    static let focusLifetime: TimeInterval = 24 * 3600

    static func snapshot(
        sessions: [HomeContextSession],
        pendingCount: Int,
        hasFolders: Bool,
        inboxActive: Bool,
        quietUnread: Int = 0,
        pinnedSessionId: String?,
        pinnedAt: Double?,
        focusPayload: Any?,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> HomeContextSnapshot {
        var snapshot = HomeContextSnapshot()
        snapshot.focus = focusWrapUp(from: focusPayload, now: now)
        snapshot.resume = resume(sessions: sessions, pinnedSessionId: pinnedSessionId, pinnedAt: pinnedAt, now: now)
        snapshot.todaySessions = sessions.filter { calendar.isDate($0.updatedAt, inSameDayAs: now) }.count
        snapshot.pendingCount = max(0, pendingCount)
        snapshot.quietUnread = max(0, quietUnread)
        snapshot.showsInboxToggle = hasFolders || inboxActive || snapshot.quietUnread > 0
        snapshot.inboxActive = inboxActive
        return snapshot
    }

    /// "继续上次": a fresh pin from the context layer wins when its session
    /// still exists; otherwise the most recently touched unfinished session.
    static func resume(sessions: [HomeContextSession], pinnedSessionId: String?, pinnedAt: Double?,
                       now: Date) -> HomeContextSnapshot.Resume? {
        if let pinnedSessionId, !pinnedSessionId.isEmpty, let pinnedAt,
           now.timeIntervalSince1970 - pinnedAt <= pinLifetime,
           now.timeIntervalSince1970 - pinnedAt >= -60,
           let session = sessions.first(where: { $0.id == pinnedSessionId }) {
            return .init(sessionId: session.id, title: session.title, updatedAt: session.updatedAt, pinned: true)
        }
        guard let latest = sessions.filter(\.unfinished).max(by: { $0.updatedAt < $1.updatedAt }) else { return nil }
        return .init(sessionId: latest.id, title: latest.title, updatedAt: latest.updatedAt, pinned: false)
    }

    /// Accepts what D stores (JSON `Data`), plus a JSON `String` or an
    /// already-decoded dictionary. Older than 24h (or from the future) is ignored.
    static func focusWrapUp(from payload: Any?, now: Date) -> HomeFocusWrapUp? {
        let data: Data?
        switch payload {
        case let value as Data: data = value
        case let value as String: data = value.data(using: .utf8)
        case let value as [String: Any]: data = try? JSONSerialization.data(withJSONObject: value)
        default: data = nil
        }
        guard let data, let wrapUp = try? JSONDecoder().decode(HomeFocusWrapUp.self, from: data) else { return nil }
        let age = now.timeIntervalSince1970 - wrapUp.createdAt
        guard age <= focusLifetime, age >= -60 else { return nil }
        guard !wrapUp.title.isEmpty || !wrapUp.done.isEmpty || !wrapUp.pending.isEmpty else { return nil }
        return wrapUp
    }
}

// MARK: - F7 思考过程默认安静

enum ThinkingDisplayPolicy {
    /// While thinking streams, only the live tail is laid out: each flush
    /// re-lays the whole visible Text, so a short window keeps that cost flat
    /// no matter how long the thinking gets.
    static let streamingWindow = 2_000
    /// Once settled, a longer tail for reading back.
    static let settledWindow = 8_000

    static func window(isStreaming: Bool) -> Int { isStreaming ? streamingWindow : settledWindow }

    /// The tail shown in an expanded thinking block, cut at a line start when
    /// the cut would land mid-line. O(window), never O(content).
    static func tail(of content: String, isStreaming: Bool) -> (text: Substring, truncated: Bool) {
        let window = window(isStreaming: isStreaming)
        guard let start = content.index(content.endIndex, offsetBy: -window, limitedBy: content.startIndex),
              start > content.startIndex else {
            return (content[...], false)
        }
        if content[content.index(before: start)] == "\n" { return (content[start...], true) }
        let cleanStart = content[start...].firstIndex(of: "\n").map { content.index(after: $0) } ?? start
        return (content[(cleanStart < content.endIndex ? cleanStart : start)...], true)
    }
}

// MARK: - F8 对话检查器

enum ChatInspectorTabPolicy {
    /// The three fixed tabs, in order: tool timeline, usage, memory hits.
    static let tabs = ["run", "usage", "memory"]

    /// Stored selections from the four-tab inspector (session / artifacts /
    /// files) map onto the new set instead of landing on a dead value.
    static func resolve(_ stored: String?) -> String {
        guard let stored else { return "run" }
        if tabs.contains(stored) { return stored }
        return stored == "session" ? "usage" : "run"
    }
}
