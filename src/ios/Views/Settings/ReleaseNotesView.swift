//
//  ReleaseNotesView.swift
//  MinisApp
//
//  [T-release-notes] 更新提示与更新记录(个人版:changelog 随包内置)。
//
//  这台手机的 app 是侧载的,没有 App Store 的"更新说明"面——所以由 app
//  自己承担:每次装了新版本,首次启动对比上次记录的版本号,变了就弹一张
//  "本次更新"卡;完整历史在 设置 → 更新记录 里随时可翻。
//  与 Mac 端的机制同构(那边是 release-notes JSON 随包 + 启动比对)。
//

import SwiftUI

// MARK: - 数据(发版时在最前面加一条)

struct LeoReleaseNote: Identifiable {
    let version: String
    let date: String
    let items: [String]
    var id: String { version }
}

enum LeoReleaseNotes {
    static let all: [LeoReleaseNote] = [
        LeoReleaseNote(
            version: "1.10.0",
            date: "2026-08-08",
            items: [
                "⭐️ 全局收藏上线:任意 app 分享 → LeoPhoneAgent,可选「发到对话」或「收藏」;设为「总是收藏」后分享即存,不打断刷内容(三星全局收藏式体验)",
                "🗂 收藏页(主界面星标图标 / 设置 → 数据 → 收藏):链接自动抓标题封面、来源徽标(小红书/微博/B站…自动识别)、搜索、按来源过滤、置顶",
                "🤖 收藏 × Agent:左滑「发给 Agent」带进新对话;「总结」一滑让 Agent 提炼要点",
                "🧹 深度瘦身:清除 94 个复制残留文件与三条废弃产品线(旧菜单栏 app、Android、LAME),修复单测编译损坏,删 13 个死视图,App 图标压缩,主视图拆分 600 行",
            ]),
        LeoReleaseNote(
            version: "1.9.2",
            date: "2026-08-08",
            items: [
                "🗣 Siri 短语大幅缩短:app 注册系统级别名「LPA」——「问LPA」「LPA汇报」「LPA批准」「让LPA干活」「LPA停止任务」,两三个字唤起",
                "🎛 Siri 指挥中心同步更新为短语速查表",
            ]),
        LeoReleaseNote(
            version: "1.9.1",
            date: "2026-08-08",
            items: [
                "🗣 Siri 指挥 Mac:「嘿 Siri,用LeoPhoneAgent指挥Mac」一句话让任意一台 Mac 的 Claude Code/Codex/Grok 开工,不打开 app",
                "📢 「LeoPhoneAgent汇报」:Siri 念出三台 Mac 进行中任务与待审批;「LeoPhoneAgent批准」一句话批掉最近的待审批",
                "🔔 审批通知带按钮:app 在后台时,Mac 审批直达锁屏——「批准一次」(Face ID 把关)或「拒绝」,不用开 app;AirPods 可让 Siri 播报",
                "🏝 Mac 任务上灵动岛:后台跟随的 Mac 会话显示实时状态,等审批时置顶提醒",
                "🎛 新增「设置 → Siri 指挥中心」:全部语音指令一页看全,附 Action Button 绑定与自动化模板步骤",
                "🛠 修复:多处通知类别互相覆盖导致按钮丢失的老问题",
            ]),
        LeoReleaseNote(
            version: "1.9.0",
            date: "2026-08-06",
            items: [
                "📇 通讯录 apple-contacts:查找/详情/分组;增改删一律先确认再执行——「给张伟打电话」终于不用自己报号码",
                "📁 文件 apple-files:Agent 可主动请你授权文件夹(系统选择器),挂进 /var/minis/mounts/ 供 shell 读写;失效授权可重新激活",
                "📷 相机 apple-camera:拍照/扫码/扫文档三合一,全部由你亲手操作系统相机 UI,产物直通 apple-vision OCR",
                "⚡️ 快捷指令 apple-shortcuts:按名字运行你的任意快捷指令(x-callback 自动跳回),打开备忘录、系统设置、第三方 App 动作的整个间接能力面",
                "🚶 运动 apple-motion:实时步数/活动识别(走路/跑步/驾车),比 HealthKit 更即时",
                "🔐 五个新能力全部进权限中心:可单独设为「每次询问」或「禁用」,授权状态一目了然",
                "🎙 语音识别修复:根治「随机识别成粤语/输出繁体」——语言解析改为确定性规则(简体中文系统固定普通话 zh-CN),历史误选自动纠正;手动选过语言的不受影响",
                "🧭 与上游 Minis 1.11(7-31 发布)逐项对齐核实:Siri「问问LeoPhoneAgent」、选中朗读、Kimi 登录、Codex Fast Mode、语音纠错上下文、Opus 5 内置、128K 输出——全部已在本产品中,无缺口",
            ]),
        LeoReleaseNote(
            version: "1.8.4",
            date: "2026-08-06",
            items: [
                "🖥 Mac 端合并进 leocodebox:编码会话由 leocodebox 1.63+ 直接承载,协议、地址、密钥全部不变,手机无感切换;「测试连接」会显示这台 Mac 由谁承载",
                "🛰 手机会话自动享受 leocodebox 的 Leoapi 节点切换与故障转移(claude/codex)",
                "🗄 桌面端 LeoAgentDesktop 停止开发,已从仓库移除;leoagent 服务保留为灰度回退",
            ]),
        LeoReleaseNote(
            version: "1.8.3",
            date: "2026-08-06",
            items: [
                "🐛 修复退到桌面误报「任务失败」:iOS 26 后台授权到期被错当成任务失败,实际任务一直在跑。现在保活生效时不再动任务、不再弹失败横幅,只有任务真被挂起才如实提示",
            ]),
        LeoReleaseNote(
            version: "1.8.2",
            date: "2026-08-06",
            items: [
                "📤 发送死点修复:Mac 对话在连接建立期间发送会排队,连上即发,点击永远有响应;连接中/出错状态实时可见",
                "🧠 Grok 模型接入重做:「从 Mac 借用 Grok 登录」上线(供应商详情页)——手机不再自己跑 OAuth,向 Mac 借自动续期的登录,一次点击永久生效",
                "🔑 凭证优先级修正:自动续期的登录优先于手动粘贴的临时 token(后者数小时过期,是之前 401 的根源)",
            ]),
        LeoReleaseNote(
            version: "1.8.1",
            date: "2026-08-06",
            items: [
                "💬 对话框直达 Mac:输入框上方 Quick Tasks 旁新增「指挥 Mac」,选 Mac 选 CLI 直接开聊,不用进设置",
                "🤖 Grok 修复:三台 Mac 的 Grok 全部可用(改走无头 ACP 协议,不再闪退)",
                "🔑 密钥被拒根治:复制密钥时带上的行尾符号(如 %)自动清洗,三端(中继/Mac/手机)同时容错",
                "📡 进行中的会话:进入任意 Mac 先看到正在跑的任务,一键接管",
            ]),
        LeoReleaseNote(
            version: "1.8.0",
            date: "2026-08-06",
            items: [
                "🌐 三台 Mac 随时随地遥控:自营中继上线,蜂窝/任意 WiFi 直连,不依赖 VPN、不走 SSH",
                "🖥 「一键添加我的三台 Mac」:地址内置,只粘贴一次密钥",
                "🔍 设置页全面重组:5 组折叠 + 搜索框,25 个设置项两秒定位",
                "⌨️ Mac 控制台提为一级入口(主界面标题栏电脑图标)",
                "🛠 添加 Mac 表单修复:输入不再被后台刷新吞掉;全面中文化",
                "📱 本页(更新提示与更新记录)上线",
            ]),
        LeoReleaseNote(
            version: "1.7.0",
            date: "2026-08-05",
            items: [
                "手机 ↔ Mac 编码会话:创建/流式转录/审批/转向/停止",
                "断线续传协议(?after=N 回放),弱网不丢事件",
                "手表审批:抢占式审批卡,按独立审批 ID 应答",
            ]),
    ]

