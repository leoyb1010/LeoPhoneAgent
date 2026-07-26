import SwiftUI

struct LeoRelease: Identifiable, Equatable {
    let version: String
    let date: String
    let title: String
    let highlights: [String]

    var id: String { version }
}

enum LeoReleaseCatalog {
    static let releases: [LeoRelease] = [
        LeoRelease(
            version: "1.1.0",
            date: "2026-07-26",
            title: "任务成果、个人模板与后台体验全面升级",
            highlights: [
                "任务生成的文档、图片、音视频、代码等成果会进入会话 Artifacts，可预览、分享、查看版本历史和恢复删除项。",
                "Artifacts 可选择通过私有 CloudKit 同步；文件会校验大小与 SHA-256，默认关闭且支持单文件上限。",
                "个人任务模板支持输入槽位、结构化输出、导入导出，并可固定最多三个到首页与聊天输入区。",
                "新增标准与 Background Ready 运行策略，结合 Live Activity、通知及 iOS 26 Continued Processing 提升锁屏续跑体验。",
                "首页密度、关键动效、触感和 VoiceOver 统一优化，完整遵循系统 Reduce Motion 与触感开关。",
                "升级前已使用本机 1.0.12 数据完成真实迁移演练，并复核 LeoPhoneAgent 自有签名、包名、扩展与权限说明。"
            ]
        ),
        LeoRelease(
            version: "1.0.12",
            date: "2026-07-26",
            title: "快捷任务现在可以自己定制",
            highlights: [
                "Siri 与快捷指令现在从可扩展任务库读取快捷任务，不再局限于固定选项。",
                "设置中可创建、编辑、排序和删除自定义快捷任务，也能调整内置任务的名称、提示词和图标。",
                "八个内置任务继续使用稳定标识，旧版本已经保存的快捷指令仍可正常运行。",
                "修改任务后会刷新系统快捷指令参数，新选项可直接用于后续自动化。"
            ]
        ),
        LeoRelease(
            version: "1.0.11",
            date: "2026-07-26",
            title: "任务生命周期副作用完成分层",
            highlights: [
                "任务状态属性现在只负责识别开始、停止和无变化，不再直接承载整段生命周期逻辑。",
                "任务开始的云同步延迟、停止后保留窗口和卡顿监控归入专用开始处理器。",
                "任务结束的安全快照、离屏会话通知和技能刷新归入专用停止处理器。",
                "所有历史前台守卫和副作用执行顺序保持不变。"
            ]
        ),
        LeoRelease(
            version: "1.0.10",
            date: "2026-07-26",
            title: "任务开始与停止转移更明确",
            highlights: [
                "将运行布尔值的变化明确区分为开始、停止和无变化三种转移。",
                "重复赋值不会误触发同步、卡顿监控或界面快照等顺序敏感副作用。",
                "保持现有任务启动与结束副作用的执行顺序不变，为后续逐项拆分状态机建立安全边界。",
                "新增四种布尔边沿的纯逻辑契约测试。"
            ]
        ),
        LeoRelease(
            version: "1.0.9",
            date: "2026-07-26",
            title: "任务中断状态可以跨重启恢复",
            highlights: [
                "每个 Agent Run 的当前阶段会写入仅本机的持久化状态，不包含提示词、回复或工具参数。",
                "App 被系统终止在流式文本阶段后，重新打开也能识别为可恢复任务，不再依赖消息尾部猜测。",
                "恢复状态会同步到会话暂停标记与聊天继续入口，但不会在后台或重启后擅自自动执行。",
                "开始新任务会安全终结同会话遗留的旧 Run，避免过期暂停状态再次出现。"
            ]
        ),
        LeoRelease(
            version: "1.0.8",
            date: "2026-07-26",
            title: "界面组件首轮安全拆分",
            highlights: [
                "设置页的外观选项、语言选项和字号滑杆已从超大首页文件拆分为独立组件。",
                "首页同步状态动画与同步提示条已归位到独立状态组件文件。",
                "本轮保持原有界面、交互、文案和动效不变，为后续状态机与任务控制台升级降低风险。",
                "完成主 App 真机构建和独立逻辑测试 Bundle 编译验证。"
            ]
        ),
        LeoRelease(
            version: "1.0.7",
            date: "2026-07-26",
            title: "原生能力中心与保存前真实测试",
            highlights: [
                "新增 Apple Capabilities，统一查看原生能力、系统授权状态、可执行动作和数据去向。",
                "能力状态检查不会主动申请权限；HomeKit、HealthKit 和后台执行边界会如实说明。",
                "新增 Provider 会先完成真实连接测试再保存，测试失败时仍可明确选择继续保存。",
                "自动日志不再写入提示词、回复正文、工具参数、Token 片段、通知标题和浏览网址。"
            ]
        ),
        LeoRelease(
            version: "1.0.6",
            date: "2026-07-26",
            title: "桌面任务入口与锁屏持续执行",
            highlights: [
                "新增小号和中号主屏幕任务组件，可查看执行、暂停、完成和故障状态。",
                "中号组件可一键打开语音输入，录音权限和状态仍由前台 App 清晰管理。",
                "iOS 26 长任务接入系统 Continued Processing，锁屏后继续执行并报告真实进度。",
                "系统终止后进入可恢复的暂停流程；后台日志不再写入错误原文、输出预览和浏览网址。",
                "调试协议、挂起检测线程和存储空状态继续统一为 LeoPhoneAgent 品牌。"
            ]
        ),
        LeoRelease(
            version: "1.0.5",
            date: "2026-07-26",
            title: "长转码也能及时停止",
            highlights: [
                "停止任务会通知正在运行的 FFmpeg 转码通过正常清理流程退出。",
                "等待其他转码任务时也可以取消，不再卡在不可中断的执行锁上。",
                "媒体路径和完整 FFmpeg 参数不再写入系统日志。",
                "更新自建 FFmpeg 框架并保留 VideoToolbox 硬件编解码能力。"
            ]
        ),
        LeoRelease(
            version: "1.0.4",
            date: "2026-07-26",
            title: "停止操作深入本地执行层",
            highlights: [
                "停止当前任务会把取消信号传入本地 Linux 原生代理层。",
                "原生能力等待期间会定期检查取消状态，避免停止后继续长时间占用。",
                "取消后的原生结果不会继续注册为可用文件，并返回明确的取消状态。",
                "保持认证、限流、本地环境等失败恢复入口与隐私安全诊断。"
            ]
        ),
        LeoRelease(
            version: "1.0.3",
            date: "2026-07-26",
            title: "失败可恢复，原因更安全",
            highlights: [
                "聊天错误与活动时间线使用同一套安全原因和恢复动作。",
                "认证、限流、网络和本地环境故障现在会给出对应处理入口。",
                "本地 Linux 环境启动失败时可直接重试，不再停留在无出口的错误页。",
                "诊断日志不再写入模型错误正文、工具错误片段或服务商响应细节。"
            ]
        ),
        LeoRelease(
            version: "1.0.2",
            date: "2026-07-26",
            title: "停止更可靠，日志更私密",
            highlights: [
                "浏览器加载、脚本、截图和内容提取现在都能被立即停止。",
                "有排队消息时，可明确选择继续队列或停止全部并清空队列。",
                "排队提示词、回复摘要和工具内容不再写入可导出的诊断日志。",
                "取消后的工具结果保持完整配对，降低恢复时的请求失败风险。"
            ]
        ),
        LeoRelease(
            version: "1.0.1",
            date: "2026-07-26",
            title: "更清晰、更安心的个人智能体",
            highlights: [
                "聊天页新增实时状态卡与本机会话活动时间线，执行过程更透明。",
                "权限请求会说明访问内容与数据去向，并显示等待、接管和中断原因。",
                "统一界面节奏、动效与触觉反馈，同时支持“减少动态效果”。",
                "完成 LeoPhoneAgent 独立签名、隐私、快捷指令和服务商配置加固。"
            ]
        ),
        LeoRelease(
            version: "1.0",
            date: "2026-07-26",
            title: "LeoPhoneAgent 初始版本",
            highlights: [
                "建立以 iPhone 为主的个人智能体基础体验。",
                "支持对话、工具调用、本地工作区与多个 AI 服务商。",
                "采用独立应用标识、签名配置和 LeoPhoneAgent 品牌。"
            ]
        )
    ]

