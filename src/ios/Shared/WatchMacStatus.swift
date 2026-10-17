//
//  WatchMacStatus.swift
//  MinisApp / LeoWatch / LeoWatchWidget
//
//  [WP-44] 手表上的「Mac 状态」与复杂功能共用的纯数据层(纯 Foundation,四个 target 共用):
//  - iPhone 把 Leo Link 的 Mac 任务摘要(运行数、待审批数、最多 5 行)塞进 WatchConnectivity
//    的 applicationContext(`macStatus` 键,JSON 字符串,不会撑爆 context 的大小限制);
//  - 手表收到后显示「Mac 状态」页,并把一份快照写进 App Group,给表盘复杂功能和 Smart Stack 用;
//  - 审批卡的风险色与 60 s 超时也在这里定,手机、手表口径一致。
//

import Foundation

struct WatchMacStatus: Codable, Equatable {
    struct Row: Codable, Equatable, Identifiable {
        var id: String
        var title: String
        var status: String
        var waiting: Bool
    }

    var running: Int
    var waiting: Int
    var rows: [Row]
    var updatedAt: Date

    static let empty = WatchMacStatus(running: 0, waiting: 0, rows: [], updatedAt: .distantPast)
    /// applicationContext 每次整体替换、而且有大小上限:只带最需要看的几行。
    static let maxRows = 5
    static let contextKey = "macStatus"

    /// 从手机端的任务行汇总(等你审批的排最前)。
    static func summarize(_ items: [(id: String, title: String, status: String, waiting: Bool, running: Bool)],
                          now: Date = Date()) -> WatchMacStatus {
        let sorted = items.sorted { lhs, rhs in
            if lhs.waiting != rhs.waiting { return lhs.waiting }
            if lhs.running != rhs.running { return lhs.running }
            return false
        }
        return WatchMacStatus(
            running: items.filter(\.running).count,
            waiting: items.filter(\.waiting).count,
            rows: sorted.prefix(maxRows).map {
                Row(id: String($0.id.prefix(80)), title: String($0.title.prefix(40)),
                    status: String($0.status.prefix(40)), waiting: $0.waiting)
            },
            updatedAt: now)
    }

    func encodedForContext() -> String? {
        guard let data = try? Self.encoder.encode(self) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func decode(fromContext value: Any?) -> WatchMacStatus? {
        guard let text = value as? String, let data = text.data(using: .utf8) else { return nil }
        return try? decoder.decode(WatchMacStatus.self, from: data)
    }

    /// 签名只看会改变手表显示的字段:同样的状态不再占 applicationContext 的推送配额。
    var signature: String {
        "\(running)|\(waiting)|" + rows.map { "\($0.id):\($0.status):\($0.waiting)" }.joined(separator: ",")
    }

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder(); e.dateEncodingStrategy = .secondsSince1970; e.outputFormatting = [.sortedKeys]; return e
    }()
    private static let decoder: JSONDecoder = {
        let d = JSONDecoder(); d.dateDecodingStrategy = .secondsSince1970; return d
    }()
}

/// [WP-44] 审批卡口径:风险色对齐跨端 token(attention / destructive),60 s 没人答就收起。
enum WatchApprovalPolicy {
    /// 手表上的审批卡挂这么久没答就收起,留在「Mac 状态」页(Mac 那边仍在等,手机也能答)。
    static let timeout: TimeInterval = 60

    enum Tone: Equatable { case readOnly, attention, destructive }

    static func tone(forRisk risk: String) -> Tone {
        switch risk {
        case "high": return .destructive
        case "low": return .readOnly
        default: return .attention
        }
    }

    static func hasTimedOut(shownAt: Date, now: Date) -> Bool {
        now.timeIntervalSince(shownAt) >= timeout
    }
}

/// [WP-44] 表盘复杂功能读的快照。由手表 App 写进 App Group,小组件扩展只读。
struct WatchWidgetSnapshot: Codable, Equatable {
    var macRunning: Int
    var macWaiting: Int
    var lastQuestion: String
    var lastAnswer: String
    var updatedAt: Date

    static let empty = WatchWidgetSnapshot(macRunning: 0, macWaiting: 0, lastQuestion: "", lastAnswer: "", updatedAt: .distantPast)

    /// Smart Stack 相关度:有待审批时最高(把这张卡顶到最前),有任务在跑次之,否则很低。
    var relevanceScore: Float {
        if macWaiting > 0 { return 100 }
        if macRunning > 0 { return 40 }
        return 1
    }

    static let appGroup = "group.com.leoyuan.leophoneagent"
    static let defaultsKey = "leo.watch.widgetSnapshot.v1"

    static func load(from defaults: UserDefaults? = UserDefaults(suiteName: appGroup)) -> WatchWidgetSnapshot {
        guard let data = defaults?.data(forKey: defaultsKey),
              let snap = try? JSONDecoder().decode(WatchWidgetSnapshot.self, from: data) else { return .empty }
        return snap
    }

    /// 返回是否真的变了(没变就不用刷新复杂功能的时间线,省电)。
    @discardableResult
    func save(to defaults: UserDefaults? = UserDefaults(suiteName: appGroup)) -> Bool {
        guard let defaults else { return false }
        let previous = Self.load(from: defaults)
        var a = previous; a.updatedAt = updatedAt
        guard a != self, let data = try? JSONEncoder().encode(self) else { return false }
        defaults.set(data, forKey: Self.defaultsKey)
        return true
    }
}
