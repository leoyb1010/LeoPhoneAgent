# LeoPhoneAgent 下一轮升级计划:吸收开源经验 + iOS 27

日期:2026-09-25 · 基线:main `48aa66c4`(iOS 1.43.0 (125) / Android alpha.27 / Mac leophone 1.2.4)
状态:**计划,未动手**。每一项都写了参考来源、做法、代价和验收办法;按阶段发版,每一版照发版铁律 bump 版本并写「本次更新」。

调研原文(英文,含逐个项目的笔记、许可证、星数与日期、出处链接)在同目录:

- `research-agents-and-control.md`:47 个 Agent 客户端、系统操控、结果呈现类开源项目
- `research-ui-voice-wearable.md`:38 个 Apple 平台 UI、iPad、语音、手表类开源项目
- `research-sdk27-apis.md`:本机 Xcode 27 SDK 里 iOS/iPadOS/watchOS 27 的新 API 与弃用(每条带 SDK 文件和行号)

---

## 一、结论先行

这一轮的目标是「更丝滑、更高级,但不更胖」。看完 85 个项目后,真正能让体验上一个台阶的,大多不是新功能,而是几条纪律:

1. **不抢读者的屏幕。** 用户在读的时候,屏幕上任何东西都不能自己动(Happy 的验收规则、Element X 拖动时暂缓插入、Telegram 串行化列表事务)。
2. **状态先于动作。** 连接、运行、权限模式、额度,在任何会改变工作的按钮之前就看得见(Mimi Remote 的设计原则)。
3. **一套词汇到处用。** 列表行、首页提醒条、灵动岛、组件、手表,用同一组运行状态和同一组审批选项(Conduck、hermex、omi、CodeIsland)。
4. **克制的玻璃和动效。** Liquid Glass 只用在控件和栏上,不用在内容上;所有动效曲线收在一个文件里;「减弱动态效果」时直接切换,不是换一个短一点的动画(Ice Cubes、hermex、Apple 指南)。
5. **更轻。** 默认工具少于 25 个、工具说明按需加载;不引入 React Native、WebView 生成式界面、端侧大模型;性能预算写成测试,只收紧不放宽(goose、Playwright MCP、Happy)。

最值得先做的 10 件事(按收益 / 代价排序):

| # | 做什么 | 设备 | 代价 |
|---|---|---|---|
| 1 | 流式输出时列表稳定:拖动或滚动时暂缓插入,手势结束再一次性应用;跟随到底部改成明确的开关 | iPhone、iPad | 列表宿主里约 100 行,无依赖 |
| 2 | 流式节奏:每帧最多提交一次、只重解析最后一个 Markdown 块、50–100 ms 冲刷一次;中继每会话最多 60 ms 一条 | 全部 | 无依赖 |
| 3 | 做完的工具步骤折叠成一行「已工作 1 分 12 秒 · 9 步」,展开时以点按的那一行为锚 | iPhone、iPad、Mac | 只是界面逻辑,还会减少要画的视图 |
| 4 | 灵动岛加序号和过期时间:迟到的推送丢弃,中继断了显示「已过期」而不是永远「运行中」 | iPhone、手表 Smart Stack | 很小 |
| 5 | 通知里直接回复;审批加「拒绝并停止」;「始终允许」显示将保存的具体规则,默认只在当前目录生效 | iPhone、手表 | 通知分类 + 一张设置列表 |
| 6 | 手表离开 iPhone 时从通知审批(安全选项排第一,双指互点只会触发它) | 手表 | 通知分类 + 处理器 |
| 7 | iPad 检查器栏:工具调用、文件差异、沙箱输出、产物放在聊天旁边,而不是盖住聊天的面板 | iPad | 复用现有视图 |
| 8 | iOS 27 可调整窗口清理:二十多处 `UIScreen.main` 换成窗口或场景几何 | iPad(也影响 iPhone 镜像和台前调度) | 机械修改 |
| 9 | 性能预算测试:最近 10 个真实会话上检查首帧、首字、流式期间主线程卡顿、空闲重绘次数 | iPhone、Android | 只加测试 |
| 10 | 风险分级的「智能批准」:介于「逐项确认」和「全自动」之间,低风险自动放行,高风险一定问 | iPhone、Android、Mac | 一个枚举加一张正则表 |

---

## 二、出发点:现在已经有什么(1.43.0 之后)

**这一版刚完成的**