    static var currentVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
    }

    static var currentRelease: LeoRelease? {
        releases.first { $0.version == currentVersion }
    }
}

struct LeoReleaseNotesView: View {
    enum Mode {
        case latest
        case history
    }

    let mode: Mode
    var onDone: (() -> Void)?

    private var visibleReleases: [LeoRelease] {
        switch mode {
        case .latest:
            return LeoReleaseCatalog.currentRelease.map { [$0] } ?? []
        case .history:
            return LeoReleaseCatalog.releases
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if mode == .latest {
                    Section {
                        VStack(spacing: LeoTheme.Spacing.md) {
                            Image(systemName: "sparkles")
                                .font(.system(size: 34, weight: .semibold))
                                .foregroundStyle(.tint)
                                .accessibilityHidden(true)
                            Text("LeoPhoneAgent 已更新")
                                .font(.title2.bold())
                            Text("版本 \(LeoReleaseCatalog.currentVersion)")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, LeoTheme.Spacing.md)
                        .listRowBackground(Color.clear)
                    }
                }

                ForEach(visibleReleases) { release in
                    Section {
                        ForEach(release.highlights, id: \.self) { highlight in
                            Label {
                                Text(highlight)
                                    .fixedSize(horizontal: false, vertical: true)
                            } icon: {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(.tint)
                            }
                            .accessibilityElement(children: .combine)
                        }
                    } header: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("版本 \(release.version) · \(release.date)")
                            Text(release.title)
                                .textCase(nil)
                        }
                    }
                }
            }
            .navigationTitle(mode == .latest ? "本次更新" : "更新记录")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let onDone {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("完成", action: onDone)
                    }
                }
            }
        }
    }
}