    static var current: LeoReleaseNote? { all.first }

    /// 当前版本标识(版本号+构建号,任一变化都算"更新过")。
    static var versionStamp: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        return "\(v) (\(b))"
    }

    private static let lastSeenKey = "leo.releaseNotes.lastSeenVersion"

    /// 版本变了返回 true(调用方据此弹卡),并不立即记账——看完才记。
    static func shouldShowWhatsNew() -> Bool {
        UserDefaults.standard.string(forKey: lastSeenKey) != versionStamp
    }

    static func markSeen() {
        UserDefaults.standard.set(versionStamp, forKey: lastSeenKey)
    }
}

// MARK: - 首启弹卡

struct WhatsNewSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if let note = LeoReleaseNotes.current {
                    Section {
                        ForEach(note.items, id: \.self) { line in
                            Text(line).font(.system(size: 15))
                        }
                    } header: {
                        Text("v\(note.version) · \(note.date)")
                    }
                }
                Section {
                    NavigationLink("查看全部更新记录") {
                        ReleaseNotesView()
                    }
                }
            }
            .navigationTitle("本次更新")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("知道了") {
                        LeoReleaseNotes.markSeen()
                        dismiss()
                    }
                }
            }
        }
        .onDisappear { LeoReleaseNotes.markSeen() }
    }
}

// MARK: - 更新记录页(设置入口)

struct ReleaseNotesView: View {
    var body: some View {
        List {
            ForEach(LeoReleaseNotes.all) { note in
                Section {
                    ForEach(note.items, id: \.self) { line in
                        Text(line).font(.system(size: 15))
                    }
                } header: {
                    Text("v\(note.version) · \(note.date)")
                }
            }
        }
        .navigationTitle("更新记录")
        .navigationBarTitleDisplayMode(.inline)
    }
}
