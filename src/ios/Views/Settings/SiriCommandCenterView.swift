//
//  SiriCommandCenterView.swift
//  MinisApp
//
//  [T-siri-fleet] Siri 指挥中心:一页看全所有语音指令,附 Action Button
//  绑定与自动化模板的手把手步骤(这两样 iOS 不允许 app 代设,只能引导)。
//

import SwiftUI

struct SiriCommandCenterView: View {
    private struct Phrase: Identifiable {
        let say: String
        let does: String
        var id: String { say }
    }

    /// [F-mac-fleet-advanced] Mac 舰队默认关闭;打开后才显示 Mac 相关的说明。
    @AppStorage(MacFleetFeature.defaultsKey) private var macFleetEnabled = false

    // 别名 LB 已注册(INAlternativeAppNames):短语里的 app 名说「LB」
    // 即可,全名 LeoPhoneAgent 同样有效。
    private let paperclipPhrases: [Phrase] = [
        Phrase(say: "LB查工单进度", does: "选一个 Paperclip 工单,念出状态和智能体最近一条回复"),
        Phrase(say: "LB读工单结果", does: "读取工单结果全文,可交给快捷指令的下一个动作"),
    ]

    /// Mac 动作不再占 Siri 短语名额(上限 10),在快捷指令 App 的动作列表里。
    private let fleetActions: [Phrase] = [
        Phrase(say: "指挥一台 Mac", does: "选一台 Mac + CLI,一句话开工(不打开 app)"),
        Phrase(say: "Mac 任务汇报", does: "念出各台 Mac 进行中任务与待审批"),
        Phrase(say: "批准 Mac 待审批", does: "念出最近一条待审批,确认后批准(需解锁,高风险不经 Siri)"),
        Phrase(say: "停止 Mac 任务", does: "停掉指定 Mac 上正在跑的任务(多个时先问)"),
    ]

    private let chatPhrases: [Phrase] = [
        Phrase(say: "问LB", does: "打开 app 进入对话"),
        Phrase(say: "让LB干活", does: "在\(LeoDeviceNouns.thisDevice())上后台跑,不上 Mac"),
        Phrase(say: "给LB发送提示", does: "后台跑一个任务,Siri 念结果"),
        Phrase(say: "运行LB快捷任务", does: "执行你配置的快捷任务"),
        Phrase(say: "查看LB任务", does: "播报会话状态"),
        Phrase(say: "LB收藏", does: "把一段文字/链接存进收藏(可接剪贴板)"),
    ]

    var body: some View {
        List {
            Section {
                Label {
                    Text("以下每一句都可以直接对 Siri 说。前面加「嘿 Siri」,或长按侧键 / 顶部按钮唤起后直接说。\n\n默认都在\(LeoDeviceNouns.thisDevice())上做。")
                        .font(.footnote).foregroundStyle(.secondary)
                } icon: {
                    Image(systemName: "mic.badge.plus").foregroundStyle(.purple)
                }
            }

            Section("对话与任务") {
                ForEach(chatPhrases) { phraseRow($0) }
            }

            Section("服务器任务(Paperclip)") {
                ForEach(paperclipPhrases) { phraseRow($0) }
            }

            if macFleetEnabled {
                Section {
                    ForEach(fleetActions) { actionRow($0) }
                } header: {
                    Text("指挥 Mac(不打开 app)")
                } footer: {
                    Text("这几项在快捷指令 App 里:新建快捷指令,搜 LeoBot 加入动作,给快捷指令起个名字,之后对 Siri 说这个名字即可。")
                }
            }

            Section("审批不用打开 App") {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Mac 任务需要审批时,本机会收到时效性通知:")
                    Text("• 锁屏或横幅上直接按「允许一次」或「拒绝」;允许要先解锁 iPhone,拒绝不用")
                    Text("• 戴 AirPods 时开启「Siri 播报通知」,Siri 会念出来;回「批准」同样要求 iPhone 已解锁")
                    Text("• 手表上也有同款审批卡，不提供「始终允许」；高风险命令要点两下确认")
                }
                .font(.footnote).foregroundStyle(.secondary)
            }

            Section("一键收藏剪贴板(小红书神器)") {
                VStack(alignment: .leading, spacing: 6) {
                    Text("小红书这类 app 只给「复制链接」,没有系统分享。配一条快捷指令后,复制完按一下侧键或顶部按钮就存进收藏:")
                    Text("1. 快捷指令 App → 新建快捷指令")
                    Text("2. 加动作「获取剪贴板」")
                    Text("3. 加动作「收藏到 LB」(搜 LeoBot)")
                    Text("4. 命名为「收藏」,再到 系统设置 → 操作按钮 → 快捷指令 里选它")
                    Text("也可以直接在收藏页用剪贴板条 / 右上角「粘贴链接收藏」。")
                        .foregroundStyle(.tertiary)
                }
                .font(.footnote).foregroundStyle(.secondary)
            }

            Section("把「问 Leo」绑到操作按钮(本机有的话)") {
                VStack(alignment: .leading, spacing: 6) {
                    Text("1. 系统设置 → 操作按钮(部分机型才有)")
                    Text("2. 滑到「快捷指令」,选「Ask LeoBot」")
                    Text("3. 之后实体键一按即语音下任务——比嘿 Siri 更快。没有操作按钮时用嘿 Siri 或快捷指令即可。")
                }
                .font(.footnote).foregroundStyle(.secondary)
            }

            Section("推荐自动化(快捷指令 App 里各建一条)") {
                VStack(alignment: .leading, spacing: 6) {
                    Text("iOS 不允许 app 代建自动化,照着建只要 1 分钟:")
                    Text("跑任务、审批这类动作现在要先解锁 iPhone：锁屏时触发的自动化（定时、到达、NFC 等）跑不了它们。定时任务请用「运行到点的定时任务」，锁屏也能跑。")
                        .foregroundStyle(.orange)
                    if macFleetEnabled {
                        Text("• 「充电时 + 23:00」→ 指挥一台 Mac:跑夜间批处理")
                        Text("• 「到达家」→ Mac 任务汇报")
                        Text("• 「离开公司」→ Mac 任务汇报")
                    }
                    Text("• 「到达家」→ 查 Paperclip 工单进度")
                    Text("快捷指令 App → 自动化 → 新建,动作里搜 LeoBot。")
                }
                .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Siri 指挥中心")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func actionRow(_ p: Phrase) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(verbatim: "「" + p.say + "」")
                .font(.system(size: 15, weight: .medium))
            Text(p.does)
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }

    private func phraseRow(_ p: Phrase) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("「嘿 Siri,\(p.say)」")
                .font(.system(size: 15, weight: .medium))
            Text(p.does)
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}