- 灵动岛和后台状态说真话:运行中不再显示失败;持续处理任务的进度每个事件都前进;暂停、中断、需要注意、手动停止、完成各有明确的静止外观。
- 删除服务商、模型或分组时级联清理收藏、最近使用、默认分组、模型槽。
- iPad:没选对话时右栏是首页工作台;「/」面板、Mac 控制台在 iPad 上能用;设置、藏宝阁、Mac 控制台是整页面板。
- Apple Watch:只管说话、看答案、朗读、追问、记录;蜂窝版离开 iPhone 时直连默认分组里的模型;息屏常亮时停动画。
- 启动时不再在主线程同步等定位服务。

**代码里已有、可以直接接着用的底座**

- 消息列表是 UIKit 集合视图托管 SwiftUI 行(`CollectionViewMessageListV3`),已有「↓ 新消息」胶囊和跟随状态;逐词淡入由一个 CADisplayLink 驱动(`TextFadeAnimator`)。
- 动效和触感已开始集中(`LeoMotion`、`LeoHaptics`、`.sensoryFeedback`)。
- 1.39 起本地记录冷启动、回前台首帧、发送到首字、Mac 回执与首字、推送到达、滚动卡顿、主线程卡顿 ≥250 ms(`Diagnostics/perf.jsonl`),这就是性能预算的数据源。
- 中继断线后的一次性补齐(`RelayEventCatchUp`)、推送令牌注册(`PushRegistrar`)。
- UI 测试里已有逐帧截图比对的抖动检测(`MinisUITests` 的 `captureAndAnalyzeVisualJitter`),可以直接当「列表不跳」的验收工具。

**已核实的缺口**

| 缺口 | 现状 |
|---|---|
| 灵动岛防过期 | 3 处 `ActivityContent(..., staleDate: nil)`,`ContentState` 没有序号 |
| 通知回复与审批 | 审批通知只有「批准一次」「拒绝」两个动作,没有文字回复动作 |
| iPad 检查器、多窗口、拖出 | `.inspector` 0 处、`openWindow` 0 处、`.draggable` 0 处 |
| 动态字体 | `@ScaledMetric` 0 处 |
| 手表 Smart Stack 专用小尺寸 | `supplementalActivityFamilies` 0 处 |
| 可调整窗口 | 二十多处 `UIScreen.main`(按整块屏幕而不是窗口算尺寸) |
| 手表审批 | 只走 WatchConnectivity,iPhone 不可达时审批不了 |
| 后台保活 | `UIBackgroundModes` 含 `audio`、`location`、`processing`;静音音频保活耗电 |

---

## 三、参考了谁,拿什么

完整笔记见附录。这里只列会影响计划的:

| 类别 | 项目 | 拿来的东西 |
|---|---|---|
| 远程指挥编码 Agent | Happy、Paseo、Mimi Remote、CodeIsland、OpenCode iOS、Nimbalyst | 列表永不自己动、「Worked」折叠、流式节奏(60 ms 合并、逐帧提交、只解析尾块)、有人在看就不推送、iPad 三栏、状态先于动作、灵动岛序号 |
| 协议与运行时 | Codex app-server、Agent Client Protocol、OpenCode serve | 统一的审批选项映射(一次 / 本会话 / 始终 / 拒绝 / 拒绝并停止)、结构化工具调用状态、差异与实时终端内容块 |
| 通用 Agent | OpenClaw、Hermes、goose、OpenHands、LibreChat | 审批超时默认拒绝、问题卡带倒计时、风险分级自动批准、工具少于 25 个、可续传的流、跨会话全文回忆、长任务后「存为技能」 |
| 系统操控 | Playwright MCP、agent-browser、Mobilerun、Stagehand、Open-AutoGLM、Peekaboo、iMCP | 无障碍树优先、页面没变就不截图、不可信内容加边界、密钥不进模型、「轮到你了」接管卡、Mac 默认只在后台操作、权限状态可视化 |
| 结果呈现 | A2UI、json-render、AG-UI、Vercel AI SDK、OpenAI Apps SDK 指南 | 原生组件目录式生成界面(校验失败退回 Markdown)、工具卡状态机、卡片最多两个动作且不嵌套滚动 |
| iPhone 质感 | Ice Cubes、Element X、Signal、Telegram、hermex、fullmoon、Enchanted、Wikipedia | 拖动时暂缓更新、离主线程量高度、一个动效文件、触感词汇、形变的玻璃输入栏、动态字体令牌、可访问性审计进 CI |
| iPad | Mimi Remote、Ice Cubes、NetNewsWire、CodeEdit、Code App、a-Shell | 窄窗推入、宽窗分栏、检查器、上下文键盘命令(打字时让位)、⌘K、每窗口独立状态、可拖高度的终端面板、活动查看器 |
| 手表与语音 | Conduck、Home Assistant、Pinch、Loop、watchGPT、omi、LiveKit、Pipecat | 手表只用 HTTPS、后台 URLSession 兜底、朗读礼仪、审批只能点按不能用表冠、高风险转表冠确认、Smart Stack 小尺寸、一键提问控件、语音状态可视化 |

