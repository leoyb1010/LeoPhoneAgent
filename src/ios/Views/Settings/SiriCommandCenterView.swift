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

    // 别名 LPA 已注册(INAlternativeAppNames):短语里的 app 名说「LPA」
    // 即可,全名 LeoPhoneAgent 同样有效。
    private let fleetPhrases: [Phrase] = [
        Phrase(say: "让LPA干活", does: "选一台 Mac + CLI,一句话开工(不打开 app)"),
        Phrase(say: "LPA汇报", does: "念出三台 Mac 进行中任务与待审批"),
        Phrase(say: "LPA批准", does: "批准最近一条等待审批的操作"),
        Phrase(say: "LPA停止任务", does: "停掉指定 Mac 上最近的任务"),
    ]

    private let chatPhrases: [Phrase] = [
        Phrase(say: "问LPA", does: "打开 app 进入对话"),
        Phrase(say: "给LPA发送提示", does: "后台跑一个任务,Siri 念结果"),
        Phrase(say: "运行LPA快捷任务", does: "执行你配置的快捷任务"),
        Phrase(say: "查看LPA任务", does: "播报会话状态"),
        Phrase(say: "LPA收藏", does: "把一段文字/链接存进收藏(可接剪贴板)"),
    ]

    var body: some View {
        List {
            Section {
                Label {
                    Text("以下每一句都可以直接对 Siri 说。前面加「嘿 Siri」,或长按侧键唤起后直接说。")
                        .font(.footnote).foregroundStyle(.secondary)
                } icon: {
                    Image(systemName: "mic.badge.plus").foregroundStyle(.purple)
                }
            }

            Section("指挥 Mac(不打开 app)") {
                ForEach(fleetPhrases) { phraseRow($0) }
            }

            Section("对话与任务") {
                ForEach(chatPhrases) { phraseRow($0) }
            }

            Section("审批不掏手机") {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Mac 任务需要审批时,手机会收到时效性通知:")
                    Text("• 锁屏/横幅上直接按「批准一次」(需 Face ID)或「拒绝」")
                    Text("• 戴 AirPods 时开启「Siri 播报通知」,Siri 会念出来,回一句「批准」即可")
                    Text("• 手表上也有同款审批卡")
                }
                .font(.footnote).foregroundStyle(.secondary)
            }

            Section("一键收藏剪贴板(小红书神器)") {
                VStack(alignment: .leading, spacing: 6) {
                    Text("小红书这类 app 只给「复制链接」,没有系统分享。配一条快捷指令后,复制完按一下侧键就存进收藏:")
                    Text("1. 快捷指令 App → 新建快捷指令")
                    Text("2. 加动作「获取剪贴板」")
                    Text("3. 加动作「收藏到 LPA」(搜 LeoPhoneAgent)")
                    Text("4. 命名为「收藏」,再到 系统设置 → 操作按钮 → 快捷指令 里选它")
                    Text("也可以直接在收藏页用剪贴板条 / 右上角「粘贴链接收藏」。")
                        .foregroundStyle(.tertiary)
                }
                .font(.footnote).foregroundStyle(.secondary)
            }

            Section("把「问 Leo」绑到侧边 Action Button") {
                VStack(alignment: .leading, spacing: 6) {
                    Text("1. 系统设置 → 操作按钮")
                    Text("2. 滑到「快捷指令」,选「Ask LeoPhoneAgent」")
                    Text("3. 之后实体键一按即语音下任务——比嘿 Siri 更快")
                }
                .font(.footnote).foregroundStyle(.secondary)
            }

            Section("推荐自动化(快捷指令 App 里各建一条)") {
                VStack(alignment: .leading, spacing: 6) {
                    Text("iOS 不允许 app 代建自动化,照着建只要 1 分钟:")
                    Text("• 「充电时 + 23:00」→ 指挥一台 Mac:跑夜间批处理")
                    Text("• 「到达家」→ Mac 任务汇报")
                    Text("• 「离开公司」→ Mac 任务汇报")
                    Text("快捷指令 App → 自动化 → 新建,动作里搜 LeoPhoneAgent。")
                }
                .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Siri 指挥中心")
        .navigationBarTitleDisplayMode(.inline)
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
