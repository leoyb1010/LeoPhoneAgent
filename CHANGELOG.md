# LeoPhoneAgent 更新记录

版本号遵循 `主版本.次版本.补丁版本`。1.0 系列的每次常规更新依次递增为
`1.0.1`、`1.0.2`、`1.0.3`……`1.0.12`，同时递增 iOS 构建号。1.1.0
开发期只递增内部 Build，完成全部验收后一次正式发布。

## Android v1.0.0-alpha.4 - 2026-08-16

### 闪退根因

- `LeoVoiceInteractionSession.onShow` 在未关闭会话 UI 时立刻 `startActivity` + `hide()`。系统在升级后探测 `VoiceInteractionService`、或长按 Home / `ACTION_ASSIST` 绑定时会创建会话窗口，和这次抢窗口叠在一起，把主进程打崩。桌面图标、磁贴、小组件、深链都走同一进程，所以表现为「一开就闪退」。
- 助手截图若是 Hardware Bitmap，`compress` 会抛错；ChatScreen 消费截图/包名时也没有兜底。

### 修复

- VoiceInteraction：`setUiEnabled(false)`，`onShow` / `onReady` / 截图保存全部包起来，失败只降级到已有聊天页，不再崩进程。
- 磁贴、小组件、`ACTION_ASSIST`、`minis://` 深链、通知动作、开机/时区全部进同一条 `SystemEntryParser` 路由。
- 进程被杀后，遗留非终态 Run 写成「等待用户继续」，对齐 iOS；用户点了横幅或通知「继续」才恢复，不会偷偷重跑。危险/跨应用操作仍走 Power 版逐次确认。

### 新增

- 桌面小组件改为任务状态面：空闲 / 执行中 / 已暂停 / 已完成 / 需要处理。点状态进对应会话。隐私模式不写标题正文。语音按钮只打开前台 App 再录音。
- 快捷设置：新对话磁贴修稳，并加语音磁贴。设置页仍是原来的一键请求添加。
- App Shortcuts：新对话 / 语音 / 上次会话（去掉写死的 Standard 包名，Power 也能用）。
- 通知按钮：继续 / 暂停 / 打开会话。
- WorkManager 在开机、时区变化、覆盖安装后补登记计划任务；前台服务通知带上同一套动作。
- 设置 → 系统权限收成「系统入口」：默认助手、磁贴、小组件、通知、电池、快捷方式、无障碍，Power 另加 Shizuku 状态。

### 刻意未做

- 通知气泡、画中画、Credential Manager / Passkey、配套设备、NFC、Health Connect、全屏 Intent：仍然没有产品价值。
- 没有新开假日历。Android 已有 `android-calendar` 工具，不在本版另接一套 CalendarContract UI。

### 验证

