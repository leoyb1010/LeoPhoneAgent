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
            version: "1.25.0",
            date: "2026-08-26",
            title: "相册、闹钟、日历不再先截图",
            highlights: [
                "「把这张图存进相册」「定个明早 8 点闹钟」「加到日历」说清楚时直接走系统接口，聊天里会写走了哪条路，不再先截图乱点。",
                "对话顶部会显示「系统相册 / 系统闹钟 / 系统日历」。没附图或没说清时刻的请求仍走原来的 Agent。",
                "iOS 26 以下没有系统 AlarmKit，设闹钟会退回原来的对话。"
            ]
        ),
        LeoRelease(
            version: "1.24.2",
            date: "2026-08-26",
            title: "长文件连续读，录音时先停朗读",
            highlights: [
                "长文件 file_read 读完一页会给出 next_offset，下一页从真实行号继续，不用再猜。",
                "点麦克风开始录音时先停当前朗读，识别不再被自己的 TTS 打断。",
                "JSON 传来的 offset / lines / max_length 按数字读取，分页参数不再被丢掉。"
            ]
        ),
        LeoRelease(
            version: "1.24.1",
            date: "2026-08-19",
            title: "远程控制和身体配对更严",
            highlights: [
                "远程 shell 和远程 Agent 必须在本机确认，并且按主机 + 这条命令/任务绑定；不再信模型自己写的 confirmed。",
                "扫码加身体时，钥匙只跟配对码里的同一条中继根走，不会发到别的地址。",
                "刷新舰队会把每把已存钥匙对到各自的中继根，不再只用第一台主机的钥匙。",
                "当前模型不能读图时直接拦住并保留附件，不再假装已经看过；提示里直接给出「设置 → 供应商 → 该模型 → Image input」的入口，能力表漏标的模型一键打开即可。",
                "锁屏 / 切走后任务不再因为一条终端命令或写文件被拒而中断：本机执行改成沿用本会话授权，没授权时发通知等你确认。读写 Cookie、远程执行仍然要回前台。",
                "「本会话允许」对本机终端只用点一次，不再每条命令都问；远程命令仍按主机 + 完整命令逐条确认，改一个字都要重新批准。",
                "会话筛选切到「归档」而没有归档会话时，筛选条不再消失——之前只能杀进程才能切回「全部」。",
                "设置里的「压缩 / 标题」便宜模型现在真的作用于压缩，不再只管标题；供应商被停用或没凭据时自动回退。",
                "「到阈值自动压缩」开关对已经打开的对话立即生效，不用重开 app。",
                "导入 JSON 会话不再卡界面，重复导入同一份文件会自动跳过。"
            ]
        ),
        LeoRelease(
            version: "1.24.0",
            date: "2026-08-19",
            title: "Android 也能当身体，舰队和推理补完",
            highlights: [
                "已装本 App 的 Android 会作为身体注册到中继；iPhone / iPad 远程机器列表读 /machines，不再只靠写死的三台 Mac。",
                "扫码加身体：码里只有中继根和机器名，钥匙不进码。杀 App 后审批走已有 APNs 登记，主机出现时会重登记 token。",
                "推理强度可在设置里按模型家族改最高档；换模型会夹到对方能用的档并看得见，切回来恢复原来的档。Android 身体会接收远程任务的当前档；Mac CLI 暂用各自默认档。",
                "压缩/标题便宜模型、压缩开关、写文件/终端默认询问、会话归档与分组、JSON 导入，以及「新任务 / 本机 / 远程 / 进行中 / 审批」用词对齐。非视觉模型不再假报已读图。"
            ]
        ),
        LeoRelease(
            version: "1.23.1",
            date: "2026-08-12",
            title: "交付门禁与更新体验收口",
            highlights: [
                "更新记录收敛为一套全局机制：移除重复的旧版更新页和二次首启弹窗，设置、关于与首次启动现在共享同一份版本数据。",
                "修正发布审计指向错误文件的问题；版本、构建号、当前更新说明和首次启动提示现在由门禁一致核对。",
                "iPad 的本机工作区名称、图标、任务目标与离线说明现在会正确使用 iPad 语义，不再沿用 iPhone 文案。",
                "同步交付 Mac 1.67.1：修复首页设置与刷新按钮无效，并完成首页关键入口的安装后真实点击复验。"
            ]
        ),
        LeoRelease(
            version: "1.23.0",
            date: "2026-08-11",
            title: "任务入口、设置与藏宝阁全面升级",
            highlights: [
                "首页成为真正的任务起点：快捷输入改为「开始」，点下即创建会话并发送；语音、相机、文件、自动化、网页研究与终端按两行三列清晰呈现。",
                "今日会话突出展示；昨天、本周、本月与更早历史默认折叠。设置中心改为可搜索的五组能力控制台，统一按钮、折叠、触感与减少动态效果适配。",
                "藏宝阁升级为可调用记忆库：写笔记、粘贴、扫描、相册、文件与搜索入口置顶，归档、批注和全文索引全部保留。",
                "Mac 工作台 1.67.1 已并入同一主仓：首页与设置采用 LeoPhoneAgent 品牌层级，并修复首页设置与刷新按钮无效。",
                "发布前通过 iOS 版本、动效与无障碍门禁，以及 Mac 456 项测试、类型检查、零警告 ESLint、零生产依赖漏洞和签名构建。"
            ]
        ),
        LeoRelease(
            version: "1.22.0",
            date: "2026-08-11",
            title: "大更新全面加固:审批闸收口、竞态清零",
            highlights: [
                "凭证审批闸下沉到所有调用路径的总收口:shell 命令读写 Cookie 同样要过审批,弹窗按真实域名记账,给 A 站的授权不再顺带放行 B 站。",
                "并发审批不再互相打架;人在会话列表时触发的审批也能弹出,不再无声挂起。",
                "链接预览的内网防护识别更多 IP 伪装写法并做域名解析预检;笔记保存、藏宝阁跨进程写入、删除竞态等数据一致性问题一并修复。",
                "Mac 端 LeoAgent 服务同步加固:登录死锁、静默断流、推送重试等 8 项修复。"
            ]
        ),
        LeoRelease(
            version: "1.21.0",
            date: "2026-08-11",
            title: "个人代理的授权与连接边界更清楚",
            highlights: [
                "读取浏览器 Cookie、导出凭据等敏感操作现在支持「允许一次 / 本次会话允许 / 拒绝」，个人使用时可以减少重复确认，又不会静默执行。",
                "OAuth 授权入口统一要求 HTTPS，网页预览会拦截本机与私有网段地址，并限制重定向边界。",
                "聊天数据库启用设备文件保护；临时 Cookie 环境文件会自动清理，不再长期残留。",
                "网络传输不再全局放开明文请求，仅网页内容保留兼容范围。"
            ]
        ),
        LeoRelease(
            version: "1.7.0",
            date: "2026-08-05",
            title: "网关:让 Mac 成为手机的第二具身体",
            highlights: [
                "新增「网关」:把你自己 Mac 上常驻的代理接进来。手机休眠时它照常干活,你随时可以观察、审批、停止。",
                "审批卡:远程要执行敏感操作时,手机上弹出可点的审批卡;按钮由网关按风险下发,高风险命令只给「允许一次/拒绝」。",
                "手表审批:审批同步到手表并抢占当前页——一台 Mac 正卡着等回答,它比你正在看的任何一页都重要。",
                "断线不丢结果:连接中断后自动改为按状态跟进,并在恢复时取回完整结果,而不是留给你一段被截断的回复。",
                "设置 →「网关」添加主机,地址用 tailnet 主机名,密钥取自网关的 API_SERVER_KEY。"
            ]
        ),
        LeoRelease(
            version: "1.6.3",
            date: "2026-08-03",
            title: "分享与导出",
            highlights: [
                "一键把回复生成图片分享卡(问题+答案摘要+时间+角标),微信场景直接发。",
                "整段会话可导出为 Markdown 或 PDF,自动进入产物托盘,可 AirDrop。",
                "超长回复可显示一行摘要(设置里开启,默认关)。"
            ]
        ),
        LeoRelease(
            version: "1.6.2",
            date: "2026-08-03",
            title: "智能复制与流转",
            highlights: [
                "整条回复就是一段代码时,单点复制直接给裸代码,不带围栏符号。",
                "表格一键复制为 CSV 或导出成 CSV 文件;代码块可一键存为文件并进托盘。",
                "选中回复任意一段可「引用追问」,长回复里的某一句也能精准提问。",
                "「复制到 Mac」:手机上看到的结果,一秒出现在你 Mac 的剪贴板里。"
            ]
        ),
        LeoRelease(
            version: "1.6.1",
            date: "2026-08-03",
            title: "回复工具条:复制不再需要秘密手势",
            highlights: [
                "每条完成的回复下方常驻:复制 / 引用 / 朗读 / 分享 / 更多。",
                "修复了一个假按钮——此前「Copy All」与「Copy Markdown」复制的是完全相同的内容;现在前者是真正压平后的纯文本。",
                "可在设置里选择一键复制的默认格式(纯文本 / Markdown)。"
            ]
        ),
        LeoRelease(
            version: "1.6.0",
            date: "2026-07-31",
            title: "2.0 支柱:记忆、技能、舰队、iPad、审计",
            highlights: [
                "记忆新增端侧语义召回:在设备本地按语义检索,不联网、不花 API 费用。",
                "可一键把当前会话提炼成可复用技能。",
                "多主机舰队视图与批处理队列;⌘K 命令面板。",
                "Agent 时间线:可回看每次运行做了什么(不记录提示词与模型输出)。",
                "清理约 85 行死代码。"
            ]
        ),
        LeoRelease(
            version: "1.5.1",
            date: "2026-07-30",
            title: "主动自动化",
            highlights: [
                "新增自动化规则:到达/离开某地、日程开始前 N 分钟、夜间充电时自动执行任务。",
                "每条规则可投票,连续被否 3 次自动暂停,不会变成骚扰。",
                "没有规则时整个子系统完全静默,零功耗零影响。"
            ]
        ),
        LeoRelease(
            version: "1.5.0",
            date: "2026-07-30",
            title: "交付管线:生成的东西真的能看到",
            highlights: [
                "生成的图片现在会直接内联显示在对话里,而不只是告诉你「已生成」。",
                "所有产物自动登记进托盘:SHA-256 校验、多版本留存、可回收站恢复。",
                "对话工具栏常驻产物角标。"
            ]
        ),
        LeoRelease(
            version: "1.4.3",
            date: "2026-07-29",
            title: "图像生成",
            highlights: [
                "接入文生图,产物直接进对话与托盘。"
            ]
        ),
        LeoRelease(
            version: "1.4.0",
            date: "2026-07-29",
            title: "Apple Watch 伴侣端",
            highlights: [
                "抬腕就问:点一下麦克风直接开始说,用产品自己的录音与识别管线,不再跳系统输入法。",
                "手表上可看会话进度、跑快捷任务、看简报、停止任务。",
                "手表端显示自动压平 Markdown 符号,45mm 屏幕上可读。"
            ]
        ),
        LeoRelease(
            version: "1.3.8",
            date: "2026-07-28",
            title: "SSH 网关中继",
            highlights: [
                "目标机直连不通时,自动用任何一台连得上的机器做跳板转发——手机端不需要装 VPN。",
                "支持设备专属 Ed25519 密钥认证;凭证只存本机钥匙串。"
            ]
        ),
        LeoRelease(
            version: "1.3.0",
            date: "2026-07-27",
            title: "纠错记忆:说过一次就不用再说",
            highlights: [
                "你纠正过的事进入独立的纠错记忆,永不老化、最高优先级,不参与任何时效衰减。",
                "记忆按时效分层,每条自动带「今天/昨天/N 天前(可能已过时)」标签。",
                "并发工具调用提升到 5 路。"
            ]
        ),
        LeoRelease(
            version: "1.2.0",
            date: "2026-07-27",
            title: "iOS 26 基线与审计修复",
            highlights: [
                "部署目标统一抬升到 iOS 26,启用 Liquid Glass 与新动效体系。",
                "修复多窗口场景隔离、OAuth 窗口错位等一批问题。"
            ]
        ),
        LeoRelease(
            version: "1.1.2",
            date: "2026-07-26",
            title: "Token 计量与快捷按钮真正跟随语言",
            highlights: [
                "修正 Token 数字此前由代码固定显示 K/k 的问题，现按应用语言使用系统本地化数字格式；中文会显示完整数字或“万/萬”。",
                "输入框上方的内置快捷任务名称改为按当前语言显示，用户自己修改或创建的任务名称保持原样。",
                "Token 用量的上下文、输入、输出、缓存与输出速度文字统一跟随当前语言，产品术语 Token 保持不翻译。",
                "本次修复直接覆盖真实控件的数据展示路径，不再只依赖语言目录完整性检查。"
            ]
        ),
        LeoRelease(
            version: "1.1.1",
            date: "2026-07-26",
            title: "界面语言全面对齐",
            highlights: [
                "补齐快捷任务、输入快捷操作、对话框按钮、任务状态、任务产出与设置页面此前遗漏的本地化文本。",
                "德语、法语、日语、韩语、俄语、简体中文和繁体中文均已覆盖完整语言目录，并通过格式占位符检查。",
                "Token 作为产品与模型计量术语在所有语言中保持 Token，不翻译为“词元”或其他名称。",
                "中文高频界面经过人工校准，统一使用“快捷任务”“输入区”“任务产出”“Token 用量”等清晰表达。"
            ]
        ),
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
