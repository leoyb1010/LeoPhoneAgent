//
//  HarnessFollowClient.swift
//  MinisApp
//
//  [remote-ctl-power] 「关注」接口(契约:leo-link-remote-controls.md「关注（省电）」)。
//  - `GET /v1/capabilities` 的 `features.follow` 为 true 才能调;
//  - `POST /harness/sessions/:id/follow {"following":bool}` → `200 {"following":bool}`。
//

import Foundation

extension LeoAgentClient {
    /// 这台 Mac 认不认「关注」。请求失败按不支持处理(调用方给用户一句原因)。
    func harnessSupportsFollow() async -> Bool {
        guard let obj = try? await getJSON("/v1/capabilities", service: .harness) else { return false }
        return (obj["features"] as? [String: Any])?["follow"] as? Bool == true
    }

    /// 关注 / 取消关注一个 Mac 会话。返回 Mac 记下的值。
    @discardableResult
    func setHarnessFollowing(sessionId: String, following: Bool) async throws -> Bool {
        let obj = try await postJSON("/harness/sessions/\(sessionId)/follow",
                                     body: ["following": following], service: .harness)
        return obj["following"] as? Bool ?? following
    }
}