- 新增 `SystemEntryParserTest`、`AgentRunRecoveryTest`；保留 `AssistIntentsTest`。
- 中文资源门禁与设置页英文硬编码门禁通过。
- Standard / Power JVM 测试各 426，0 失败（各 1 个既有跳过）。双 flavor Debug APK 已 assemble 通过。
- 修掉 alpha.3 起就红的 Release lint：补 `DETECT_SCREEN_CAPTURE`、`AssistState` 标 API 29、磁贴在 API 34 以下仍走旧 `startActivityAndCollapse` 但不再被 lint 判死刑。快捷方式按 Standard / Power 包名拆开。
- 已发布 GitHub Release [`android-v1.0.0-alpha.4`](https://github.com/leoyb1010/LeoPhoneAgent/releases/tag/android-v1.0.0-alpha.4)（tag 打在 `e42add78`）。`aapt`/`apkanalyzer` 复核 versionName `1.0.0-alpha.4`、versionCode `100004`，包名分别为 `com.leoyuan.leophoneagent` / `com.leoyuan.leophoneagent.power`，仅 ARM64，双包均通过 APK Signature Scheme v2。
- SHA-256：Standard `7215aaee2c2f1c1731d1e906df11f1aa3b5067cecc89d0dbc808222e8248b285`；Power `1c6d352a34c720a3ba025299b8df190596677893d5249f3768c4eeb86961061c`。

## Android v1.0.0-alpha.3 - 2026-08-16

### 新增

- 可替换系统数字助手：`ROLE_ASSISTANT` + `VoiceInteractionService` + `ACTION_ASSIST`。长按 Home / 助手手势打开新对话，并带上当前 App 包名与可选截图。
- 快捷设置磁贴：从状态栏下拉直接开新对话；设置页可一键请求添加。
- 桌面小组件：新建对话 / 语音对话，复用现有 `minis://action/` 深链。
- 设置 → 系统权限：默认助手、磁贴、小组件入口（此前该页未挂到设置）。
- 截屏/录屏提示（Android 14+）：聊天界面被系统截取时给出提示。
- 预测性返回：`enableOnBackInvokedCallback`。
- 原生库按 16KB 页大小对齐（`ANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES`）。

### 已有并保留

- 悬浮窗、Android 16 Live Updates / 状态胶囊、前台服务、忽略电池优化、精确闹钟、边到边、照片选择器、分屏/折叠双栏、应用内语言、分享入口。

### 刻意未做

- 通知气泡、画中画、Credential Manager / Passkey、配套设备、NFC、全屏 Intent、Health Connect：对单用户本机 Agent 没有真实产品价值，或会与现有悬浮窗/灵动岛抢表面。

### 验证

- 新增 `AssistIntentsTest` 6/6 通过；中文资源门禁通过；Standard/Power Release APK 已用 JDK 17 组装，`aapt` 复核 versionCode `100003`，双包均通过 APK Signature Scheme v2。

## Android v1.0.0-alpha.2 - 2026-08-16

### 修复

- xAI OAuth 改用官方 RFC 8628 设备码流程：App 显示短码、复制入口和 xAI 验证页，并在后台自动轮询完成登录。
- 不再依赖 Android 浏览器对 `127.0.0.1:56121` 的回调，避免授权页要求把 Grok Build 长码粘回客户端、但 App 没有输入口的死路。
- xAI 授权网址严格限制为 HTTPS `x.ai` 官方域名；用户码、设备码和 Token 不记入日志。

### 新增

- Android“我的 Mac”任务区新增 Codex、Claude Code、Cursor、Grok 四个快捷选择。
- leocodebox 远程 harness 新增 Cursor Agent，通过官方 `cursor-agent -p --output-format stream-json` 无头协议启动 Mac 端任务。

### 验证

- xAI 真实设备授权端点已验证返回短码、`accounts.x.ai` 完整验证链接、1800 秒有效期与 5 秒轮询间隔（证据全部脱敏）。
- `XAIDeviceFlowTest` 与 Kimi 设备码回归测试通过；Standard Debug Kotlin/Compose 编译通过。
- Cursor CLI 可执行文件与版本已检出；当 Mac 尚未登录 Cursor 时会明确返回需先执行 `cursor-agent login`，不会假报任务成功。
- Standard/Power Release APK 已在 JDK 17 下构建成功，版本号与包名已用 `aapt` 复核，两包均通过 APK Signature Scheme v2 签名校验。

## Android v1.0.0-alpha.1 - 2026-08-16

首个 LeoPhoneAgent Android 双版本个人 Alpha 交付。

### 新增

- Standard 与 Power 两个独立包，可同时安装、独立保存数据。
- 本机 Agent、模型服务商、Skills、MCP、Memory、PRoot Linux 沙箱、终端、浏览器、语音、计划任务和 Mac Relay/Fleet 协同。
- Power 版新增无障碍与 Shizuku 深度 Android 操控路径；危险 shell/破坏性操作逐次展示完整命令并确认。
- Fold8 宽折叠适配：封面单栏、展开双栏、跨尺寸草稿保留和 200% 字体布局。
- 简体中文设置、列表、功能按钮、弹窗、错误提示和主操作 TalkBack 标签。
- Android CI、中文资源门禁、设置页英文硬编码门禁、双版本 lint 与测试。

### 安全与隐私

- 凭据存储不再在 Keystore 异常时降级成明文；失败时只保留进程内临时数据。
- OAuth callback 仅监听 loopback，不记录 code/state，并强制校验 state。
- Debug RPC 仅 Debug 构建启用、仅监听 loopback，并要求每安装随机令牌。
- Release 关闭普通明文 HTTP 与系统备份；拆分并收紧 Alarm/Boot Receiver。
- 无障碍文字只在主动监听期间采集并忽略密码字段；分享内容增加数量与大小上限。
- APK 内置 GPL、第三方许可、隐私说明和源码提供说明；Alpine/PRoot 下载增加固定 SHA-256 校验。

### 验证与下载

- Standard/Power 各 401 个 JVM 测试，0 失败（各 1 个既有跳过）。
- Fold8 API 35 设备端 111 个测试，0 失败、0 跳过；双 Release lint 均为 0 error。
- 无令牌 Debug RPC 返回 401，合法令牌返回 200。
- 两个最终 Release APK 已覆盖安装并同时运行，无启动崩溃。
- [GitHub Release 与 APK](https://github.com/leoyb1010/LeoPhoneAgent/releases/tag/android-v1.0.0-alpha.1)
- [完整五轮审计与交付报告](docs/ANDROID_DELIVERY_1.0.0_ALPHA1.md)

### 已知边界

- 当前仅提供 ARM64 APK。
- 本次附件使用个人 Alpha 调试证书签名，不是正式商店证书链；切换正式签名版时可能需要先卸载 Alpha。
- 正式公开发行前仍需完成真实 Fold8 物理机长稳/功耗测试、数据库全版本升级 fixture、商店隐私表单和发行 keystore 托管。

## 1.1.2 - 2026-07-26

- 修复 1.1.1 只补齐语言目录、但没有覆盖部分动态控件真实渲染路径的问题。
- Token 数字不再由代码固定缩写为 `K/k/M`，改用当前 App Locale 的系统紧凑数字格式；简体中文显示完整数字或“万”，繁体中文显示完整数字或“萬”。
- 对话输入区上方的内置快捷任务使用稳定 ID 匹配本地化显示名；用户编辑过的内置任务和自定义任务继续显示用户原名。
- Token 用量摘要中的上下文、输入、输出、缓存和输出速度文字随语言变化，`Token` 术语保持不翻译。
- 设备偏好实测为 `appLanguage = zh-Hans`，确认问题来自动态字符串与硬编码格式器，而不是用户语言设置。

## 1.1.1 - 2026-07-26

- 版本统一更新为 1.1.1（24），作为 1.1.0 后的首个补丁版本。
- 使用 Xcode String Catalog 重新提取全部用户界面文本，补齐快捷任务、输入快捷操作、对话框按钮、任务状态、任务产出和设置页此前遗漏的本地化。
- 德语、法语、日语、韩语、俄语、简体中文和繁体中文缺失项归零；格式占位符和 String Catalog 编译检查通过。
- `Token` 在所有语言中保持为 `Token`，中文统一使用“Token 用量”“输出 Token”等表达，不翻译为“词元”。
- 对中文高频入口进行人工校准，修正 Composer、Artifact、Quick Task 等上下文直译，统一为“输入区”“任务产出”“快捷任务”。
- 新增可重复运行的本地化同步与审计脚本，默认只读检查，防止后续版本再次出现语言遗漏或格式参数损坏。

## 1.1.0 - 2026-07-26

### Build 23 · 正式版

- 正式版本统一为 1.1.0（23），主 App、Tests、Share、Files 与 Widget 配置一致。
- 新增 1.1.0“本次更新”内容；升级后强制展示一次，确认后不重复打扰，并永久保留在“设置 → 关于 → 更新记录”。
- 全新目录生成正式签名 Archive；arm64、Team `48H5Y3LNUK`、主包及三个扩展的版本、Bundle ID、Entitlements 与签名校验全部通过。
- 最终版已覆盖安装到 iPhone 17 Pro Max 并成功启动，设备回读 1.1.0（23），主 App 与 Widget Extension 均在运行。
- 安装后真实数据库复核为 Schema v3，升级前后的 3 个会话与 16 条消息保持不变，临时审计副本已删除。

### Build 22

- 使用在线 iPhone 的 1.0.12 Build 13 私有数据库副本完成真实迁移演练；Schema v0 → v3、完整性、外键、行数保持与二次幂等检查均通过，设备原数据未改动，临时副本已删除。
- 全量 Schema、Artifact、Quick Task、动效/触感 smoke 与审计再次通过；Tests Bundle 在 iOS 26.5 Simulator 成功编译签名，Xcode runner 未启动 Test Case 的中断不计为测试通过。
- 面向用户的名称、包名、App Group、iCloud Container、URL Scheme 与签名均复核为 LeoPhoneAgent / `com.leoyuan.leophoneagent.*` / Team `48H5Y3LNUK`。
- 本地网络权限提示改为 LeoPhoneAgent 自有且面向用户的安全 Shell/连接服务说明，移除 VM/SLIRP 工程措辞并同步 7 种语言。
- iOS 26 Continued Processing 动态通配标识按 Apple 官方规则复核通过；连接真机目标的 Release 构建及主 App、Share、Files、Widget 扩展签名验证全部成功。
- 内部 Build 统一升至 22；正式版本号仍保持 1.0.12，本检查点没有安装到手机。

### Build 21

- LeoHaptics 成为全项目唯一触感入口，发送、完成、快捷动作、拖拽与恢复反馈统一受“外观 → 触感反馈”开关控制；不影响系统与键盘触感。
- 首页搜索与 FAB、Composer 文本/语音切换、状态卡等关键过渡开始复用 LeoMotion，并在系统 Reduce Motion 开启时即时切换或只保留淡入淡出。
- 首页同步旋转、聊天加载点、工具 Shimmer 与流式跳点、思考提示、浏览器下载脉冲及语音波纹均加入 Reduce Motion 静态降级；不再无条件常驻运动。
- Composer 的附件、命令、发送和个人任务快捷动作补齐 VoiceOver 名称与操作提示；等待授权、等待用户、挂起、完成、失败及取消状态采用低频 VoiceOver 公告。
- 新增 `IOSAccessibilityMotionAudit.sh`，阻止业务代码绕过 LeoHaptics，并要求所有重复动画文件包含 Reduce Motion 闸门。
- 自动动效/触感审计、QuickTask smoke、MinisTests Bundle 编译和完整 iOS arm64 App 构建均成功；未安装到手机。

### Build 20

- Quick Tasks 新增 Composer 固定区，默认选择前三个内置任务，用户可在设置中自由组合且最多固定三个；删除自定义任务会同步清理失效引用。
- 聊天 Composer 使用原生横向快捷动作，在不改变稳定输入栏结构、AnyView 擦除和高度校正链路的前提下，一键准备模板 Prompt 与输出约束。
- 首次空会话首页复用相同的个人快捷任务，点击后通过既有 Quick Action 状态机创建新会话并填入模板，避免延时跳转和重复投递。
- 会话首页新增紧凑、标准、舒展三档密度，只调整列表间距与图标尺寸，不覆盖字号和系统无障碍设置。
- 新任务运行策略支持 Standard 与 Background Ready；后者在发送时启用现有增强后台、Live Activity 和任务通知路径，且界面明确说明后台时长仍由 iOS 与当前 Keep-Alive 能力决定。
- 发送按钮长按可对单次任务选择 Standard 或 Background Ready，不改变全局默认值。
- Composer 固定项的默认值、三项上限、持久化、去重和删除清理已加入测试与 smoke runner；完整 iOS arm64 App 构建成功，未安装到手机。

### Build 19

- 现有可编辑 Quick Tasks 升级为个人任务模板，保留 1.0.12 AppEntity 稳定标识和旧 AppEnum 兼容入口。
- Prompt 支持 `{{topic}}` 形式的输入槽位，自动去重并在编辑器显示；Shortcuts 可使用每行 `name=value` 为槽位传值。
- 每个模板可选自动、精简文本、Markdown、JSON 或保存 Artifact 五种结果约束，执行时作为明确输出契约追加到 Prompt。
- 模板可导出为 `.leotask.json` 本地文件，导入时生成新的自定义标识，不覆盖原模板或破坏已有 Shortcuts。
- `SendPromptResult` 新增输出模式和 Artifact 文件名数组；发送、追问、重试与快捷任务在等待完成时均返回会话产物，方便下一个 Shortcut Action 消费。
- 旧 v1 存储 JSON 缺少新字段时自动使用 `automatic`，不会丢失现有自定义任务。
- 模板独立 smoke runner 通过，测试 Bundle 编译链接成功，完整 iOS arm64 App 构建成功；未安装到手机。

### Build 18

- Artifact 接入现有 CloudKit V2 共享区：`ArtifactV2` 同步元数据和回收站状态，`ArtifactVersionV2` 以 CKAsset 同步不可变版本文件。
- Artifact 云同步作为独立分类默认关闭，需在 iCloud Sync 设置中明确开启；开启时才分批标记现有成果。
- 默认单个 Artifact 云版本上限为 25 MB，可选 1/5/25/100 MB；超限版本保留在本机，不进入 CKAsset 上传队列。
- 下载的 CKAsset 必须同时通过文件大小和 SHA-256 校验，再原子复制到本机受控目录；CloudKit 临时文件不会被持有。
- 远端合并不反向产生本地脏记录；回收站是可恢复状态，永久删除才为 Artifact 和其版本发送 tombstone，并阻止删除窗口期内的旧记录复活。
- Artifact/Schema smoke 通过，测试 Bundle 编译链接成功，完整 iOS arm64 App 构建成功；没有安装到手机，也没有开启用户的 Artifact 云同步。

### Build 17

- 任务通过 `file_write`、`file_edit` 或 shell 在会话 workspace 生成的用户成果，现在会自动进入该会话的 Artifact Tray。
- Artifact 记录同时保留原始 Files 路径和来源聊天消息；移入回收站或永久删除 Artifact 不会改动原始 workspace 文件。
- 同一会话、同一源路径使用 SHA-256 去重：内容未变时不重复创建，内容变化时追加不可变版本。
- Artifact Tray 新增版本历史，可查看源路径、版本号、时间与大小，并对任意历史版本使用 Quick Look 或系统分享。
- 自动收录仅针对 `/var/minis/workspace/` 中的用户成果，单文件上限 100 MB，不收录内部中间文件。
- Schema Contract 升级至 v3；Schema 与 Artifact smoke 通过，测试 Bundle 编译链接成功，完整 iOS arm64 App 构建成功；未安装到手机。

### Build 16

- 每个聊天的更多菜单新增 Artifacts 入口，按会话展示任务生成的本地成果。
- 新增原生 Artifact Tray，完整覆盖加载、空内容、错误、正常列表与回收站状态。
- 成果支持系统 Quick Look 预览、系统分享、下拉刷新、移入回收站、恢复与永久删除。
- 列表使用动态字体、组合式 VoiceOver 标签与系统深浅色；列表变化动画遵循“减少动态效果”。
- 本阶段只消费 Build 15 的本地数据，不创建成果、不改变聊天消息引用，也不写入 CloudKit。
- 测试 Bundle 编译链接成功，完整 iOS arm64 App 构建成功；未覆盖安装手机上的 1.0.12 稳定版。

### Build 15

- 新增设备本地 Artifact 数据模型，统一文档、图片、音频、视频、代码、压缩包与普通文件成果。
- 每个成果支持不可变版本记录、当前版本指针、SHA-256 完整性摘要与安全的相对路径存储。
- 文件先写入独立 staging 目录，再与 SQLite 事务协同提交；失败时清理临时文件并回滚数据库。
- 新增软删除、恢复与永久清理生命周期，文件名和读取路径均进行越界防护。
- Schema Contract 升级至 v2，并以幂等迁移创建 Artifact 表与索引；本阶段尚未开启 CloudKit 写入。
- 本地生命周期 smoke runner、Schema runner 均通过，测试 Bundle 编译链接成功，完整 iOS arm64 App 构建成功。

### Build 14

- 新增由生产 ChatStore 启动路径直接调用的版本化 Schema Contract，为后续 Artifact 数据迁移建立安全门。
- 核心会话、消息与压缩标记表支持事务式幂等修复，并记录独立 contract version。
- 旧消息迁移会保留原行，补齐 `updated_at`，并从 `parts_json` 回填本地 `part_flags`。
- 新增四组 XCTest 契约用例和可在 macOS 直接执行的 SQLite smoke runner。
- 独立 smoke runner 4/4 通过，测试 Bundle 编译链接成功，完整 iOS arm64 App 构建成功。
- iOS Simulator 测试 runner 仍卡在 `waiting for workers to materialize`，未将中断执行记为 XCTest 通过。

## 1.0.12 - 2026-07-26

- 快捷任务主入口从硬编码 AppEnum 升级为可扩展 AppEntity，Siri 与快捷指令可动态读取任务库。
- 设置新增“快捷任务”管理页，可创建、编辑、排序和删除自定义任务，并可恢复八个内置任务。
- 八个内置任务使用稳定标识；1.0.11 及更早版本保存的 AppEnum 快捷指令继续由兼容入口执行。
- 快捷任务名称、提示词或图标变化后会刷新系统快捷指令参数。
- 新增任务标识、存储归一化和自定义任务生命周期契约测试；主 App 与独立测试 Bundle 编译链接成功。

## 1.0.11 - 2026-07-26

- `isProcessing.didSet` 缩减为 `_deinitSnapshot` 更新和显式转移分发。
- 新增 `handleProcessingStarted()`，按原顺序管理云同步延迟、旧 post-stop hold 清理与 StreamingHangLogger。
- 新增 `handleProcessingStopped()`，按原顺序管理 post-stop hold、卡顿监控释放、安全快照、离屏通知与技能刷新。
- 保留后台/挂起/会话切换时禁止同步重建大型视图的 0x8BADF00D 防护。
- 通用 iOS 主 App 与独立逻辑测试 Bundle 编译链接成功。

## 1.0.10 - 2026-07-26

- 新增可单测的 `AgentProcessingTransition`，明确区分 `.started`、`.stopped` 和 `.unchanged`。
- `isProcessing.didSet` 改为消费显式边沿转移，不再把布尔组合散落在副作用入口。
- 保持 iCloud 延迟、post-stop hold、卡顿监控、前台快照、离屏通知和技能刷新等原执行顺序不变。
- 增加 `false→true`、`true→false` 与两种重复赋值的纯逻辑契约测试。
- 通用 iOS 主 App 与独立逻辑测试 Bundle 编译链接成功。

## 1.0.9 - 2026-07-26

- 新增仅设备本地的 `agent_run_state`，原子保存 Run、会话、开始/更新时间、阶段、工具名和隐私安全原因码。
- 首次打开进程时，将上一进程遗留的非终态 Run 转为“等待用户继续”，不会自动恢复执行。
- 会话加载与启动徽章对账同时读取持久 Run 状态，覆盖流式文本中途被 iOS 终止时消息尾部启发式无法识别的盲区。
- 新任务会终结同会话被取代的旧 Run，避免过期的暂停标记在后续重新出现。
- 增加意外终止恢复纯逻辑测试；主 App 与测试 Bundle 编译成功，迁移/恢复/取代 SQL 已独立验证。

## 1.0.8 - 2026-07-26

- 将外观设置支持组件从 5000 余行的 `ContentView.swift` 纯移动到独立设置文件。
- 将首页同步状态动画与强制同步提示条纯移动到独立状态组件文件。
- 保持现有界面、交互、文案和动画行为不变，先降低后续状态机与任务控制台升级的耦合风险。
- Xcode 工程引用、通用 iOS 构建与独立逻辑测试 Bundle 编译均通过。

## 1.0.7 - 2026-07-26

- 新增 Apple Capabilities 能力中心，集中展示原生能力、系统授权状态、可执行动作、示例和数据去向。
- 授权探针只读查询，不会因为打开页面而主动弹出系统权限请求。
- Provider 新增“测试并保存”流程：保存前先拉取模型并完成一次真实请求，失败时可明确选择仍然保存。
- 自动日志进一步移除提示词、回复正文、工具参数、OAuth Token 片段、通知标题和浏览网址。
- 明确 HomeKit、HealthKit 和后台持续执行等系统边界，不承诺 iOS 不允许的无限后台运行。

## 1.0.6 - 2026-07-26

- 新增小号和中号主屏幕任务组件，通过 App Group 共享隐私安全的任务快照。
- 中号组件新增语音入口，打开 App 后直接创建对话并启动语音输入。
- iOS 26 接入 `BGContinuedProcessingTask`，为用户启动的长 Agent 任务提供锁屏后持续处理与系统进度。
- 持续处理被系统撤销时进入暂停、取消当前命令和可恢复链路。
- 后台状态日志改为纯元数据，不再记录工具错误原文、输出预览、工具描述和完整浏览 URL。
- 调试协议、挂起检测线程和存储空状态继续清理旧产品名称，内部兼容路径与 GPL 法定来源保留。
- 新增 iOS 系统能力与后台执行审计文档。

## 1.0.5 - 2026-07-26

- FFmpeg 框架新增进程内协作取消入口，通过原生清理路径停止转码。
- FFmpeg 工作线程以 50ms 周期响应任务取消，串行锁等待同样可中断。
- 取消的转码返回标准状态 130，不向客户端注册未完成结果。
- 移除完整 FFmpeg 参数日志，避免暴露媒体路径和文件名。

## 1.0.4 — 2026-07-26

- 将停止信号从 shell 会话传入 iSH 原生代理执行层。
- 原生能力的同步等待改为可协作取消的短周期检查。
- 取消后不再注册未完成的文件结果，并返回标准取消状态。
- 重编 iSH ARM64 静态库，保持 iPhone 真机签名链路。

## 1.0.3 — 2026-07-26

- Activity 失败终态新增隐私安全的原因码，不保存服务商错误原文。
- 统一聊天错误、活动时间线与中断恢复动作，支持重试、继续和检查 Provider。
- 本地 Linux 环境启动失败页新增直接重试入口。
- 进一步清理诊断日志中的模型错误正文、工具错误片段与 Provider 响应细节。
- 新增失败原因分类与恢复策略纯逻辑测试。

## 1.0.2 — 2026-07-26

- 浏览器加载、JavaScript、截图、文本提取和 DOM 等待统一接入即时取消。
- 并发工具无论因用户还是系统取消，都会生成配对的取消结果。
- 有排队消息时，停止操作明确区分“继续队列”和“停止全部并清空队列”。
- 可分享诊断日志只记录结构化元数据，不再记录提示词、回复或工具内容预览；隐私模式也会遮盖日志中的已知环境变量值。
- 新增队列停止策略纯逻辑测试。

## 1.0.1 — 2026-07-26

- 新增聊天实时状态卡与设备本地活动时间线。
- 权限请求明确展示访问内容和数据去向。
- 增加等待授权、浏览器接管、后台超时和并发限制等安全原因提示。
- 统一 iOS 视觉层级、动效、触觉反馈与“减少动态效果”适配。
- 完成 LeoPhoneAgent 独立签名、隐私声明、快捷指令和服务商配置加固。
- 新增升级后“本次更新”提示和“设置 → 关于 → 更新记录”。

## 1.0 — 2026-07-26

- 建立 LeoPhoneAgent 独立 iOS 产品基础版本。
- 支持对话、工具调用、本地工作区与多个 AI 服务商。