**明确不采用的**(详见第八节):React Native / Flutter 运行时、iPhone 和手表上的 WebView 生成式界面、视觉优先的屏幕操控、端侧大模型和重排模型、手表实时语音、吉祥物和音效、虚拟机沙箱、自动过验证码、移动端完整代码编辑器、靠 XCTest 跨 App 操控。

---

## 四、iPhone 计划

优先级:P0 = 流畅度底座,P1 = 清晰与质感,P2 = 能力(保持轻量)。

### P0 流畅度底座

| 项目 | 做什么 | 参考 | 代价 | 验收 |
|---|---|---|---|---|
| 列表不跳 | 流式期间用户拖动或惯性滚动时,新行和高度变化进队列,手势结束后一次性应用;列表事务串行执行;删除、编辑、插入分阶段应用 | Element X `hasPendingItems`、exyte/Chat 更新队列、Telegram 事务队列 | `CollectionViewMessageListV3` 内约 100 行 | 现有抖动检测:流式 + 拖动历史 10 秒,帧间突变 0 次 |
| 明确的跟随开关 | 自动跟随只在真实信号下开关:开始拖动即关;发送、点「↓」、或手势停在底部 12 pt 内才开;流式增长永远不改它。「↓」按钮在空闲时距底 80 pt、流式时 160 pt 内隐藏 | hermex `ChatScrollPolicy`、ListViewKit | 一个小策略类型 + 单元测试 | 策略单测覆盖 6 种手势序列 |
| 流式节奏 | 文本每 50–100 ms 冲刷一次,每帧最多提交一次;只重解析正在增长的最后一个 Markdown 块;逐词淡入只作用于新到的词,代码和公式不淡入;断线重连后不重播已看过的文字 | Paseo、LibreChat、Lakr233 MarkdownView(20 fps)、Enchanted(100 ms) | 无新依赖;和现有 `TextFadeAnimator` 对齐 | 长回答期间主线程卡顿 ≥250 ms 为 0 次;CPU 比 1.43 降低(Instruments 对比同一段回放) |
| 折叠做完的步骤 | 一轮结束后,它的工具调用和思考折叠成一行「已工作 1 分 12 秒 · 9 步」;展开以点按行为锚向上生长,末尾是同高度的「收起」;进行中的一轮平铺、永不折叠 | Happy、OpenClaw iOS | 界面逻辑;减少单元格数 | 长会话单元格数下降;展开收起时视口内文字位置不变 |
| 高度缓存与首屏 | 行高离主线程计算并缓存(宽度或字体变化时失效);首次加载条数按屏幕高度估算,一次取满一屏 | Signal `CVLoader`、NetNewsWire、Agmente | 中等(失效规则要写对) | 1000 条以上的会话打开到可滚动 ≤ 1 秒 |
| 性能预算测试 | 用最近 10 个真实会话回放检查:首帧、发送到首字、流式期间主线程卡顿次数、空闲 3 秒内重绘 ≤ 2 次。预算只收紧,不为了过而放宽 | Happy 验收规则 | 只加测试;数据来自 `perf.jsonl` | 进 `MinisLogicTests` 或单独的性能测试计划 |

### P1 清晰与质感

