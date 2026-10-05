import Foundation

/// 同一批工具调用的分道:会互相踩的调用排进同一条道、按模型给出的顺序串行,其余照旧并行。
///
/// 只有批内存在「写」时才合道:同一路径的 file_write / file_edit / file_read,或同一个 Cursor agent 的
/// followup / cancel / status。没有写的资源(比如五个 file_read)仍然各自并行,不拖慢只读批次。
/// 以前整批无条件并行,模型在一轮里对同一文件发两次 file_edit 时,后一次可能读到旧内容、覆盖掉前一次。
enum ToolExecutionLanes {
    struct Call {
        let name: String
        let args: [String: Any]
    }

    /// 每条道是原始下标的升序数组;道与道之间的顺序按各自第一个下标排列。
    static func plan(_ calls: [Call]) -> [[Int]] {
        let claims = calls.map(claim(for:))
        let contended = Set(claims.compactMap { $0?.writes == true ? $0?.key : nil })

        var lanes: [[Int]] = []
        var laneForKey: [String: Int] = [:]
        for (index, claim) in claims.enumerated() {
            guard let claim, contended.contains(claim.key) else {
                lanes.append([index])
                continue
            }
            if let lane = laneForKey[claim.key] {
                lanes[lane].append(index)
            } else {
                laneForKey[claim.key] = lanes.count
                lanes.append([index])
            }
        }
        return lanes
    }

    private static func claim(for call: Call) -> (key: String, writes: Bool)? {
        switch call.name {
        case "file_write", "file_edit", "file_read":
            guard let path = (call.args["path"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !path.isEmpty else { return nil }
            return ("file:" + (path as NSString).standardizingPath, call.name != "file_read")
        case "cursor_agent_followup", "cursor_agent_cancel", "cursor_agent_status":
            guard let id = (call.args["agent_id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !id.isEmpty else { return nil }
            return ("cursor:" + id, call.name != "cursor_agent_status")
        default:
            return nil
        }
    }
}
