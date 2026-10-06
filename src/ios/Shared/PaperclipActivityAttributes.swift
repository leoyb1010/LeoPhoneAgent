import ActivityKit
import Foundation

/// [G2] Paperclip 工单的实时活动（灵动岛 / 锁屏）。主 App、小组件扩展与逻辑测试共用；
/// 不依赖 Paperclip 客户端或本机对话。一个工单只对应一个活动，用 issueKey 去重。
struct PaperclipActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        enum Phase: String, Codable, Hashable {
            case queued, running, succeeded, failed, cancelled

            init(runStatus: String) {
                switch runStatus {
                case "queued": self = .queued
                case "succeeded": self = .succeeded
                case "failed", "timed_out": self = .failed
                case "cancelled": self = .cancelled
                default: self = .running
                }
            }
            var isTerminal: Bool { self == .succeeded || self == .failed || self == .cancelled }
            var label: String {
                switch self {
                case .queued: return "排队中"
                case .running: return "运行中"
                case .succeeded: return "已完成"
                case .failed: return "运行失败"
                case .cancelled: return "已取消"
                }
            }
            var symbol: String {
                switch self {
                case .queued: return "hourglass"
                case .running: return "gearshape.2.fill"
                case .succeeded: return "checkmark.circle.fill"
                case .failed: return "exclamationmark.triangle.fill"
                case .cancelled: return "stop.circle.fill"
                }
            }
        }
        var phase: Phase
        var runID: String
        var agentName: String
        /// 当前阶段（工具或进度消息）；隐私模式下为空。
        var stage: String
        /// 工单标题；隐私模式下为空。
        var title: String
        var startedAt: Date
        var finishedAt: Date?
    }

    /// 去重键：配置 / 公司 / 工单。
    let issueKey: String
    let issueID: String
    /// 工单编号（如 PAP-12）；服务器未返回时为空。
    let identifier: String
    /// 点击打开的深链 leophoneagent://paperclip/issue/…
    let link: String

    static func issueKey(profileID: UUID, companyID: String, issueID: String) -> String {
        "\(profileID.uuidString)/\(companyID)/\(issueID)"
    }
    static func profilePrefix(_ profileID: UUID) -> String { profileID.uuidString + "/" }
    /// 终态后在锁屏与灵动岛上保留 4 小时。
    static let lingerAfterTerminal: TimeInterval = 4 * 3600
    /// 运行中超过 30 分钟没有新状态即标记为过期（App 被挂起、错过事件时不再显示"运行中"）。
    static let runningStaleAfter: TimeInterval = 30 * 60
}

/// [G2] 同一工单只保留一个活动：复用第一个仍在显示的，其余（重复的、已结束仍挂着的）立即移除。
enum PaperclipActivityDedupe {
    struct Existing: Equatable {
        let id: String
        let issueKey: String
        /// 仍可更新（active / stale）；已结束的活动不能再更新。
        let isLive: Bool
    }
    struct Plan: Equatable {
        let reuse: String?
        let dismiss: [String]
    }
    static func plan(existing: [Existing], issueKey: String) -> Plan {
        let same = existing.filter { $0.issueKey == issueKey }
        let reuse = same.first(where: \.isLive)?.id
        return Plan(reuse: reuse, dismiss: same.map(\.id).filter { $0 != reuse })
    }
}
