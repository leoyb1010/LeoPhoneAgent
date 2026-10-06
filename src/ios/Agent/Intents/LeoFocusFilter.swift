//
//  LeoFocusFilter.swift
//  MinisApp
//
//  [C9] 专注模式过滤条件:系统设置 › 专注模式 › <某个专注> › 专注模式过滤条件 › LeoPhoneAgent。
//  系统开关这个专注时调用 perform():写一条情境信号(诊断日志 context.signal),
//  并记下开始 / 结束时间。[D1][D5] 开始 / 结束这两次切换作为「开始专注」「结束专注」
//  情境信号交给 ContextSignalCenter:匹配规则,结束时生成专注收尾卡片。
//
//  系统在专注开启时用你设置的参数调用 perform(),关闭时用默认值(这里是空)调用,
//  所以参数都可选、无默认值:有值 = 开始,全空 = 结束。
//

import AppIntents
import Foundation

struct LeoFocusFilter: SetFocusFilterIntent {
    static var title: LocalizedStringResource = "LeoPhoneAgent 工作模式"
    static var description: IntentDescription? = IntentDescription("专注开启时告诉 LeoPhoneAgent 你在什么模式，是否静默非紧急通知。")
    /// 专注常在锁屏时切换;它只写本机状态和诊断日志。
    static var authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

    @Parameter(title: "工作模式名称")
    var modeName: String?

    @Parameter(title: "静默非紧急通知")
    var silenceNonUrgent: Bool?

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(modeName ?? "工作模式")",
                              subtitle: silenceNonUrgent == true ? "静默非紧急通知" : "通知照常")
    }

    func perform() async throws -> some IntentResult {
        let transition = LeoFocusState.record(modeName: modeName, silenceNonUrgent: silenceNonUrgent)
        if let transition {
            await MainActor.run {
                ContextSignalCenter.shared.enqueue(transition, source: "focus", logged: true)
                // 不等:perform 要快;没处理完的留在队列里,下次进前台接着处理。
                Task { await ContextSignalCenter.shared.processPending() }
            }
        }
        return .result()
    }
}

/// 专注状态的本机记录(UserDefaults),和诊断日志里的 context.signal。
enum LeoFocusState {
    static let activeKey = "leo.focus.active"
    static let modeKey = "leo.focus.modeName"
    static let silenceKey = "leo.focus.silenceNonUrgent"
    static let startedKey = "leo.focus.startedAt"
    static let endedKey = "leo.focus.endedAt"

    /// 返回这次调用造成的切换(「开始专注」/「结束专注」);只改参数不算切换,返回 nil。
    @discardableResult
    static func record(modeName: String?, silenceNonUrgent: Bool?, now: Date = Date(),
                       defaults: UserDefaults = .standard) -> String? {
        let active = modeName != nil || silenceNonUrgent != nil
        let wasActive = defaults.bool(forKey: activeKey)
        defaults.set(active, forKey: activeKey)
        if active {
            defaults.set(modeName ?? "专注", forKey: modeKey)
            defaults.set(silenceNonUrgent ?? false, forKey: silenceKey)
            if !wasActive { defaults.set(now, forKey: startedKey) }
        } else if wasActive {
            defaults.set(now, forKey: endedKey)
        }
        let event = active ? "focus.start" : "focus.end"
        DiagnosticRing.shared.record(.contextSignal, entryId: event,
                                     message: "\(event) mode=\(modeName ?? "-") silence=\(silenceNonUrgent.map(String.init) ?? "-")")
        if active && !wasActive { return ContextSignalName.focusStart }
        if !active && wasActive { return ContextSignalName.focusEnd }
        return nil
    }
}