| 项目 | 做什么 | 参考 | 代价 |
|---|---|---|---|
| 工具卡规则 | 卡片按内容自适应高度;最多两个动作且放在底部;不嵌套滚动、卡内不跳转;原始 JSON 收进「详情」;每张卡有明确状态:准备输入、等审批、运行中、完成、出错、被拒绝 | OpenAI Apps SDK 指南、Vercel AI SDK 工具状态、Happy | 无 |
| 一套运行状态词汇 | 列表行、首页提醒条、灵动岛、组件、手表统一用:运行中、需要审批、需要回答、已暂停、失败、完成(已看 / 未看)。状态由工具类型推出;「停止」只在这台设备真能取消时出现 | Conduck、hermex、omi | 一个枚举和映射;1.43 的静止结局可直接扩展 |
| 灵动岛加固 | `ContentState` 加单调递增的序号,乱序推送丢弃;`staleDate` 设为上次更新加两个心跳,过期显示「已过期」;锁屏只显示数量和状态,不显示回复原文;`supplementalActivityFamilies([.small])` 给手表 Smart Stack 和 CarPlay 专门的小布局;只有「需要审批」和「完成」用带提醒的更新(会顺带震一下手表) | CodeIsland、hermex、Home Assistant、ActivityKit 文档 | 组件扩展内;每次更新 ≤ 4 KB |
| 通知里直接回复 | 「完成」和「需要回答」通知加文字回复动作;审批通知保留 `.authenticationRequired`,再加「拒绝并停止」 | PhoneAgent、Nimbalyst、CodeIsland | 无依赖 |
| 审批词汇统一 | 四个按钮 +「拒绝并停止」;「始终允许」写明将保存的规则(命令模式 + 目录),默认只在当前目录;设置里列出所有长期授权并可撤销;无人回应的审批超时后按拒绝处理;问题卡支持单选 / 多选和倒计时 | Codex app-server、ACP、OpenCode、OpenClaw | 中继一张映射表 + 设置一张列表 |
| 智能批准 | 介于「逐项确认」和「全自动」之间:确定性规则表(`rm -rf`、`curl | sh`、`eval`、工作区外写入、读 `.env`)与模型给出的风险字段取最高;低风险自动放行,高风险必问,卡片上显示风险标记;`ToolLoopDetector` 命中时转成询问卡而不是悄悄停下 | OpenHands、goose、OpenCode 默认值 | 一个枚举 + 正则表 |
| 形变的玻璃输入栏 | 输入栏右侧只有一个按钮,麦克风 → 发送 → 停止用 `.contentTransition(.symbolEffect(.replace))` 形变(按钮身份保持不变才不会闪);`GlassEffectContainer` 包住按钮组;⌘↩ 发送 | Conduck、Element X、Ice Cubes | 小 |
| 动效与触感收口 | 剩下零散的 `withAnimation` 全部改用 `LeoMotion`;「减弱动态效果」返回 nil(直接切换);触感词汇:发送轻、完成成功、取消中、拒绝警告,绝不每个 token 都震 | hermex、Mimi Remote | 一个文件 |
| 动态字体 | 所有字号走文本样式;图标尺寸和间距用 `@ScaledMetric`;大字号下状态胶囊允许两行 | Wikipedia、Ice Cubes、Element X | 小 |
| 平静的进度呈现 | 可折叠的「思考了 N 秒」;进行中的标签用微光遮罩(约 20 行,不加依赖);计时和计数用等宽数字 | fullmoon、SwiftUI-Shimmer 的做法 | 很小 |
| 可访问性审计进 CI | 为每个 SwiftUI 预览自动生成 `performAccessibilityAudit` 测试 | Element X | 只加测试 |

### P2 能力(保持轻量)

| 项目 | 做什么 | 参考 | 代价 |
|---|---|---|---|
| 原生组件目录式生成界面 | 新增 `render_ui` 工具,模型输出的 JSON 必须符合约 10 个原生组件(卡片、键值、列表、表格、指标、图表、图片、按钮、单选 / 表单)的约束;校验失败退回 Markdown;采用「组件扁平列表 + ID 互相引用」的形状,后续可以只更新单个组件 | A2UI、json-render、AG-UI | 手写目录很小;不引入 A2UI 的 Swift 包(规范还在变) |
| 浏览器自动化瘦身 | 用带引用编号的无障碍 / DOM 快照感知页面;截图只在页面变化时拍;页面文字包在带随机数的不可信边界里;按任务设域名白名单;即将点按的元素上画编号浮层,让用户看到意图 | Playwright MCP、agent-browser、Mobilerun | 注入脚本 + 浮层 |
| 密钥不进模型 | 模型只负责找到输入框,由 App 从钥匙串填值(用户确认后);工具输出脱敏;遇到登录、验证码、付款时暂停在「轮到你了」卡片,点「继续」再往下;不自动过验证码 | Stagehand、Open-AutoGLM | 小 |
| 工具按需加载 | 默认工具少于 25 个;设备能力按工具组开启;在选中之前提示词里只有名字和一行说明,用到时再取完整参数定义;多步界面操作允许一次批量调用 | goose、Playwright MCP、agent-browser、mobile-mcp | 负代价:提示词变短、首字更快 |
| 跨会话回忆 | 历史会话和藏宝阁条目建全文索引,命中后让模型总结;多步长任务结束后提供「存为技能」(模型起草 `SKILL.md`,用户确认) | Hermes | 系统自带 SQLite;需确认目标系统的 FTS5 可用 |
| 后台保活评估 | 测量静音音频保活的耗电;长任务优先靠持续处理任务 + 中继推送,音频只在真的朗读时使用 | FlowDown 反例、PhoneClaw | 先测量再决定,不贸然拆 |

