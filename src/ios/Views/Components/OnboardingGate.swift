//
//  OnboardingGate.swift
//  MinisApp
//
//  [G2] 首启新手引导什么时候出现。界面在 Views/Providers/OnboardingFlowView.swift;
//  这里只放判断(编进逻辑测试)。
//

import Foundation

enum OnboardingGate {
    static let completedKey = "leo.onboarding.completed.v1"
    /// 截图 / 调试用:启动参数 `-LeoForceOnboarding YES` 不管状态直接出引导,
    /// `-LeoOnboardingStep 0|1|2` 指定从哪一步开始。
    static let forceKey = "LeoForceOnboarding"
    static let debugStepKey = "LeoOnboardingStep"

    enum Step: Int, CaseIterable {
        case model, mac, firstTask
    }

    /// 首启自动出现:没配好模型、没完成 / 跳过过引导、「本次更新」已经看过(不跟它抢)。
    static func shouldPresent(hasModel: Bool, completed: Bool, releaseNotesPending: Bool) -> Bool {
        !hasModel && !completed && !releaseNotesPending
    }

    /// 配好模型就算完成:以后再也不自动出现。
    static func shouldMarkCompleted(hasModel: Bool) -> Bool { hasModel }

    static func isCompleted(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: completedKey)
    }

    static func markCompleted(_ defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: completedKey)
    }

    static func isForced(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: forceKey)
    }

    static func initialStep(_ defaults: UserDefaults = .standard) -> Step {
        guard defaults.object(forKey: debugStepKey) != nil else { return .model }
        return Step(rawValue: defaults.integer(forKey: debugStepKey)) ?? .model
    }

    /// 下一步;最后一步之后是 nil(结束)。
    static func next(after step: Step) -> Step? { Step(rawValue: step.rawValue + 1) }
}
