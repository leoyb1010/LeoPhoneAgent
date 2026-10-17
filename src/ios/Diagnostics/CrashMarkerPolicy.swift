import Foundation

/// [WP-46] 启动标记(launch marker)的纯判定逻辑,App 与逻辑测试共用。
///
/// 真机取证(2026-10-17)发现崩溃记录器几乎每次前台冷启动都出一份「崩溃报告」,而且一律
/// 标成「inactive — not a crash」:检查旧标记要等到第一帧之后才跑,在那之前新进程自己的
/// inactive/background 回调已经把阶段、内存合并进了**旧进程**的标记;报告里的日志也取自
/// 新进程。旧进程真实的退出状态(前台被看门狗杀、jetsam)就这样被盖掉了。
enum CrashMarkerPolicy {
    struct Verdict: Equatable {
        let type: String
        /// 系统在后台正常回收不算异常:只记一行日志,不占 20 份报告的名额
        /// (取证里 20 份有 13 份是这种,真崩溃被挤出去)。
        let writesReport: Bool
    }

    /// 只往「本进程自己写的」标记里合并阶段。pid 对不上说明那是上一个进程留下、
    /// 还没被检查的标记 —— 合并进去就是取证里那种覆盖。
    static func mayMerge(storedPid: Int?, currentPid: Int) -> Bool {
        storedPid == currentPid
    }

    /// 标记初始阶段按启动时的应用状态写:后台拉起(BGTask、推送、预热)写 background。
    static func initialPhase(isBackgroundLaunch: Bool) -> String {
        isBackgroundLaunch ? "background" : "inactive"
    }

    static func classify(lastPhase: String, runningShell: Bool, memoryMB: Int?,
                         memoryFreeMB: Int?, bgTaskRemaining: Double?) -> Verdict {
        if lastPhase == "inactive", !runningShell, (memoryMB ?? 0) < 350 {
            return Verdict(type: "Terminated while inactive (swiped away or relaunched) — not a crash", writesReport: true)
        }
        if lastPhase == "active" || lastPhase == "inactive" {
            if runningShell { return Verdict(type: "⚠️ FOREGROUND CRASH during shell execution", writesReport: true) }
            if let mem = memoryMB, mem >= 350 {
                return Verdict(type: "⚠️ FOREGROUND CRASH (high memory: \(mem)MB)", writesReport: true)
            }
            return Verdict(type: "⚠️ FOREGROUND CRASH (SIGKILL — app was in use)", writesReport: true)
        }
        if lastPhase == "background" {
            if let rem = bgTaskRemaining, rem > 0 && rem < 5 {
                return Verdict(type: "Background Task Timeout (task expired with \(String(format: "%.1f", rem))s left)", writesReport: true)
            }
            if let mem = memoryMB, mem >= 300 {
                return Verdict(type: "Background Jetsam (high memory: \(mem)MB)", writesReport: true)
            }
            if let free = memoryFreeMB, free < 500 {
                return Verdict(type: "Background Jetsam (system memory pressure)", writesReport: true)
            }
            return Verdict(type: "Background Termination (system reclaimed memory — normal)", writesReport: false)
        }
        return Verdict(type: "Unknown Termination", writesReport: true)
    }
}
