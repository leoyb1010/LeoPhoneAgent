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