---

## 五、iPad 计划

原则:能力和 iPhone 一样,布局不一样;窄窗口像 iPhone,宽窗口像 Mac。

### P0

| 项目 | 做什么 | 参考 | 代价 |
|---|---|---|---|
| 可调整窗口清理 | 二十多处 `UIScreen.main` 按用途替换:布局上限改用窗口 / 场景几何(`effectiveGeometry`)或容器尺寸;设备判断只留给确实跟设备有关的行为 | WWDC26「Modernize your UIKit app」、Mimi Remote、Ice Cubes | 机械修改 |
| 窄窗推入、宽窗分栏 | 保持 1.43 的尺寸策略;窄窗口用真正的推入导航,保证边缘返回手势;侧栏宽度 260 / 300 / 340 | Mimi Remote | 路由小改 |
| 检查器栏 | `.inspector` 放在聊天右侧:当前工具调用、文件差异、沙箱输出、记忆命中、产物;iPhone 仍用面板 | Mimi Remote、CodeEdit | 复用现有视图 |
| 菜单栏与键盘 | `.commands` 按使用频率组织:新任务 ⌘N、发送 ⌘↩、停止 ⌘.、切换侧栏 ⌃⌘S、检查器 ⌥⌘I、会话 ⌘1–9、⌘K、⌘F、⌘,;不可用时变灰而不是隐藏;按上下文注册键盘命令,输入框聚焦时全部让位给打字 | Apple WWDC25 指南、NetNewsWire、Mimi Remote | 小 |

### P1

| 项目 | 做什么 | 参考 | 代价 |
|---|---|---|---|
| 多窗口 | `WindowGroup(for: 会话 ID)` + `openWindow`;会话右键「在新窗口打开」;每个窗口用 `@SceneStorage` 记住侧栏和选中会话 | Ice Cubes、a-Shell | 小 |
| 双向拖放 | 文件、图片、链接拖进输入栏;回复里的文件、图片、代码块可以拖出到别的 App | Ice Cubes、Code App | 小 |
| 常驻终端面板 | 宽布局下聊天底部一块可拖高度的终端面板,边聊边看沙箱;硬件键盘修饰键和精简按键条 | Code App、Blink | 只是布局(沿用自有终端) |
| 活动查看器 | 标题栏里显示正在运行的 Agent 和圆形进度,点开是通知列表 | CodeEdit | 小,复用运行状态词汇 |
| 设置分栏 | 整页设置在宽窗口里改成左侧分组、右侧详情的两栏,和系统设置一致 | Apple 设置 | 小 |
| 指针 | 行和工具栏按钮加悬停高亮;按下缩放 0.985、透明度 0.84;优先级:按下 > 聚焦 > 悬停 | Mimi Remote、Ice Cubes | 很小 |
| 可读宽度 | 聊天内容用 `contentMargins` 居中限宽(约 800 pt),滚动条留在窗口边缘 | hermex | 约 40 行 |

---

## 六、Apple Watch 计划

原则:手表只管说话、看结果和点头摇头;只用 HTTPS 请求 / 响应(watchOS 在蜂窝路径上屏蔽 WebSocket 和流式连接,见 Apple TN3135)。

### P0

| 项目 | 做什么 | 参考 | 代价 |
|---|---|---|---|
| 离开 iPhone 也能审批 | 审批通知分类加「批准」「拒绝」;安全选项排第一(Series 9 / Ultra 2 的双指互点会执行第一个非破坏性动作);高风险批准标 `.authenticationRequired`;不依赖 iPhone 转发通知里的文字输入(手表收不到输入内容) | Apple 可操作通知文档、Home Assistant | 分类 + 处理器 |
| 请求可靠 | 直连请求失败或抬腕中途放下时,转成允许蜂窝的后台 URLSession 任务,答案回来后用通知送达;`-1009` 等网络错误给出如实说明(附近的 iPhone 可能正在替手表联网) | Conduck、Pinch | 小 |
| 朗读礼仪 | 只在前台或抬腕的新鲜窗口内自动朗读;放下手腕或变暗就暂停、抬起继续;按麦克风即停;朗读前去掉 Markdown、链接、表情和控制字符;结束后以 `.notifyOthersOnDeactivation` 让出音频,被压低的音乐恢复 | Conduck、Pinch | 小,还省电 |
| 回答长度 | 一行标题 + 纯文本;需要朗读的回答不超过 4 句 | Conduck、fullmoon | 无 |

### P1

