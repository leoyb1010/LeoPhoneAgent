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
            version: "1.20.2",
            date: "2026-08-10",
            items: [
                "🛟 笔记退出时的保存改为「先取值再落盘」:原来是退出后才去读输入框内容,而那时视图已经销毁,读到的可能不是你最后打的字——也就是「写完退出内容没了」。现在取值发生在视图还在的那一刻",
                "🔍 扫描件/图片识别出的文字现在能看见了:点开附件,图片下方显示 OCR 全文,可选中复制。之前只进了搜索索引,存了却看不到",
                "⚡️ 历史版本列表不再每行两次读盘:改为进页一次性预读,滚动不顿",
            ]),
        LeoReleaseNote(
            version: "1.20.1",
            date: "2026-08-10",
            items: [
                "🏛 「收藏」改名为「Leo藏宝阁」——它已经不只是收藏,还装着你的笔记、批注和扫描件",
                "✍️ 新增入口独立出来:右上角 + 点一下直接开始写笔记,长按才展开扫描/相册/文件/粘贴链接。以前这些全埋在 ⋯ 杂项菜单里,点进来了还要再找一次",
                "🧹 ⋯ 菜单现在只管管理(多选删除、查看归档、分享默认动作),新增和管理分开",
                "🪄 空状态给的是能点的按钮(写笔记 / 粘贴链接),不再是一段「你可以去哪里点」的说明文字",
            ]),
        LeoReleaseNote(
            version: "1.20.0",
            date: "2026-08-10",
            items: [
                "📎 附件三条路,全用系统件:扫描纸质文档(自动找边、透视校正、去阴影)· 从相册导入 · 从文件导入",
                "🔍 图片自动 OCR 进全文检索:拍一张会议白板或一页书,回头能靠里面的字搜到它。本机识别,中英混排,离线不花钱",
                "🎙 对 Siri 说「让LPA记笔记」直接存进收藏库,不用打开 app——想法冒出来时人常常在走路、在开车,掏手机找 app 的十几秒足够把它弄丢",
                "✂️ 阅读时选中一段文字分享进来,现在会同时留下文字和出处链接(以前只留链接,等于又收藏了一遍整篇)",
            ]),
        LeoReleaseNote(
            version: "1.19.0",
            date: "2026-08-10",
            items: [
                "📝 收藏库变成知识库:可以直接写笔记了(右上角「写一条笔记」),支持 Markdown,原生编辑器零延迟。你的想法和你收藏的东西住在同一个库里",
                "💬 任意收藏可加批注:读完一篇文章左滑写两句自己的想法,和原文放在一起,也能被搜到",
                "📌 左滑置顶 / 右滑归档:归档是收起来不删,右上角菜单里「查看归档」随时回看",
                "🕘 笔记自动留历史版本(最多 10 版),手滑清空了能找回来",
                "✨ 笔记里可以让本机模型生成摘要和标签(离线,不出手机)",
            ]),
        LeoReleaseNote(
            version: "1.18.0",
            date: "2026-08-10",
            items: [
                "📖 收藏改为应用内阅读:能定位到原 app 里那条内容就跳 app(小红书笔记、B站视频、知乎回答),其余一律在 app 内阅读器打开,带阅读模式——不再被甩去外部浏览器。公众号从来没有跳转方案,以前每次都被甩出去的就是它",
                "🖼 链接预览改成通用管线:系统抓取器 → og / twitter / JSON-LD / 站点变量 / 正文首图 / 站点图标,层层兜底。任何链接都能抓到标题和封面,不再只有少数站有图",
                "🎨 实在抓不到封面时,用来源色块 + 标题首字占位,一眼认得出是哪条,不再是一片灰",
                "🚫 定位不到具体内容时不再把你丢到 app 首页自己找(以前 B站/抖音/知乎会这样),改为直接在阅读器里看",
            ]),
        LeoReleaseNote(
            version: "1.17.2",
            date: "2026-08-10",
            items: [
                "🐛 修复「点 ☆ 没反应」:钉选其实已经存下了,但那一行的星星图标不重绘,看起来像没点动。根因是钉选状态存在系统偏好里,SwiftUI 感知不到它变化——上一版为此强制重建整个列表(于是跳回顶部),这一版改成让状态本身可观察,既会立刻变色也不跳顶",
                "⭐️ 星星热区放大到 44×40,更好点",
            ]),
        LeoReleaseNote(
            version: "1.17.1",
            date: "2026-08-10",
            items: [
                "🐛 钉常用模型时列表不再跳回顶部——之前滚到下面点一次 ☆,列表就整个重建回到最上面,连钉三个要重新滚三次",
                "🐛 同一个模型挂在两个供应商下时,不再两行都打勾:勾选改按模型身份判断,不再按显示名",
                "🐛 /model 打得模糊且命中多个常用时会提示歧义,不再静默挑一个(钉了 gpt-4o 和 gpt-4o-mini,打 /model gpt 以前会闷头切到其中一个)",
            ]),
        LeoReleaseNote(
            version: "1.17.0",
            date: "2026-08-10",
            items: [
                "⭐️ 常用模型改成你自己钉:模型列表每行右边有个 ☆,点亮就进「常用」(最多 6 个),顺序可以拖。不再靠「最近使用」猜你的习惯",
                "⚡️ 长按输入框上方的模型胶囊,直接弹出钉好的常用,点一下即换,全程不开面板——这是最快的一条路",
                "🧹 模型分组从快切面板里移走了:它是路由配置(默认模型+语音模型的组合),和日常换模型不是一回事;要绑分组走面板底部「全部模型与分组…」",
                "🔁 长按发送键的「改用 X 并发送」、以及 /model 的候选,都改用同一份常用清单",
            ]),
        LeoReleaseNote(
            version: "1.16.2",
            date: "2026-08-10",
            items: [
                "🐛 模型快切面板不再「空面板」:之前「最近用过」只记录新入口的切换,老选择器换的模型从不进来——首次打开面板几乎什么都没有,看起来就是点了没反应。现在面板直接平铺全部可用模型(最多 30 个,可搜索),从完整选择器换模型也会记入「最近用过」",
                "🐛 一个模型都没有时,面板会明确告诉你去「模型供应商」添加,而不是一片空白",
            ]),
        LeoReleaseNote(
            version: "1.16.1",
            date: "2026-08-10",
            items: [
                "🐛 重要修复:「Mac 上进行中」在 1.16.0 实际没生效(启动逻辑挂错了视图,只要有历史会话就不显示),现在真的出现在主列表顶部,iPad 分栏也有",
                "🐛 网络抖动时「Mac 上进行中」不再整节闪没(请求失败保留上一轮,只有确认为空才移除)",
                "🐛 /model 与「用 X 发送」在模型不可用时不再假装成功:前者明确报错,后者取消发送",
                "🐛 收藏改进:启动即同步到 Mac(不再依赖打开收藏页);正文抓取失败 3 次自动跳过,不再堵住后面的条目;两字词也能搜正文;搜索防抖不再卡输入",
                "🐛 Siri 派活的语音整理加 4 秒上限,本机模型慢时直接用原文,任务不会因此丢失",
            ]),
        LeoReleaseNote(
            version: "1.16.0",
            date: "2026-08-10",
            items: [
                "📋 Mac 会话不再藏得深:主界面会话列表顶部新增「Mac 上进行中」,正在跑的、等审批的直接列出来,点一下就进那段对话——以前要走 设置 → Mac 控制台 → 等扫描 CLI → 点进会话,四步",
                "🎙 修正 Siri 派活的去向:「让LPA干活」现在在这台手机上跑(本机优先),不会再把随口一句简单任务甩到远端 Mac;要上 Mac 请明说「让LPA在Mac上跑」或「让LPA用我的Mac」",
                "📖 Siri 指挥中心页标注了每句话到底在哪执行",
            ]),
        LeoReleaseNote(
            version: "1.15.1",
            date: "2026-08-10",
            items: [
                "🐛 停用某个供应商后,它的模型不再出现在「最近用过」里(以前点了会把会话绑到不可用的实例,发送时才报错)",
                "🐛 切换模型失败时不再假装成功:面板会留在原地并说明原因(供应商已停用、或分组里没有可用成员)",
                "🖥 Mac 端 1.64.0 同步发布:舰队视图(在任意一台看见另外两台)+ 审批中心(全舰队待审批聚一处),并补上了随包内置的更新记录与启动弹卡",
            ]),
        LeoReleaseNote(
            version: "1.15.0",
            date: "2026-08-10",
            items: [
                "📚 收藏能搜正文了:收藏的链接会在后台抓取正文并建全文索引(中文用三字滑窗分词),搜索框现在同时搜标题、摘要、标签和正文——「上周存的那篇讲 X 的」这种找法开始成立",
                "🔎 收藏进系统搜索:在 iPhone 主屏下拉搜索里能直接搜到收藏条目(只放标题/来源/摘要,正文不出 app)",
                "🧹 删除收藏时全文索引与系统搜索同步清理,不留「搜得到但打不开」的幽灵",
            ]),
        LeoReleaseNote(
            version: "1.14.0",
            date: "2026-08-10",
            items: [
                "🧠 本机模型上线(端上跑,内容不出手机):收藏自动生成一句话摘要与标签 · 输入框上方新增「改写」(润色/精简/翻译/语气转换,离线可用)· 用 Siri 指挥 Mac 时把口述整理成标题+要点再下发",
                "🔍 设置 → 我的设备 → 本机模型:状态、原因、生效范围一页讲清,还能当场自检;不可用时全部功能自动回落原方式,不会消失",
            ]),
        LeoReleaseNote(
            version: "1.13.0",
            date: "2026-08-10",
            items: [
                "🗂 Siri 出卡片:「LPA汇报」不再只念一段话——直接给一张舰队卡,每台 Mac 一行,有待审批的标橙并带「批准」按钮,当场就能拍板;指挥 Mac 与批准也各有回执卡",
                "🔔 远程推送就位:app 完全没运行时也能收到 Mac 的审批与终态(需在中继放好推送密钥,详见设置 → Siri 指挥中心)",
                "🐛 修复灵动岛不显示 Mac 任务:任务快照被下游过滤器整批丢弃,锁屏一直是空的",
                "🐛 修复回前台对账完全空转:判据把自己写死,一条提示都发不出,还会把事件水位烧掉导致永久丢失",
                "🐛 修复真实失败被静音:上一版把「可恢复中断」也当成不用报,结果断流/截断/拒答/空响应这些真失败连成功通知都不发了。现在三态分明——挂起不报、中断如实报中断、真失败报失败",
                "🐛 修复失败判定读错行:排队消息与系统提示会排在助手回合之后,导致失败的回合被读成成功",
                "🐛 修复 Siri 汇报把关机的 Mac 报成「空闲」;批准改为选最近一条(而非最老),且单台失败会继续尝试其余",
            ]),
        LeoReleaseNote(
            version: "1.12.0",
            date: "2026-08-10",
            items: [
                "📡 Mac 主动上报:审批请求与任务终态现在由 Mac 主动推给中继,手机回到前台自动对账——切走期间 Mac 上要审批的任务不再静默挂着,回来就能看到并直接在通知上批",
                "🔁 断线不丢:Mac 推不出去的事件会攒着,重连后按顺序补发;手机按序号幂等合并,不会重复打扰",
                "🖥 Mac 端(leocodebox)同步升级:新增会话摘要、任务收据、产物下载三个接口,为「一张可核对的任务收据」打好地基",
                "🎛 Mac 端设置页重做:13 项平铺改为三组折叠 + 搜索框,与手机端同一套信息架构",
            ]),
        LeoReleaseNote(
            version: "1.11.0",
            date: "2026-08-10",
            items: [
                "🔀 换模型不再费劲,三条路都是两步内:输入框上方新增当前模型胶囊(点开=最近用过的直接选)· 打「/model kimi」一步切换 · 长按发送键可「改用某模型并发送」",
                "🐛 根治切到别的 app 误报「任务失败」:失败判定过去是「最后一条消息上挂着错误」这种状态快照,后台挂起顺手打的错、上一轮的旧错、你自己按的停止,都会被算成失败。现在失败必须是本次真失败,且发通知前会按此刻状态复核一次——挂起/已恢复一律不报",
            ]),
        LeoReleaseNote(
            version: "1.10.2",
            date: "2026-08-08",
            items: [
                "⚡️ 点收藏不再先闪浏览器:小红书分享的是短链(xhslink.com),旧路径要靠浏览器吃一次跳转才进 app。现在后台预先把短链解析成真实地址并缓存,再用各家私有协议(xhsdiscover://、bilibili://、zhihu:// 等)直达——一步进 app,零浏览器",
                "🔗 支持直达:小红书、B站、知乎、微博、抖音、YouTube、X、淘宝;没装对应 app 才回落浏览器",
                "🖼 链接标题封面改用解析后的真实地址抓取,短链条目也能有封面了",
            ]),
        LeoReleaseNote(
            version: "1.10.1",
            date: "2026-08-08",
            items: [
                "🗑 修复收藏删不掉:左滑删除、长按菜单删除、右上角「选择并删除」多选批量删,三条路都通(旧版点击手势吞掉了滑动)",
                "↩️ 点收藏直接回原 App:链接优先用系统跳转——装了小红书/B站就直接进 app 看原内容,没装才落浏览器;应用内预览移到长按菜单",
                "📋 剪贴板收藏(小红书解法):小红书只给「复制链接」不给分享面板,现在复制后回到收藏页,顶部剪贴板条一点即存;整段「99 复制打开小红书,看看【…】http://xhslink…」会自动抽出链接、把文案当标题",
                "✍️ 右上角新增「粘贴链接收藏」:可一次粘贴多条(换行分隔)",
                "🎛 收藏进 Siri 与操作按钮:「LPA收藏」语音直存;配一条「获取剪贴板 → 收藏到 LPA」快捷指令绑到侧键,复制完按一下就收藏(设置 → Siri 指挥中心有分步说明)",
            ]),
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
