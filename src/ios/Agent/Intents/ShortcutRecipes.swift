//
//  ShortcutRecipes.swift
//  MinisApp
//
//  [C10] 「快捷指令配方」的元数据。每个配方:用途一句话、需要的触发器、
//  一键添加的 iCloud 快捷指令链接(由你在快捷指令 App 里做好并分享后填入,
//  还没填时界面显示「链接待添加」)、三步「如何建自动化」。
//

import Foundation

struct ShortcutRecipe: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let symbolName: String
    /// 用途一句话。
    let purpose: String
    /// 需要的触发器(个人自动化的「何时」)。
    let trigger: String
    /// 用到的 LeoPhoneAgent 动作。
    let action: String
    /// 分享出来的 https://www.icloud.com/shortcuts/… 链接;空字符串 = 还没有。
    let iCloudLink: String
    /// 三步建自动化。
    let steps: [String]

    var shareURL: URL? {
        guard !iCloudLink.isEmpty, let url = URL(string: iCloudLink), url.scheme == "https" else { return nil }
        return url
    }
}

enum ShortcutRecipes {
    static let all: [ShortcutRecipe] = [
        ShortcutRecipe(
            id: "arrive-home-note", title: "到家记下此刻", symbolName: "house.fill",
            purpose: "到家时自动记一条「到家了」，之后问 Agent「我几点到的家」能答上来。",
            trigger: "到达（家）", action: "记住这个", iCloudLink: "",
            steps: [
                "打开快捷指令 App › 自动化 › 新建 › 到达，位置选「家」，选「立即运行」。",
                "添加动作：搜索 LeoPhoneAgent › 「记住这个」，内容填「到家了」。",
                "点完成。锁屏也能跑，不会弹出 App。",
            ]),
        ShortcutRecipe(
            id: "car-mac-report", title: "上车 Mac 汇报", symbolName: "car.fill",
            purpose: "连上车载蓝牙或 CarPlay 时，Siri 把各台 Mac 上任务的进展念给你听。",
            trigger: "CarPlay 已连接 / 蓝牙已连接（车）", action: "Mac 任务汇报", iCloudLink: "",
            steps: [
                "自动化 › 新建 › CarPlay（或蓝牙，选你的车），选「已连接」「立即运行」。",
                "添加动作：LeoPhoneAgent › 「Mac 任务汇报」。",
                "点完成。需要先在 App 里连上 Mac 中继。",
            ]),
        ShortcutRecipe(
            id: "screenshot-to-agent", title: "截图交给 Agent", symbolName: "camera.viewfinder",
            purpose: "截完图按一下操作按钮或背部轻点，把最新截图发给 Agent 解读。",
            trigger: "操作按钮 / 辅助功能 › 触控 › 轻点背面", action: "发送提示（附件）", iCloudLink: "",
            steps: [
                "快捷指令 › 新建快捷指令：添加「获取最新的截屏」。",
                "添加 LeoPhoneAgent › 「发送提示」，提示写「解读这张截图」，附件接上一步，打开「等待结果」。",
                "设置 › 操作按钮（或轻点背面）选这条快捷指令。",
            ]),
        ShortcutRecipe(
            id: "car-bluetooth-note", title: "连上车载蓝牙记笔记", symbolName: "note.text.badge.plus",
            purpose: "上车后对着 Siri 口述一段想法，自动整理成笔记存进藏宝阁。",
            trigger: "蓝牙已连接（车）", action: "记一条笔记", iCloudLink: "",
            steps: [
                "自动化 › 新建 › 蓝牙，选你的车，选「已连接」「立即运行」。",
                "添加「听写文本」，再添加 LeoPhoneAgent › 「记一条笔记」，内容接上一步。",
                "点完成。锁屏状态下也会执行。",
            ]),
        ShortcutRecipe(
            id: "morning-briefing", title: "晨间定时晨报", symbolName: "sun.max.fill",
            purpose: "每天早上准时跑一遍到点的定时任务（比如「晨报」），跑完收到通知。",
            trigger: "特定时间（每天 08:00）", action: "运行到点的定时任务", iCloudLink: "",
            steps: [
                "先在 App › 设置 › 定时任务 里加一个每天 08:00 的「晨报」。",
                "自动化 › 新建 › 特定时间，08:00 每天，选「立即运行」。",
                "添加 LeoPhoneAgent › 「运行到点的定时任务」，点完成。",
            ]),
    ]
}