| 项目 | 做什么 | 参考 | 代价 |
|---|---|---|---|
| 一键提问 | 手表 `ControlWidget`「问 Leo」,可放控制中心、Smart Stack、操作按钮;手表 `AppShortcutsProvider` 让系统安装时就能索引 | Conduck、Home Assistant | 小 |
| Smart Stack | 由 iPhone 组件扩展提供 `.small` 专用布局;只有「需要审批」和「完成」带提醒;在 Info.plist 允许从实时活动打开手表 App | Home Assistant、Apple 文档 | 只在 iPhone 组件扩展里 |
| 手表审批卡 | 只能点按;标题按风险着色;差异或命令放在限高约 64 pt 的可滚动区;表冠只滚动、绝不在可滚动界面上批准;最高风险单独一屏「转动表冠确认」,停转就归零 | Pinch、Loop | 小 |
| 两路投递与预热 | 关键小消息同时走 `sendMessage` 和 `transferUserInfo`,按 ID 去重;开始录音时先给 iPhone 发一个唤醒,缩短经 iPhone 的延迟 | Home Assistant、Conduck | 小 |
| 单一主控件 | 一个图标在麦克风 → 发送 → 停止之间形变;双指互点绑在滚动容器之外的稳定控件上 | Conduck、Pinch | 很小 |

---

## 七、iOS / iPadOS / watchOS 27 新特性吸收清单

App 的部署目标是 26.0,下面每一项都放在 `if #available(iOS 27, *)` / `watchOS 27` 之后,26 走现有路径。所有条目都在本机 SDK 里核实过(文件和行号见 `research-sdk27-apis.md`)。27 SDK 大量新 API 标注为 `@available(anyAppleOS 27, *)`,搜索时不要只搜 `iOS 27`。

| 设备 | 新特性 | 用来做什么 | 优先级 |
|---|---|---|---|
| iPhone | `systemPrefersReducedResourceUsage`(SwiftUI 环境、UIKit 特征与通知) | 系统要求省资源时,降低逐词淡入帧率、暂停终端重绘和预取 | P1 |
| iPhone | `isDynamicIslandLimitedInWidth` | 灵动岛变窄时换更短的紧凑布局 | P1 |
| iPhone | `BGTaskScheduler.submitTaskRequest(_:) async`(旧 `submit(_:)` 在 27 弃用) | 后台任务提交不再阻塞,错误都能拿到 | P1 |
| iPhone | `AVAudioSession` 异步激活 / 停用、`didBecomeInactive` 与 `resumptionRecommendation`(旧中断通知 27 弃用) | 朗读和听写前后不再卡主线程,中断处理迁到新通知 | P1 |
| iPhone | Speech `CaptureInputSequenceProvider`、`AnalyzerInputConverter` | 删掉手写的音频抽头和格式转换(旧 `installTap` 27 弃用) | P2 |
| iPhone | `LongRunningIntent.performBackgroundTask` + `ProgressReporter` | Siri / 快捷指令跑的任务不再 30 秒左右被掐断,进度和灵动岛同步 | P1 |
| iPhone、手表 | `IntentSystemContext.isVoiceOnly`、`allowedExecutionTargets`、`RelevantEntities`、`CustomAppIntentErrorConvertible` | Siri 只听不看时给短回答;意图在扩展里执行不拉起 App;正在跑的任务出现在系统建议里;错误对话框更清楚 | P1 |
| iPhone | `toolbarMinimizationBehavior(.onScrollDown)`、`swipeActionsContainer()`、`alert(error:)`、`AsyncImage(request:)`、`dismissalConfirmationDialog` | 流式时给内容让位;非 List 行也能侧滑;带鉴权的图片缩略图;关闭有未发草稿的面板前确认 | P2 |
| iPhone | `withTaskCancellationShield`、MetricKit `MetricManager` | 取消任务时保证落盘和结束实时活动;卡顿和启动诊断补充 `perf.jsonl` | P2 |
| iPhone | WebKit `WKJSHandle`、`WKDOMNodeSnapshot`、`willSubmitForm`、可穿透封闭 shadow root 的内容世界 | 浏览器自动化元素引用跨调用稳定;提交表单前让用户确认 | P2 |
| iPhone | FoundationModels 自定义 `LanguageModel` + `LanguageModelExecutor`;`PrivateCloudComputeLanguageModel`;`SpotlightSearchTool`、`OCRTool` | 先做技术验证:用系统会话 API 统一工具调用、流式和上下文压缩;标题和摘要改用 Apple 私有云模型省用户 token(需要向 Apple 申请受管权限);现成的站内搜索和 OCR 工具 | P2(验证) |
| iPad | `UIWindowScene.closureConfirmation` | 关闭还在跑任务的窗口前,由系统询问 | P1 |
| iPad | `copyable`、`cuttable`、`pasteDestination`、`onCopyCommand`、`onPasteCommand` | 硬件键盘 ⌘C / ⌘V / ⌘X 作用于消息、代码块、输入栏(含图片和文件) | P1 |
| iPad | `visibilityPriority`、`topBarPinnedTrailing`、`toolbarOverflowMenu` | 发送、停止、批准在窄窗口里永远不掉进溢出菜单 | P1 |
| iPad | `presentationPlacement(.leading/.trailing)` | 文件预览、工具详情停靠在聊天侧边,不盖住聊天 | P1 |
| iPad | 菜单与键盘命令的副标题、图标可见性、悬停预览,右键菜单键入选择 | 菜单栏更易发现 | P2 |
| iPad | `defaultTabBarPlacement`、`TabRole.prominent`、`TabContent.help` | 宽窗口默认侧栏;「新任务」突出;指针悬停提示 | P2 |
| iPad | 多项拖放(`dragContainer` 等)、指针立即拖动 | 窗口之间批量拖文件 | P2 |
| iPad | `GestureInputKinds` | 指针点按选中、手指点按打开 | P2 |
| iPad | 场景级 `supportedInterfaceOrientations(for:)`、`UIWindowScene.displayLink`(应用级回调与 `UIScreen` 版 27 弃用) | 每窗口方向和刷新节奏 | P2 |
| 手表 | FoundationModels(watchOS 27 新增;端侧 `SystemLanguageModel` 在手表上不可用) | 用自定义执行器包住现有直连请求,和 iPhone 共用会话、工具与记录代码;可选 Apple 私有云模型 | P2(验证) |
| 手表 | `AVAudioSession.deactivate(options:completionHandler:)` 与新中断通知 | 朗读交接不卡主线程 | P1 |
| 手表 | `systemPrefersReducedResourceUsage` | 系统要求时减少动画和轮询 | P1 |
| 手表 | `isVoiceOnly`、`LongRunningIntent`、`RelevantEntities` | 语音优先的 Siri 回答、较长的手腕任务、运行中任务浮现 | P1 |

手表上**没有**的(规划时绕开):Speech / SpeechAnalyzer(继续用系统听写)、OCR、端侧 `SystemLanguageModel`、BackgroundTasks(头文件在,但全部 `API_UNAVAILABLE(watchos)`)。ActivityKit、WatchConnectivity、WatchKit、TipKit、UserNotifications、Liquid Glass 在 27 没有变化。

27 里要处理的弃用(26 目标下暂不告警,进入 27 分支或抬高目标后会告警):`BGTaskScheduler.submit(_:)`、`UIApplication.canOpenURL`、应用级方向回调、`UIScreen.displayLink`、`AVAudioSession` 中断通知、`AVAudioNode.installTap` 旧签名、`AVAudioEngine.connect` 旧签名、`NSItemProvider` 的旧加载 / 注册方法(分享和拖放)、`PreviewProvider`(改 `#Preview`)、`PHAssetResource.originalFilename`。

---

## 八、明确不做的(防止变胖)

- 不嵌 React Native、Expo、Flutter 运行时去复用别人的界面。
- iPhone 和手表上不用 WebView / iframe 做生成式界面;网页类工具界面(MCP Apps)只放在 Mac。
- 不把「后台播放音频」作为保持运行的主要手段(先测量,再逐步收回)。
- 屏幕操控不默认用视觉优先;无障碍树优先,截图兜底。
- 不在主安装包里打包端侧大模型或重排模型;手表上永远不放。
- 手表不做实时语音对话,不做 WebSocket;不引入第三方实时语音 SDK 作为默认。
- 不做吉祥物、8 bit 音效、硬件小玩具。
- 不上虚拟机 / Docker 式的电脑操控沙箱。
- 不自动过验证码,不做隐身浏览。
- 移动端不做完整代码编辑器,只读预览 + 差异足够。
- 发布版不用 XCTest / WebDriverAgent 跨 App 操控 iPhone。
- 手表上不放 Markdown 渲染库;流式路径上不用基于 JavaScriptCore 的代码高亮。

---

## 九、Mac 中继与 Android(影响手机体验的部分)

- **中继:** 每会话合并增量,最多 60 ms 一条;重连后一次性补齐再继续(在现有 `RelayEventCatchUp` 上收紧);离线发件箱(上限 50,持久重试,界面显示「排队中」);按在场情况分发提醒(最近 180 秒有活动的设备正在看这个会话就不发,否则只给最近活跃的设备发应用内提醒,没人在场才推送,错误不推送);审批选项映射到 Codex app-server 和 ACP;Codex 优先走 `codex app-server`、Claude Code 走 Agent SDK 或 `claude-agent-acp`,终端镜像只做只读兜底;如果中继跑在云服务器上,加端到端负载加密(目前只有 HMAC 令牌);每台设备的权限分级(手表只能读 + 审批)。
- **Mac(leophone):** 已经用上 Streamdown、Shiki、KaTeX,不用再换 Markdown 渲染;从手机发起的自动化默认只在后台操作,要抢前台必须当次授权;托盘里一个面板集中处理所有 CLI 的待审批(⌘↩ 允许一次、Esc 拒绝);MCP Apps 只在 Mac 上、沙箱化、按服务器开启。
- **Android:** `multiplatform-markdown-renderer` 从 0.33.0 升到 0.45.0 并用 `rememberStreamingMarkdownState()`(只重解析尾部);文字选择菜单加「问 LeoPhoneAgent」(`ACTION_PROCESS_TEXT`);Power 版无障碍树优先、操作时显示浮层、多步操作批量执行、改动系统的工具默认「每次询问」。

---

## 十、分阶段路线

每个阶段都是一个可发布的版本:bump 版本号、写「本次更新」、真机安装验证、截图留证。

| 阶段 | 版本 | 范围 | 退出条件 |
|---|---|---|---|
| 1 流畅度底座 | iOS 1.44 | iPhone P0 全部;灵动岛序号与过期;iPad 可调整窗口清理 + 检查器 + 菜单键盘;手表离开 iPhone 的通知审批 + 请求可靠 + 朗读礼仪;中继 60 ms 合并 | 抖动检测 0 次突变;性能预算在最近 10 个会话上通过;中继断开两个心跳后灵动岛显示「已过期」;手表关掉 iPhone 蓝牙和 Wi-Fi 后能审批 |
| 2 清晰与质感 | iOS 1.45 | 工具卡规则、运行状态词汇、审批词汇 + 拒绝并停止 + 授权列表、通知回复、智能批准、形变输入栏、动效触感收口、动态字体;iPad 多窗口、拖放、终端面板、活动查看器、设置分栏;手表一键提问、Smart Stack、审批卡 | 可访问性审计通过;VoiceOver 走通主流程;大字号下无截断;审批在四种运行时映射一致 |
| 3 iOS 27 专项 | iOS 1.46 | 第七节 P1 全部(都在可用性检查之后);FoundationModels 执行器与私有云模型做技术验证,结论写进文档再决定是否上线 | 26 与 27 两套系统真机各跑一遍主流程;27 弃用清单清零 |
| 4 能力 | iOS 1.47+ / Android 同步 | 原生组件目录、浏览器自动化瘦身、密钥不进模型 + 轮到你了、工具按需加载、跨会话回忆 + 存为技能;Android 流式 Markdown 与文字选择入口 | 默认工具数 < 25;首字时间不回退;浏览器任务 token 用量下降 |

---

## 十一、度量与验收

- **数据源:** 现有 `Diagnostics/perf.jsonl`(冷启动分段、回前台首帧、发送到首字、Mac 回执与首字、推送到达、滚动卡顿、主线程卡顿 ≥250 ms)。
- **基线:** 以 1.43.0 在 iPhone 17 Pro Max 上的实测为基线,第一阶段开工前先记录一次。
- **预算(只收紧不放宽):** 流式期间主线程卡顿 ≥250 ms 为 0 次;空闲 3 秒内列表提交 ≤ 2 次;1000 条消息的会话打开到可滚动 ≤ 1 秒;发送到首字不高于基线;后台 1 小时任务的耗电有记录并逐版下降。
- **视觉:** 现有逐帧抖动检测作为「列表不跳」的门禁;iPad 在 13 寸和 mini、竖横屏、台前调度窄窗口各截图一次。
- **反向验证:** 每个新门禁上线前故意破坏一次,确认它会红(仓库发版铁律第三条)。

---

## 十二、风险与未决

- **Apple 私有云模型需要受管权限:** 个人开发者账号能否申请到未知,拿不到就只做自定义执行器那一半。
- **静音音频保活:** 直接拆掉可能让长任务在后台被挂起;先测量,再逐步用持续处理任务和推送替代。
- **中继端到端加密:** 多设备密钥管理是中等工作量;中继在自己的机器上时可以后放。
- **iOS 27 新 API 的真实行为:** 调研只读了 SDK 文件,运行时行为要在真机上验证。
- **FTS5:** 系统 SQLite 在目标系统上是否带 FTS5 未核实,做回忆功能前先验证。
