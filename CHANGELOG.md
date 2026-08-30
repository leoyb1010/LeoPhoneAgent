# LeoPhoneAgent 更新记录

版本号遵循 `主版本.次版本.补丁版本`。1.0 系列的每次常规更新依次递增为
`1.0.1`、`1.0.2`、`1.0.3`……`1.0.12`，同时递增 iOS 构建号。1.1.0
开发期只递增内部 Build，完成全部验收后一次正式发布。

## 藏宝阁 Phase 5 源码交付（未发版）- 2026-08-31

### 用户可见源码变化

- iOS Agent 补齐 `treasury_save` / `treasury_update`，支持 link、text、note、聊天 Artifact 保存，以及标题、标签、合集、置顶、归档、阅读状态和批注更新；永久删除仍走独立高风险确认。
- Mac 新增四种 Provider 共用的 `leocodebox-treasury` MCP，统一提供 search/get/save/update；本机与手机缓存可搜索、受控读取和引用。
- Mac 藏宝阁补齐六视图键盘导航、tab/tabpanel、加载/错误 live region、详情焦点和删除高亮确认。
- 远端正文缓存写入和读取都校验 MIME、byte count 与 SHA-256；同 ID 跨 Relay scope 去重并选择最新内容。
- Android Agent 契约完成跨端对齐：search 支持内容类型、标签、来源、合集、日期、阅读状态和归档筛选，get 使用统一复数批注参数，save/update 支持合集并拒绝非法筛选扩大查询。
- iOS Share Extension 优先保留图片和文件原始字节，暂存成功后才登记附件；Spotlight 只索引标题、来源和标签，不再索引正文、原始 URL 或摘要。
- 三端 `treasury_search` / `treasury_get` 上限与 envelope 再次对齐：search 明确顶层 `truncated`，get 统一最多 100 个 ID、单条 50,000 字正文，并对非法 kind、阅读状态和时间区间失败关闭。
- iOS 合集过滤不再在 500 条后丢成员关系，正文 FTS 候选不再在 200 条后漏掉合法结果；Mac 结构化过滤在 SQL 截断前执行；Android FTS 在 LIMIT 前按加权相关度排序。
- 三端 `treasury_get` 在正文后部存在标题/摘要/标签/批注命中时返回相关窗口，不再只给开头；emoji 截断保持有效 Unicode。
- iOS、Android、Mac 详情补齐可解释相关收藏，并排除“文本/文件/图片”等通用来源造成的伪关联。
- 后台网页增强不再覆盖用户刚修改的标题；五次自动失败后停止，用户显式重试会重置持久任务。Mac PDF 重试额外复核受控路径、文件类型、byte count 和 SHA-256。
- iOS 主 App 现在实际执行持久网页/OCR/PDF/音频/索引任务；三端设置页分开显示原始内容和可再生/可重新下载缓存，清理不删除收藏、正文、批注或原始附件。
- Android 只清理受控 `treasury/sync-outbox`；Mac 正文缓存与附件缓存可独立清理，`treasury/files` 原始文件保持只读。三端均补符号链接/路径边界与失败恢复测试。

### 三轮最终审计与验证

- 第一轮修复 iOS 工具闭环、note 正文、Artifact kind、URL 去重和 JSON fallback 合集更新。
- 第二轮修复 Mac 写审批边界、MCP token 存储、错误脱敏、归档搜索、跨 scope 去重和正文缓存完整性。
- 第三轮修复 Mac 键盘/读屏语义、详情焦点、加载空态和测试落盘位置，并完成真实 production browser 宽/窄窗口走查。
- 完成定义复审继续修复 Android 工具契约分叉、非法筛选静默放宽、iOS Spotlight 摘要泄漏和 Share Extension 假成功/有损转码，并补回归测试。
- 契约完成度三轮复审继续修复 iOS 200/500 条候选截断、Mac 500 条后二次过滤漏项与非法日历日期、Android 在相关度排序前按更新时间截断，并增加超过 200/500 条的大库回归。
- 追加三轮恢复审计修复相关来源误判、iOS sheet 动画竞态、三端持久重试、Mac PDF 重试完整性、UTF-16 截断、TypeScript 窄类型和 Tailwind 零警告门禁。
- 存储治理三轮审计修复 iOS 持久任务执行断链、Android Compose 后台状态提交与路径逃逸、Mac 原始/正文/附件删除边界、零字节/缺失文件残留、确认弹窗和错误本地化。
- iOS Treasury 全量纳入 MinisLogicTests 320/320，MinisShare direct target build 通过；Android Standard/Power 各 615 tests（0 failed、1 skipped）且双 lint 0 error；Mac desktop 37/37、client 166/166、server 404/404、typecheck、全仓 lint 和 production build 通过。

### 边界

- 本条是 Phase 0–5 源码交付，不 bump 版本，不发布 APK、IPA、DMG 或热更新。
- Mac 写工具必须经过 Provider 客户端审批并携带 `user_confirmed=true`；MCP 服务不能独立读取 CLI 原始用户消息。iOS/Android 另有当前真实用户消息校验。
- HTTP Range 未实现；iPhone/iPad 主 App、API 26/Fold8/TalkBack/200% 字体、三设备联网、签名、覆盖安装、Mac 新存储页登录后走查/双机 Relay/屏幕阅读器/公证仍为 HOLD。
- 完整证据见 `docs/TREASURY_PHASE5_DELIVERY_EVIDENCE.md`，设备执行见 `docs/TREASURY_DEVICE_RELEASE_CHECKLIST.md`。

## 藏宝阁 Phase 4 源码交付（未发版）- 2026-08-31

### 用户可见源码变化

- iOS、Android、Mac 使用游标增量 changes，不再同步“前 500 条”整体快照；重复、乱序、删除、冲突和游标过期均有恢复路径。
- 正文和附件与元数据分离，默认按需获取并校验大小、SHA-256、MIME 和路径；Mac 离线保留最后成功内容并标记陈旧。
- Mac 藏宝阁升级为三栏主动工作台，可本机捕获、搜索、阅读、指定合集离线，并选择仅本机、元数据或元数据+正文同步范围。
- Mac 本机与手机收藏均可安全引用到新对话，正文有 20,000 字预算、截断标记和不可信资料边界。

### 三轮审计与验证

- 第一轮修复 Mac 本机条目引用缺口、长正文预算、资料边界闭合和项目选择衔接。
- 第二轮修复 Artifact 正文/附件声明、Relay/Mac MIME 允许列表与 mismatch 拒绝、iOS SQLite statement 生命周期。
- 第三轮修复 iOS 毫秒冲突精度、410 快照时间截断和 Mac 同步范围控制。
- Android Standard/Power 编译和 JVM 单测通过，双 lint 0 error；iOS MinisLogicTests 304/304 与 MinisShare target build 通过；Relay 12/12；Mac client 160/160、server 392/392、typecheck、production build 和真实浏览器主要交互通过。

### 边界

- 本条是源码交付，不 bump 版本、不发布 APK/IPA/Mac 包。
- 当前附件是完整文件失败重试和原子落盘，没有 HTTP Range 断点续传，不虚报该能力。
- 三设备真实联网矩阵、Fold8/API 26/TalkBack/200% 字体、iPhone/iPad 主 App、移动签名/覆盖安装、Mac 双机 Relay/签名/公证仍为 HOLD。

## 藏宝阁 Phase 3 源码交付（未发版）- 2026-08-31

### 用户可见源码变化

- iOS、Android、Mac 藏宝阁增加收件箱、处理中、失败、待读、最近使用、阅读状态、阅读进度、定位高亮、批注和精确筛选。
- Android/iOS 在后台离线逐页提取 PDF，Mac 使用可恢复的持久 PDF 作业；失败不会删除原始附件，搜索结果可返回页级命中片段。
- 三端长正文阅读改为有界渲染；Android Fold 状态和 Mac 快速搜索竞态得到修复。

### 三轮审计与验证

- 第一轮修复高亮事务、阅读状态矛盾、iOS 正文落盘状态、Mac FTS/PDF 作业完整性。
- 第二轮修复 iOS 网页 SSRF/重定向/子资源边界、正文路径穿越、Android Agent 提示注入授权和 Mac 查询竞态/命中来源。
- 第三轮修复长正文渲染、Android 滚动状态、Mac 重复镜像请求和 PDFBox 传递许可。
- Android Standard/Power 编译、JVM tests、instrumentation 源码编译和 lint 通过（0 lint error）；iOS MinisLogicTests 301/301、MinisShare build 和 ArticleExtractor typecheck 通过；Mac typecheck、385/385 server tests 和 production build 通过。

### 边界

- 本条是源码交付，不 bump 版本、不发布 APK/IPA/Mac 包。
- Fold8、API 26、TalkBack、200% 字体、移动端签名/覆盖安装、iPhone/iPad 主 App、Mac 真实窗口/签名/公证仍为 HOLD。
- Phase 4 游标增量同步、正文/附件按需同步和跨端冲突尚未完成；可选音频转写与语义召回/RRF 未启用。

<a id="t12-alpha23"></a>
## T12 · iOS 1.30.1 (105) / Android 1.0.0-alpha.23 / Mac 1.80.0 - 2026-08-30

### 用户可见

- iOS 与 Android 撤销 alpha.22 的自定义 Grok CLI 代理实验，恢复 OpenMinis 已验证的 OAuth/对话路径；完整模型目录始终可见，包含 Grok 4.6、4.5、Composer 2.5 与快速/代码变体。
- Mac 主控台新增可见的 CodexHost 0.3.5 工作台卡片，明确展示就绪状态、可接入 Harness、原生能力和两个真实入口；不再把仅内置载荷描述成已经完成的产品改造。
- Mac Grok Build 模型目录改为读取官方 `grok models`，并保留 4.6/4.5/Composer 2.5 离线底座；1.80 首启会定向失效旧模型缓存。
- Android Fold8 封面 200% 字体下的更新说明改为两级标题、可滚动正文和始终可见的确认按钮；iOS 审批动效遵循系统“减少动态效果”。

### 两轮审计与修复

- 第一轮覆盖能力、产品结构、OAuth 边界、Provider 工厂一致性、缓存、签名和三端构建：修复移动端错误代理、iOS 两套工厂行为不一致、在线目录失败时模型列表缩水/重复崩溃、Mac Grok 旧静态目录和 CodexHost 隐藏入口。
- 第二轮覆盖设计、UI、动效、Fold8/iPad/macOS 布局、中文语义与可访问性：修复 Android 大字体弹窗裁切、Mac Harness 芯片被误读为已安装、iOS 审批转场忽略 Reduce Motion。
- 最终产物实测又发现 Mac 仍可能命中 1.79 三天旧缓存；加入 Grok 目录指纹后，安装 1.80 首次请求立即返回 4.6/4.5/Composer 2.5。

### 已执行验证

- Android：JDK 17 下 Standard/Power 编译、各 585 项单测（0 失败、各 1 跳过）、双 lint（0 error）、双 Release 构建通过；补齐 Gradle 8.13 lint 与 debug 资产生产任务的显式依赖。
- Android 固定 Alpha 签名、包名、versionCode `100023`、versionName `1.0.0-alpha.23` / `1.0.0-alpha.23-power` 与能力隔离通过。SHA-256：Standard `1b38a978647481afb2aca7a5830c515b3129dbc01d33784105d4a542c8837898`；Power `867edbfe1ce9c87a032b4aa9a189e3644cfdeaaec7a186f8166cdafee6997bb5`。
- Fold8 API 35 模拟器：alpha.22 → alpha.23 覆盖安装已通过；最终 Release 两包再次覆盖安装，冷启动、`ACTION_ASSIST`、PID 与 AndroidRuntime 通过。1080×1728 封面大字体更新弹窗 UI 树无越界。
- iOS/iPad：iPhone 17 Pro 与 iPad Pro 13″ 模拟器完成真实安装、冷启动、通知授权、更新页、iPhone 独立工作区及 iPad 横屏双栏截图验证；两端进程持续存活，目标日志中 SwiftUI 视图更新发布警告与重复数据库迁移错误均为 0。
- iOS `MinisLogicTests` 实际执行 271 项、0 失败；`IOSReleaseReadinessAudit`、动效/无障碍审计、可见控件审计和 `generic/platform=iOS` 无签名真机构建通过。修复 SkillStore `use_count` 重复迁移、SyncV2 getter 写偏好及 SessionLockStore 对全套 UserDefaults 无差别刷 UI。真机安装仍由用户执行。
- Mac：typecheck、lint、0 漏洞 npm audit、生产构建和 565 项测试通过；Developer ID 签名链、36 个嵌套 Mach-O、CodexHost 0.3.5、本机 1.80 后端、动态 Grok 目录均通过。DMG SHA-256 `585f2d86276032e7c8d1c36287c5d2f51dd22e2017cdf396a3c369150b6ae6e1`；ZIP SHA-256 `76cabb658eecb61bb4e24c58d865ee7ddbc204435919388f64a38bb7e1f48e64`。

### 边界

- 本机 Developer ID 私钥与 GitHub 热更新权限均可用，Mac 1.80 的 DMG/ZIP/`latest-mac.yml` 已发布且本机后端正在运行 1.80.0；安全枚举钥匙串并实测 `notarytool history --keychain-profile leocodebox` 后确认公证 profile 当前不存在，所以 Gatekeeper 仍报告 `Unnotarized Developer ID`。
- 本地没有可用于移动端的真实 Grok OAuth 账号会话；已验证的是 OpenMinis 路径对齐、模型目录、单测与构建，账号级真实对话仍需用户在 Android/iPhone 实机确认。

## Mac 1.79.0 · CodexHost 原生 Harness 工作台 - 2026-08-30

### 用户可见

- 随包内置 BytePioneer-AI/codex-host 0.3.5 官方完整载荷；在「设置 → Agent → 本机智能体」可直接看到固定版本并打开 CodexHost。
- Codex Desktop 里可把 Pi、Oh My Pi、Claude Code、Grok Build 与 DeepSeek Harness 当作原生任务，保留流式输出、工具状态、Edit Diff、审批、Usage、Fork、压缩、斜杠命令和上一轮修订等上游能力。
- LeoAPI、手机中继、模型快捷配置、Fleet 和原 leocodebox 工作区保留。CodexHost 不接触 LeoAPI 密钥，只负责 Codex Desktop 的 Harness 投影。

### 工程与安全边界

- 直接依赖精确版本 `@codexhost/cli@0.3.5` 及平台签名载荷，避免复制几十个适配器后与指定仓库漂移；MIT 来源与第三方许可写入 NOTICE 并随包分发。
- 启动接口仅允许本机认证请求，不接受任意命令、路径或参数；随包二进制路径由 Node 模块解析并验证为普通文件。
- CodexHost 会重启/接管 Codex Desktop，因此当前 Codex 开发任务内只执行 `--version`、路径和契约测试，不现场点击启动造成自杀式中断。

### 验证

- `verify:release-notes`、TypeScript 类型检查、零警告 ESLint、0 漏洞 npm audit 与生产构建通过；桌面 37、客户端 158、服务端 368，共 563 项测试通过。
- 精确载荷单测确认随包 CodexHost 为 0.3.5 且 launcher 可执行；DMG 只读挂载后再次核对 App 1.79.0、CodexHost 0.3.5、36 个嵌套 Mach-O 与主 App Developer ID 签名。
- DMG SHA-256 `012688f15295ea2833f10db98501d635a1ef3b92f064c4cda687bc2e7554ab4b`；热更新 ZIP SHA-256 `fd3b40e037664c9de0003f47d9f2bb6b297eda1d9c4974eabba11125bb2c9c19`。
- 本机缺少 notarytool profile，Gatekeeper 明确报告 `Unnotarized Developer ID`；不把未完成公证写成已完成。既有同 TeamIdentifier 热更新链可用，首次下载安装仍需用户确认。

<a id="t11-alpha22"></a>
## T11 · iOS 1.30.0 (104) / Android 1.0.0-alpha.22 - 2026-08-29

### 用户可见

- Grok OAuth 改为读取 xAI 第一方 CLI 代理的账号动态目录：Grok 4.6 作为可靠 fallback，有 Composer 权益时由实时目录显示，不再把 API Key 与 OAuth 混在同一个地址。
- “记录明天下午 19:00 去北京的高铁”会先核对目的地、时间、车次和座位；缺字段时不让模型猜，完整后 iOS 同时写系统日历和提醒事项，Android 同时写系统日历与产品自有持久待办。
- 日历/待办补齐地点、备注和提前 30 分钟提醒；未提供到达时间时明确不推断。
- Android Power 的节点 ID 绑定当前界面快照，换页后旧节点不能继续点击；无障碍被强制停止撤销时，可在 Shizuku 已授权的前提下恢复本服务且不覆盖 TalkBack 等其他服务。
- 无障碍空闲时不再订阅全量系统事件，只有用户明确启动事件观察时才临时订阅必要事件类型。

### 工程根因

- 原 xAI OAuth 与 API Key 都走 `api.x.ai/v1` 且共用静态模型表，导致 OAuth 权益模型不可见，也存在把 OAuth bearer 发往自定义根地址的风险。现在 OAuth 固定走 `cli-chat-proxy.grok.com/v1`，禁止重定向并按 OIDC `sub` 发送 `x-userid`。
- 原双端本机动作只识别显式“日历/待办”关键词，复杂出行语句直接交给模型猜；本次加入相同语义的双端结构化意图编译和缺字段闸门。
- 原 Android 无障碍使用 `typeAllMask`，节点句柄只靠 60 秒 TTL；本次改为运行时最小事件订阅和界面快照绑定。

### 已执行验证

- Android：Standard/Power 各 586 项单测（各 1 项设备条件用例跳过）；中文资源/设置闸门、双 Release lint（0 error）和双 Release APK 构建通过。
- 固定个人 Alpha 签名、包名、versionCode `100022`、versionName `1.0.0-alpha.22` / `1.0.0-alpha.22-power` 通过。SHA-256：Standard `c2fdca85aa73940383a5f467444266c7d72aa85aea56b85d2c883fb9ed282853`；Power `e54ec4fe8379a4ed28971cd437fe51987c96e7481cd1520a4a3498f5737118a1`。
- Fold8 API 35 模拟器：alpha.21 → alpha.22 两包覆盖安装均为 `Success`；两包冷启动、`ASSIST`、PID 与 Logcat 通过。1080×1728 封面、1768×2208 展开和 200% 字体截图复验，UI 树无越界节点；“本次更新”实际弹出且内容为 alpha.22。
- iOS/iPad：MinisLogicTests 测试产物无启动模拟器构建成功；`generic/platform=iOS` 无签名设备构建成功；`IOSReleaseReadinessAudit` 对 1.30.0 (104) 与首启更新说明校验通过。真机安装由用户在另一台机器执行。

### 边界

- Android 没有跨厂商统一 Tasks Provider，因此持久待办由 LeoPhoneAgent 自己保存并用系统通知到期提醒；不冒充已写入不存在的“系统待办”。
- OAuth 动态目录不可用时只回退到公开确认模型；Composer 不会在无权益账号上被静态伪造。

<a id="t10-alpha21"></a>
## T10 · iOS 1.29.0 (103) / Android 1.0.0-alpha.21 - 2026-08-29

### 用户可见

- iPhone、iPad 和 Android 可以直接读取/写入剪贴板、查看设备信息；写剪贴板后会读回核对，聊天里返回真实结果，不再只显示固定成功话术。
- iOS 收藏整理和语音任务在支持 Apple Intelligence 的设备上改用 Foundation Models 结构化生成；iPad 分屏、台前调度和连续缩放按实际内容空间切换单双栏。
- 两端产物识别补齐 Office、压缩包、JSON、代码和更多媒体格式。Android 的输入/流式/浏览器/语音动效在系统“减少动态效果”开启时会静止。
- Android Standard 不再申请 Power 专属的所有文件、无障碍、Shizuku 和应用列表权限；设置里也不再展示无法完成的授权入口。Power 保留受系统授权和产品确认保护的能力。
- Fold8 1080×1728 封面在 200% 字体下，聊天顶栏不再与状态栏相撞；正文、任务卡和输入区仍完整放大。

### 工程根因

- 原公共 Manifest 把高权限声明和组件泄漏给两个 flavor；前台 Agent 还沿用了与任务语义不符的媒体播放类型。现在能力声明下沉到 Power，Agent 前台服务使用 `dataSync|specialUse`，Relay 继续使用 `remoteMessaging`。
- 原生动作路由只返回固定文案，产物卡的可打开格式集合也小于现有预览器真实能力；本次统一按执行结果和已有预览能力收口。
- Android 固定高度三行顶栏在 200% 字体下会向上挤进状态栏；现在只给紧凑导航字体设置 130% 上限，聊天内容仍遵循完整系统字体比例。

### 验证

- Android：Standard/Power 各 581 项单测（各 1 项设备条件用例跳过）；`verifyChineseResources`、`verifyChineseSettingsStrings`、双 Release lint（0 error）和双 Release APK 构建通过。
- 固定个人 Alpha 签名、包名、versionCode `100021`、versionName `1.0.0-alpha.21` / `1.0.0-alpha.21-power` 通过；Standard APK 不含 Power 四类权限/组件。
- SHA-256：Standard `e23638684fa1bb14c99db7dc6d3b8974938cdd0439cdf530e4b2f661f3f7706f`；Power `5321469d3df839f187b901b59097aceaf67b82f36c27aa77123e671e69f9c016`。
- Fold8 API 35 模拟器：alpha.20 → alpha.21 两包覆盖安装均为 `Success`；两包冷启动、`ASSIST`、PID 和 Logcat 通过。1768×2208 展开双栏、1080×1728 封面单栏、封面 200% 字体均截图复验，UI 树无越界节点。
- iOS/iPad：Xcode 26.6 / iPhoneOS 26.5 SDK 的 `generic/platform=iOS` 无签名设备构建成功；iOS 27 专属 API 等 Xcode 27 工具链后再启用，不伪造不可编译代码。

### 停损

- 本次公开附件只发布 Android；iOS 代码和版本已到 `1.29.0 (103)`，由用户用身边设备装机。未重新构建或发布 Mac/Harmony。
- Standard 继续不提供无障碍跨应用与完整目录挂载；Power 仍需用户在系统中授权。Android 16 AppFunctions 需要 compileSdk 37 / AGP 9.1，当前工具链不强行接入。

## Mac 1.78.0 - 2026-08-27

### 用户可见

- 原来那个中途崩掉的对话还能打开：一条带 `$` 的公式或坏消息不再把整栏换成「此区域暂时无法加载」。
- 点重新加载也不会再对着同一条消息立刻摔回去。
- API Key 读出来的模型改完会真正用来发。

### 验证

- `npm run verify:release-notes` 通过。
- KaTeX / 提问卡 / 消息正文单测通过。
- Developer ID 签名后发布到 `leocodebox-updates`（`v1.78.0` + `latest-mac.yml`）。本机 `/Applications` 只留这一份。

### 停损

- 本船不发 iOS / Android / Harmony。

## Mac 1.77.0 - 2026-08-27

### 用户可见

- Claude Code 跑到一半，一张提问卡或缺内容的大文件 diff 不再把整块聊天换成「此区域暂时无法加载」。
- 消息区和输入框分开兜底；换会话会自动恢复。

### 验证

- `npm run verify:release-notes` 通过。
- 提问卡缺 options、diff 空/大文件单测通过。
- Developer ID 签名后发布到 `leocodebox-updates`（`v1.77.0` + `latest-mac.yml`）。本机 `/Applications` 只留这一份。

### 停损

- 本船不发 iOS / Android / Harmony。

## T9 · Android 1.0.0-alpha.20 - 2026-08-27

### 用户可见

- 打开别的 App 后还能继续点、读、滑：Power 无障碍默认放行，无障碍已开时后台不再卡在一次确认。
- 后台任务默认保活，悬浮窗默认开；切走前会把前台服务先拉起来。

### 验证

- `scripts/verify_android_alpha_release.sh`：固定个人 Alpha 签名、包名、versionCode `100020`、versionName `1.0.0-alpha.20` 通过。
- SHA-256：Standard `38e8b60cb856766e4a39f0d29041659d40e30938e049ae1095ca3b696b7994b6`；Power `5c9f193614ba28208bba57e72458b354bb5c376bb8cc78ecb8942fe91c36dbaa`。
- Fold8 API 35 模拟器：alpha.19 → alpha.20 覆盖安装 `Success`；两包冷启动与 `ASSIST` 均为 `Status: ok`，无本 App `FATAL EXCEPTION`。

### 停损

- Standard 仍不带无障碍跨应用。Power 仍要系统无障碍授权；没给悬浮窗权限时只出已有提醒，不会自己开。
- 本船不发 iOS / Mac / Harmony。

## Harmony 0.3.0-alpha.17 · 对齐 T2/T7 - 2026-08-26

### 用户可见

- 没网也能听懂「打开手电筒」「记个待办」并直接做。闹钟和日程走本机提醒，不打开别人的界面。
- 会话列表最多三张卡：正在执行、等待审批、最可能需要的动作。可在外观里整组关掉。
- 设置顶上能搜到每一项。录音时停掉正在播的朗读。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs` 覆盖 T2 相册/闹钟/日历与 T7 手电/待办决策，与 Android `ActionRouterTest` 同一组短语。
- `src/harmony/scripts/verify_harmony_release_notes.sh`：`0.3.0-alpha.17` / `100022` 通过。
- 真机 `hdc install` 按用户指令推迟到明天公司机。相册落盘明天真机再接（路由已对齐，执行仍回落到 Agent）。

### 停损

- 没有下发 GGUF / 第二套 Agent。T3 Power、T4 窗口、T5 捷径/Bookmark 鸿蒙做不了，不装成已齐。

## T8 · 旁路评测 + Mac 单份 1.76.0 - 2026-08-26

### 内部

- Phase 8 题库仍在 `docs/eval/t2-30.md`，补了 T7 手电/待办决策记录。不写进任何端的「本次更新」。
- 本机 `/Applications` 只留一份 Developer ID 签名的 leocodebox 1.76.0；`leocodebox-updates` 最新 feed 是 `v1.76.0`。

## T7 · Android 1.0.0-alpha.19 / iOS 1.28.0 (102) - 2026-08-26

### 用户可见

- 没网也能听懂「打开手电筒」「记个待办」并原生执行，聊天里一句人话说明走了哪条路。
- 家页最多三张主动卡：正在执行、等待审批、最可能需要的动作（手电筒）。可在外观里整组关掉。

### 验证

- Android `ActionRouterTest`、iOS `AgentChatCorrectnessTests` 覆盖手电/待办短语。
- `scripts/verify_android_alpha_release.sh`：固定个人 Alpha 签名、包名、versionCode `100019`、versionName `1.0.0-alpha.19` 通过。
- SHA-256：Standard `ab76c82ac9e96129bf9cf3821e8045faf477f52a5b5753a6a93aa620539ac933`；Power `7edb1427d1c77b7e8bb752f0e04d3f3824a15999760b4f5a32bea97a3bd3256c`。
- 本船不发 Mac / Harmony。装机与首启弹窗按用户指令推迟到 T8。

### 停损

- 没有下发 GGUF / model-weights，也没有第二套 Agent。路由仍是 T2 正则，快脑记入 D 档。

## T6 · Android 1.0.0-alpha.18 / iOS 1.27.0 (101) / Mac 1.76.0 / Harmony 0.3.0-alpha.16 - 2026-08-26

### 用户可见

- 断线重连后事件续上：首帧 `resume=ok/gap`。水位不够会明确说中间缺了一段，并从可用水位接着跑，不会丢一段、重复一段或把状态倒回去。
- 新设备扫/粘贴短码即可入列，不用再手抄长共享密钥。旧密钥这一轮仍能用（双栈，不停旧签）。
- Android 远程进行中的任务出现在本机会话列表；iOS 本来就在列表的「进行中」里。点进去跟的是同一条会话。

### 验证

- 共享协议 fixture（乱序 / 重放 / 断线）与 `resumeEnvelope` 单测通过。
- Android 双 flavor 门禁、iOS 审计 / MinisLogicTests、Mac `verify:release-notes` + leophone 单测、Harmony 发版闸门：见本船交付记录。
- `scripts/verify_android_alpha_release.sh`：固定个人 Alpha 签名、包名、versionCode `100018`、versionName `1.0.0-alpha.18` 通过。
- SHA-256：Standard `121b1105c70119ec7f48712785e3f3122e7bbf330496215f8059234a31162542`；Power `bac98af2e39590d6822d9820754218cc5c48dd70794368ce3084167afafc4f0a`。
- 真机断网 2 分钟续传、hdc 装鸿蒙、Mac 签名包、Fold8 覆盖安装：按用户指令推迟到 T8 一并验收。

### 停损

- 没有做密文-only 中继、持久 Outbox、JWT 单飞、第二套 Runtime。停在双栈：旧 `RELAY_KEY` 本周期继续有效。
- 没有做 T7 本地快脑 / 主动卡。

## iOS 1.26.0 (100) - 2026-08-26

### 用户可见

- 授权过的文件夹跨启动仍可用，并能设成当前会话工作区（文件工具 / iSH `/var/minis/workspace` 都指向它）。
- 快捷指令「摘要」：文本 → 摘要 → 返回，不打开 App；失败时写明「此命令需打开 App」。
- 供应商配置导出默认不含 API Key / OAuth。终端可切换到最近会话的工作目录。

### 验证

- MinisTests `T5ShellBridgeTests` 通过；iOS Debug 编译通过。
- `IOSReleaseReadinessAudit` 1.26.0 (100) 通过；`InstallIOSRelease.sh` 装到 iPhone 17 Pro Max 成功。

### 停损

- 没有换 iSH，也没有第二套终端 / Mosh。摘要走现有 `ModelUseOffloadBridge`，不新开 Agent 循环。
- 本船只发 iOS。

## Mac 1.75.0 / iOS 1.25.2 (99) - 2026-08-26

### 用户可见

- Mac 操作绑到精确窗口（机器 + 应用 + pid + window_id + snapshot_id）。后台窗口快照超过 3 秒会拒绝执行，并说明要先重观察。坐标点选后台窗口直接拦下。
- 舰队（Mac / iOS / Android）进行中任务显示窗口「应用 · 标题」。手机点进去接管同一 `session_id`，不新开会话。

### 验证

- `npm run verify:release-notes`、exact-window 单测、`npm run typecheck` 通过。
- iOS `IOSReleaseReadinessAudit` 1.25.2 (99) 通过；`InstallIOSRelease.sh` 装到 iPhone 17 Pro Max（`2A6E7C6F-…`）成功。

### 停损

- 没有做屏幕取图墙，也没有后台坐标点选（留 T4.5）。`src/mac/leoagent/` 重复 Harness 按计划再稳 14 天再删。
- Android 舰队行已能读 `window` 字段，本船不发 Android APK。

## Android v1.0.0-alpha.17 - 2026-08-26

### 用户可见

- Power 版可以把冻结、卸载、清理做成一次确认的事务：只读扫描 → 计划 → 风险确认 → 逐项结果 → 回滚。对话里说「冻结这 3 个 App com.a com.b com.c」，回复「确认」执行，再回复「回滚」恢复。
- Standard 没有这条入口，也没有 Power 特权类。

### 验证

- JDK 17：`verifyChineseResources` / `verifyChineseSettingsStrings` 通过；双 flavor Debug 单测通过；双 Release lint 0 error；双 flavor Release 组装通过。
- `scripts/verify_android_alpha_release.sh`：固定个人 Alpha 签名、包名、versionCode `100017`、versionName `1.0.0-alpha.17` 通过；Standard dex 无 `ShizukuPackageActor`，Power dex 有。
- SHA-256：Standard `2036e2190f711c42fcc9e53df7fc8ad5df6acb6a1cf0b0ff54b3fd5e4e082d31`；Power `218a90a19da15c32e330672227b8d5b860a710057f76fa1752d9153552924f60`。
- Fold8 API 35 模拟器：alpha.16 Standard/Power 原地覆盖本次 APK，两次 `Success`；冷启动与 `ACTION_ASSIST` 均为 `Status: ok`；Logcat 无本 App `FATAL EXCEPTION`；首启弹出「本次更新（1.0.0-alpha.17）」/「本次更新（1.0.0-alpha.17-power）」，正文是本版事务文案。

### 停损

- Selector 引擎未做。本船 5 条手写规则（冻结/解冻/卸载/清理/撤权）+ 热更新管道（allowlist / sha256 / staging / LKG / 用户可关）。泛化留 T3.5。
- 真机 Fold8 仍由用户自装。未做真实冻结 3 个 App 的 Shizuku 事务（模拟器无 Shizuku）。

## Android v1.0.0-alpha.16 / iOS 1.25.1 (98) / Mac 1.74.3 / Harmony 0.3.0-alpha.15 - 2026-08-26

### 用户可见

- 四端设置改成同一四组：我的设备 / Agent / 外观与通用 / 数据与关于。
- Harmony 强调色从橙红对齐青绿（`#2E8B8B` / `#4DD9D9`）。对照表在 `docs/DESIGN-TOKENS.md`。
- Android / iOS 语言选择可以切繁体中文。Android `values-zh-rTW` 补到与默认词表同键。
- 清掉点了没反应的死控件：Android 隐藏的 WebApp 入口删码；iOS 17 以下 Live Activity 喇叭不再假装能点；Mac 没有 GitHub 正文时改读随包更新记录。

### 验证

- Android JDK 17：`verifyChineseResources`（含 zh-TW）/ `verifyChineseSettingsStrings` 通过；双 flavor Debug 单测与双 Release lint 通过（0 error）。
- `scripts/verify_android_alpha_release.sh`：签名、包名、versionCode `100016`、versionName `1.0.0-alpha.16` 通过。
- SHA-256：Standard `8864f7bb5ea830ee23fb333f45eacd45ec7a95df15f6fee68bbef55c0b15243b`；Power `f327230c443d9318e2454bda0fb503f38f1277b7a8217d9a4f437878927f8ce1`。
- Fold8 API 35 模拟器：alpha.15 Standard/Power 原地覆盖本次 APK，两次 `Success`；冷启动与 `ACTION_ASSIST` 均为 `Status: ok`，Logcat 无本 App `FATAL EXCEPTION`；首启弹出「本次更新（1.0.0-alpha.16）」。
- iOS：`IOSReleaseReadinessAudit` 1.25.1 (98) 通过；无障碍 / 可见控件审计通过。
- Mac：`npm run verify:release-notes` 通过。
- Harmony：`verify_harmony_release_notes.sh` 0.3.0-alpha.15 / 100020 通过。

### 停损

- Harmony 全文 `$r()` 抽取未做（设置标题走 `Copy.ets`）。T3 结束前若还要繁中资源层，另开一船。
- T3 Android 版本顺延为 `alpha.17`。
- Mac 未打 Developer ID 签名包；桌面端本次更新随下次本机安装弹出。

## Android v1.0.0-alpha.15 / iOS 1.25.0 (97) - 2026-08-26

### 用户可见

- 「把这张图存进相册」「定个明早 8 点闹钟」「加到日历」说清楚时直接走系统接口，聊天里写明走了哪条路，顶部芯片显示「系统相册 / 系统闹钟 / 系统日历」。不再先截图乱点。
- 没附图或没说清时刻的请求仍走原来的 Agent。Phone UI / Mac Body 本船不抢 Fast。
- Android 系统闹钟是 Clock 的「下一次该时刻」；当天该点之前说「明早」可能落在今天。iOS 26+ 用明确 fireDate；更旧系统设闹钟退回 Agent。

### 验证

- iOS：`IOSReleaseReadinessAudit` 1.25.0 (97) 通过；无障碍 / 可见控件审计通过；`AgentChatCorrectnessTests`（含 ActionRouter 题库短语）模拟器 **TEST SUCCEEDED**；主 scheme Debug `generic/platform=iOS` **BUILD SUCCEEDED**（本机补装 watchOS 26.5 Simulator 后）。
- Android JDK 17：中文资源/设置门禁通过；Standard Debug 单测 563 / 0 失败 / 1 既有跳过；Power Debug 单测 1104 / 0 失败 / 2 跳过；双 Release lint 0 error；双 flavor Release 构建成功（6m47s）。
- `scripts/verify_android_alpha_release.sh`：固定个人 Alpha 签名、包名、versionCode `100015`、versionName `1.0.0-alpha.15` 通过。
- SHA-256：Standard `ed65279b42bd9e108840b42ee577aab01a84aac6fae18b02c3324ae9f6c8a4e4`；Power `4d5ab0f6b4d1955a5d524a6a568d47899bfa5f6ecdc74a19a72809d5d033f7a9`。

- Fold8 API 35 模拟器：已装 alpha.13 Standard/Power 原地覆盖本次 APK，两次 `Success`；冷启动与 `ACTION_ASSIST` 均为 `Status: ok`、进程存活，Logcat 无本 App `FATAL EXCEPTION`；首启弹出「本次更新（1.0.0-alpha.15）」。附件已挂到 `android-v1.0.0-alpha.15`，GitHub digest 与上列 SHA-256 一致。
- 真机 Fold8 与 30 题步数 ≥25% 仍待用户本地下载安装后复验。

## Android v1.0.0-alpha.14 / iOS 1.24.2 (96) - 2026-08-26

### 用户可见

- 长文件 `file_read` 连续分页：head 读完一页给出 `next_offset`，三端同一算法（Android / iOS / Harmony）。
- 开始录音时先停朗读，麦克风不再和 TTS 抢声音。
- Android 设置可搜索；「连接的设备 / 远程机器」改走 `stringResource`。
- 会话列表头部显示进行中 / 待审批数量。审批数由舰队页发布；远程会话完整并入本机列表仍是后续船。

### 对账（本版不发明已经存在的能力）

- OpenAI 流式首包超时已经是 120s，本版不改。Anthropic / Gemini 读超时仍是 10 分钟。
- 供应商配置读失败本来就不会清库（Android 保留 DB；iOS decode 失败跳过 save）。

### 历史债

- 补 iOS 1.24.1、macOS leocodebox 1.74.2 顶栏条目（这两版当时已发，CHANGELOG 顶栏漏写）。

### 验证

- Harmony `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs` 通过（含 `fileReadPage` golden）。
- iOS：`IOSReleaseReadinessAudit` / `IOSAccessibilityMotionAudit` / `IOSVisibleControlAudit` 通过；`MinisLogicTests` 模拟器 `** TEST SUCCEEDED **`。
- Android JDK 17：中文资源/设置门禁通过；Standard/Power Debug 单测各 549、0 失败、1 既有跳过；双 Release lint 0 error；双 flavor Release 构建成功。
- `scripts/verify_android_alpha_release.sh`：固定个人 Alpha 签名、包名、versionCode `100014`、versionName `1.0.0-alpha.14` 通过。
- SHA-256：Standard `58e9ab63cf7da888c48ffebba0f93c1b767e246e73462f52591721d55fc8f6a3`；Power `817229262e0bdcfa66a08e562b28dec4f62e733b2436131140c3a516bde0cbf3`。
- HOLD：本机当时没有 Fold8 / 没有在线 iPhone，覆盖安装、冷启动、Logcat、首启弹窗未在真机复验。APK 不上传到 GitHub，直到 Fold8 覆盖安装过门。

## iOS 1.24.1 (95) - 2026-08-19

- 远程 shell 和远程 Agent 必须在本机确认，并且按主机 + 这条命令/任务绑定。
- 扫码加身体时钥匙只跟配对码里的同一条中继根走；刷新舰队按各自中继根对钥匙。
- 当前模型不能读图时直接拦住并保留附件，不再假装已经看过。
- 锁屏 / 切走后本机执行沿用本会话授权；「本会话允许」对本机终端只用点一次。
- 会话筛选切到「归档」而没有归档会话时，筛选条不再消失。
- 设置里的「压缩 / 标题」便宜模型现在真的作用于压缩；「到阈值自动压缩」对已打开对话立即生效。
- 导入 JSON 会话不再卡界面，重复导入同一份文件会自动跳过。

## macOS leocodebox 1.74.2 - 2026-08-22

- 开发与打包供应链漏洞清零：npm audit（含开发依赖）从 9 项降为 0 项。
- 修好主仓目录里的 npm install 钩子：Husky 从仓库根安装到正确的 hooksPath。
- 源码、测试与本机安装版本统一到 1.74.2；未取得 Developer ID 私钥与公证票据前，不会把临时签名包冒充公开热更新。

## HarmonyOS 0.3.0-alpha.14 (100019) - 2026-08-20

- Kimi 登录直接打开带设备码的确认页，登录后不用再手抄顶栏那串码。
- 覆盖安装必须弹出「本次更新 · Kimi 确认页带设备码」。

### 验证

- `bash src/harmony/scripts/verify_harmony_release_notes.sh`
- `node --test src/harmony/protocol/protocol.test.mjs`

## HarmonyOS 0.3.0-alpha.13 (100018) - 2026-08-20

- Kimi 设备码登录直接打开确认页，不再先停在空白再超时。打不开时仍显示设备码，可复制链接。
- 覆盖安装必须弹出「本次更新 · Kimi 确认页能打开」。

### 验证

- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.3.0-alpha.12 (100017) - 2026-08-20

- 供应商详情里「从上游拉取」和「用作当前」不再被长模型列表顶出屏幕。切换供应商先点名字再展开模型。
- 覆盖安装必须弹出「本次更新 · 详情页能拉到按钮」。

### 验证

- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.3.0-alpha.11 (100016) - 2026-08-20

- 本机对话吐字时，列表跟着滚到最新一句，不用再手滑下去看。
- 覆盖安装必须弹出「本次更新 · 吐字跟着滚」。

### 验证

- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.3.0-alpha.10 (100015) - 2026-08-20

- 登录页停在空白时不再当成已经打开。八秒后出现「页面打不开」和复制链接，不跳系统浏览器。
- 覆盖安装必须弹出「本次更新 · 登录打不开会说明」。

### 验证

- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.3.0-alpha.9 (100014) - 2026-08-20

- 设置、会话、说话、识图、朗读不再用单个汉字当图标，改成系统图标。
- 本机对话按帧往气泡上刷字。供应商没配完也能点切换。
- 覆盖安装必须弹出「本次更新 · 图标和逐字回复」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.3.0-alpha.8 (100013) - 2026-08-20

- 竖屏不再按内屏宽度强行左右分栏。会话改成卡片，设置分区改成中文。
- 对话气泡不再切掉左边的字，发送键不再挤成省略号。供应商详情的模型列表可点选，保存钉在底部。
- 覆盖安装必须弹出「本次更新 · 排版不再切字」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.3.0-alpha.7 (100012) - 2026-08-20

- 在详情页换完模型回到首页，「选择执行模型」会显示刚选的那个，不再停在上一份名字。
- 覆盖安装必须弹出「本次更新 · 当前模型会跟着变」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.3.0-alpha.6 (100011) - 2026-08-20

- 加完供应商回到首页，「选择执行模型」会解锁，点进去就能换当前模型。
- 登录授权不再跳系统浏览器。打不开就停在本页中文说明并可复制链接。
- 覆盖安装必须弹出「本次更新 · 选模型能点进去」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.3.0-alpha.5 (100010) - 2026-08-20

- OpenAI 登录被地区拦截时，不再把 403 JSON 和「美观输出」铺满屏幕。改成中文说明，并给出复制链接、系统浏览器。
- 登录页一打开就提示需要境外网络。8 秒打不开也会收掉网页。
- 覆盖安装必须弹出「本次更新 · 登录页不再白屏」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.3.0-alpha.4 (100009) - 2026-08-20

- 添加供应商保存后进入详情页选模型，新实例自动设为当前。本机聊天顶栏可切换供应商和模型。
- OAuth 登录页打不开会写出错误，可复制链接或用系统浏览器。OpenAI / Claude / xAI / Gemini 会提示需要境外网络。
- 冷启动后本机引擎先加载供应商档案，当身体和定时任务不再误报「还没配供应商」。
- 定时任务结果写入「定时·标题」会话，失败原因留在定时页；失败当天不标记已跑。仅前台执行。
- Anthropic / Kimi / xAI OAuth 会存 refresh token。拉模型按类型带认证头，失败时走 models.dev / 内置列表。
- 覆盖安装必须弹出「本次更新 · 供应商贯通」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.3.0-alpha.3 (100008) - 2026-08-20

- OpenAI OAuth 登录后本机对话走 `chatgpt.com/backend-api/codex/responses`，和 Fold8 同一条后端。
- 刷新 token、账号头、Responses 工具调用都接上。覆盖安装必须弹出「本次更新 · Codex 能聊」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.3.0-alpha.2 (100007) - 2026-08-20

- 添加供应商按 Fold8 列出这一家真能用的登录：OpenAI / Anthropic / OpenRouter 有 OAuth，Kimi / xAI 设备码排前面，Gemini 只有 API Key。
- 点 OAuth 在本页打开登录网页，拦 localhost 回调换 token；不再灰一行「设备码」，打开网页也不会把轮询取消。
- OpenAI Codex 登录后本机对话仍走 Chat Completions；Codex Responses 后端这一版还没接。
- 覆盖安装必须弹出「本次更新 · 供应商 OAuth」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.3.0-alpha.1 (100006) - 2026-08-20

- 鸿蒙当身体：向中继注册 `platform=harmony` / `server=minis`，iPhone 可开会话并走本机工具循环。
- 本机补齐：Kimi/xAI 设备码、语音说/读、Push Kit 要 token、Markdown、识图落盘、模型组失败换、用量 token、浏览器标签、HTTP MCP、前台定时。
- 鸿蒙 NEXT 跑不了 Android 那份 PRoot。Push 没配 AGC 时杀进程后仍收不到。
- 覆盖安装必须弹出「本次更新 · 鸿蒙当身体」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.2.0-alpha.3 (100005) - 2026-08-20

- 本机对话走工具循环：file_list / file_read / file_write / file_edit / memory_write / memory_get / open_url / web_fetch。
- 写文件仍默认询问。没有 Linux 命令，也不做无障碍跨应用。
- 覆盖安装必须弹出「本次更新 · 本机工具循环」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.2.0-alpha.2 (100004) - 2026-08-19

- 供应商按 Fold8：类型 → 凭证 → 身份/接口，多实例、拉 /models、模型组。
- 外观跟随系统或锁浅色 / 深色，状态栏一起变；启动会话、回车发送、常亮可配。
- 设置分区对齐 Fold8：远程机器、中继、Soul、环境变量、用量。
- 覆盖安装必须弹出「本次更新 · 供应商和深浅色对齐 Fold8」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.2.0-alpha.1 (100003) - 2026-08-19

- 本机 Agent：OpenAI 兼容对话、会话落盘/搜索/置顶/日期分组、长按归档删除、记忆、技能、藏宝阁、沙箱文件、应用内打开链接。
- Pura X Max 内屏按 Fold8：左栏自带 Leo 顶栏，会话行 44 图标 + 13 相对时间，左右 56 新任务/搜索，气泡 80%。
- 写沙箱文件默认询问。没有 Linux 沙箱，也不做无障碍跨应用。
- 覆盖安装必须弹出「本次更新 · 本机 Agent 对齐 Fold8」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## Android v1.0.0-alpha.13 - 2026-08-23

### 开发 CLI 连接模型重做

- 根因：alpha.12 只有一个「使用 LeoPhoneAgent API Key」开关，启动解析器又将 Claude/Codex/Grok 硬绑定到各家默认官方端点。自定义端点、Responses/Messages 协议、OAuth 边界和 CLI 自身登录被混在一起，所以用户明明已在 LeoPhoneAgent 选模型，CLI 仍会要求官方授权。
- 设置页改为显式的「CLI 官方账号 / Leo 模型」两模式；Leo 模型会列出真正兼容的 Provider + Model，旧版「自动选择 · 自动选择」也会迁移到真实回退条目。
- Claude Code 使用独立 `CLAUDE_CONFIG_DIR` 和不含密钥的初始状态，直接进入目录信任确认，不再弹「检测到自定义 API Key，是否使用」并默认 No。Codex 使用独立 Responses provider profile，Grok 按 Provider 生成 `messages` / `responses` / `chat_completions` 模型配置。
- 模型、端点和协议只写入 `/root/.leophone-cli/`；API Key 仍从加密存储单次注入环境，不进入配置、命令、导航或日志。OAuth/订阅令牌不导出；Cursor 继续只允许官方账号。

### 登录与 Fold8 可见体验

- Claude、Codex、Grok、Cursor 每张卡片都有「登录/重新登录」和官方账号状态。某些 CLI 在「未登录/已过期」时仍返回退出码 0，现在会结合官方文本判定，不再假绿。
- 登录输出中的官方 HTTPS 授权地址会经严格 host 白名单自动打开 App 内浏览器；Codex 直达 OpenAI 登录，Cursor 直达 Continue to sign in，Grok 直达已带 device code 的 `accounts.x.ai` 页，不再让用户对着一串码找输入口。
- CLI 启动遮罩最多显示 3 秒，不会再覆盖已经出现的信任/登录交互。宽屏卡片、配置对话框和全屏终端继续按 Fold8 1768×2208 展开态验证。

### 验证

- 定向单测覆盖 Provider/协议兼容、OAuth 禁导出、HTTPS/回环端点、托管配置路径、密钥不落盘、官方授权 host 白名单、过期/未登录零退出码。
- Fold8 API 35 真实安装 Claude Code 2.1.238、Codex CLI 0.149.0、Grok Build 1.0.5 和 Cursor CLI 2026.08.11；Claude Leo 模式直达目录信任，Grok 实屏显示 `LeoPhoneAgent · Anthropic` 与 `Logged in with API key`，Codex/Cursor 官方登录页已在 App 内自动打开。
- JDK 17 下 Standard/Power 完整 JVM 测试均 0 失败（各 1 个既有跳过）；中文资源/设置门禁通过；双 Release lint 均 0 error；同一次 8m30s 双 flavor Release 构建成功，固定个人 Alpha 签名、包名、versionCode `100013` 与 versionName 均通过校验。
- Fold8 API 35 上 Standard/Power 先回退到远程 alpha.12 附件，再用本次 APK 原地覆盖，两次均 `Success`；冷启动与 `ACTION_ASSIST` 均 `Status: ok`、进程存活，Logcat 无本 App `FATAL EXCEPTION`。实屏复验 1768×2208 展开态、1080×1728 封面态、alpha.13 中文更新弹窗、真实账号状态与 Grok device-code App 内页。
- 发布 APK SHA-256：Standard `8b8cfcda6e4709627dabaf92150adecafbb7a8f9f580bb418ef44a0bfcccd124`；Power `ca6aae2b457318adbfd8c40c76dc54211eb056556e074b1093bf01c468a2b2de`。

## Android v1.0.0-alpha.12 - 2026-08-22

### 对话即本机 CLI

- Claude Code、Codex CLI、Grok Build、Cursor CLI 进入聊天模型选择器；已安装工具显示真实版本，未安装工具直接跳开发 CLI 管理页。
- 选中后在 PRoot 工作区以 JSONL 非交互模式执行并流式回写普通聊天气泡；同一聊天持续复用 CLI 会话，发送中的追加消息会排队到下一轮。
- Prompt 先写入会话私有临时文件，命令只引用固定路径；LeoPhoneAgent API Key 通过一次性环境变量注入，执行后恢复或清除，不进入命令文本、导航、Shell 历史或磁盘。
- 四种 CLI JSON 方言都走容错解码，未知帧忽略、文本单调去重、失败保留真实尾部日志；停止按钮会同时取消 CLI 与对应 PRoot Shell。

### 交付物与远程工作台

- `file_write` 成功生成 HTML、Markdown、SVG、CSV、PDF、图片、音视频后，聊天流出现一等交付物卡片；点击直接进入现有 HTML、图片或文件预览，不再埋在工具详情里。
- 远程 Mac/Android 会话改用带 `after=seq` 的 SSE 回放 + 实时跟随；网络切换后从最后序号续传，任务状态、输出摘要和审批请求实时更新，替代手动刷新才能看见进度。
- SSE Bearer 鉴权、410 过期、断线重连、重复序号和终态收流均 fail-closed；重连采用 0.75–8 秒有界退避。

### 验证

- 新增 CLI 命令边界、Prompt 路径穿越、瞬时环境变量名、四家流式方言去重、交付物判定、Relay SSE 鉴权/续传测试。
- JDK 17 下 Standard/Power JVM 测试各 530 项（0 失败、0 error、各 1 个既有跳过）；中文资源门禁；双 Release lint 0 error；双 flavor Release 构建与固定个人 Alpha 签名校验通过。
- Fold8 API 35（1768×2208 展开态）从 alpha.11 原地覆盖 alpha.12，Standard/Power 均 `Success`；两包普通冷启动与 `ACTION_ASSIST` 均 `Status: ok` 且进程存活，Logcat 无本 App `FATAL EXCEPTION`。
- 简体中文实屏确认升级弹窗和「本机开发 CLI」模型选择区；真实识别已安装 Claude Code 2.1.238。发起本机 CLI 对话后进入流式等待并把模拟器里遗留的无效 Anthropic Key 以可重试内联错误呈现，未泄露 Key 值、未闪退。

## Android v1.0.0-alpha.11 - 2026-08-21

### 修复：CLI 借用 LeoPhoneAgent API Key 在新配置下即可用

- 复现:配好 Anthropic API Key、聊天顶部已显示当前模型,但只要还没发过一条消息,CLI 的「使用 LeoPhoneAgent 当前 API Key」启动就弹「还没有当前模型」——resolver 只认"最后使用过"的模型条目,与聊天头部显示的当前模型不一致。
- 修复:resolver 复用聊天同款回退链(最后使用 → 最新服务商的最新文本模型),两处对"当前模型"的答案保持一致。
- 文案:未配置任何服务商时的错误指引到「设置 → LLM 提供商」;「使用 LeoPhoneAgent 当前 API Key」开关说明补充 Claude 首启确认屏指引(Claude 检测到 API Key 默认选「No」,需选「Yes」才会使用)。

### 验证

- Fold8 API 35 实机:alpha.10 → alpha.11 双 flavor 覆盖安装 `Success`;升级首启弹出中文「本次更新」;修复路径复验——配好假 Key 不发消息直接「启动」,不再弹错、直达终端,Claude 显示 `Detected a custom API key … sk-ant-…-0001` 确认屏(内存注入链路铁证);`ACTION_ASSIST` 与 Power 冷启动 `mCurrentFocus` 正确;Logcat `FATAL EXCEPTION` 0 条。
- Standard/Power JVM 测试各 516 项 0 失败;中文资源门禁;双 Release lint 0 error;`--max-workers=1` 双 flavor 构建;固定个人 Alpha 签名校验。

## Android v1.0.0-alpha.10 - 2026-08-21

### 开发 CLI 使用体验重做（对话可达性 P0 的第一步）

- 「打开终端」改为「启动」：命令**立即自动执行**，不再把裸命令留在黑屏提示符上等用户自己发现要按回车；启动期间显示中文进度提示（首次约 30–60 秒 + 唤起键盘指引），CLI 开始输出或切入 TUI 后自动消失。
- 安装成功弹窗新增「启动」主按钮：装完 → 一键进入工具，入口深度从 4 层降为 0。
- 终端快捷键栏新增「粘贴」键：OAuth 授权码可直接粘贴进 CLI 登录流程（此前只能长按选区，不可发现）。
- 安装过程日志可见：进行中可展开完整滚动日志；失败弹窗显示安装器完整输出，支持「复制日志」与「一键重试」——不再只有 180 字符截尾。
- CLI 卡片层级重排：已安装 =「启动」（填充主按钮）+「更新」（描边次按钮）+ 溢出菜单（模型与授权 / 更新 / 卸载）；未安装 = 单一「安装」主按钮。
- 新增卸载：只删启动器本体，保留登录态与配置文件，重装免再登录。
- CLI 状态检测从四次串行 proot 往返合并为**单趟探测**（`___LEO_CLI___` 标记逐工具带真实退出码），进页明显更快；探测失败保留上次状态，不出假红。
- Cursor 安装超时上调至 20 分钟（源码重建原生模块在低端机可能超过统一的 10 分钟上限）。

### 装机后「本次更新」提示（发版铁律第一条，Android 首次落地）

- 每次覆盖升级后首启弹出「本次更新」对话框，内容即本版真实变更（简体/繁体/英文）；从无此机制的旧版（≤ alpha.9）升级上来通过安装时间戳识别，同样会弹出。

### 内部质量

- 安装/卸载结果改为 sealed 模型（成功/失败/已卸载），不再用一个字符串字段按布尔翻转语义。
- `launchCommand` 支持受限工作目录参数（仅 `/root`、`/var/minis/**`，拒绝穿越与控制字符，完整 shell quoting）——为下一版「在挂载文件夹中启动」铺路。
- 新增定向测试：状态标记解析（真实退出码、缺行补齐、垃圾行容错）、卸载命令边界（禁止 rm -rf、保留登录）、工作目录白名单与引号转义、超时分级、失败日志拼装、What's New 资源门禁。

### 验证

- Standard/Power JVM 测试各 516 项，0 失败（含新增 9 项定向测试）；中文资源门禁通过；双 Release lint 0 error；`--max-workers=1` 双 flavor 构建通过；固定个人 Alpha 签名校验通过。
- Fold8 API 35 展开态实机：alpha.9 → alpha.10 双 flavor 覆盖安装 `Success`；升级首启弹出中文「本次更新」；完整闭环实测——装 rootfs → 装 Claude Code 2.1.238（滚动日志可见）→ 成功弹窗点「启动」→ 终端自动执行 → 启动提示自动消失 → 快捷键栏含「粘贴」；Standard `ACTION_ASSIST` 冷启动、Power 冷启动均 `mCurrentFocus` 正确；全程 Logcat `FATAL EXCEPTION` 0 条。
- 发布链修复：干净 worktree 首次构建缺 `assets/alpine-minirootfs.tar.gz` 与 `proot-aarch64`（构建期资产，不入库），装机后 rootfs 安装报 `Installation failed`——已按 `scripts/prepare_android_sandbox.sh` 固定 SHA-256 重新供应并重建，最终 APK 已含全部沙箱资产并复验。

## Android v1.0.0-alpha.9 - 2026-08-21

### 本机开发 CLI

- 设置新增「开发 CLI」，可在 App 私有 Alpine ARM64 沙箱中安装、更新、检测并打开 Claude Code、Codex CLI、Grok Build 和 Cursor CLI。
- 四个安装入口只允许固定官方 HTTPS 地址；安装脚本限制协议、跳转协议、连接时间和最大体积。Cursor 所需 `node-addon-api 8.9.2` 固定 SHA-512 后才解包。
- 每个 CLI 可设置模型 ID，打开终端时通过安全 shell quoting 传入 `--model`；超长和控制字符会被拒绝。
- 可选择使用 LeoPhoneAgent 当前、同供应商、API-Key 类型的模型授权：Anthropic → Claude、OpenAI → Codex、xAI → Grok。密钥只通过一次性内存交给新终端进程，不进入导航参数、命令行、Shell 历史或磁盘；OAuth、订阅令牌、自定义地址和 Azure 凭据拒绝导出。Cursor 继续使用自己的官方登录或 `CURSOR_API_KEY`。

### Alpine 兼容与更新安全

- 修复 Android 宿主 `TMPDIR=/data/user/...` 泄漏到 PRoot，导致 Codex 官方安装器 `mktemp -d` 静默失败；所有持久 Shell、一次性 Shell 和终端统一使用 guest `/tmp`。
- 状态探测不再用会吞掉前序错误码的管道；二进制存在但不能运行时显示「未安装」，不再假绿。
- Cursor 官方 Linux ARM64 包内含 glibc Node/原生模块。alpha.9 自动切换 Alpine Node、从源码重建模块，并对缺失的 GNU Merkle 绑定应用最小兼容层；已在 Fold8 API 35 上从 App 内真实更新并回读 `2026.08.11-e8db854`。
- Cursor 更新前由 Android 宿主原子备份整个 versions 目录；下载、重建、补丁或验证任一步失败都会恢复旧版本，成功才清理备份。

### 验证

- Fold8 API 35 的真实 Alpine ARM64：Claude Code `2.1.238`、Codex CLI `0.149.0`、Grok Build `1.0.5`、Cursor CLI `2026.08.11-e8db854`，四个严格版本命令退出码均为 0。
- 简体中文现场验证安装/更新/打开终端/模型与授权/确认弹窗全部为中文；Cursor 通过产品 UI 完成一次真实更新并显示「已经就绪」。
- Standard/Power 各 `507` 个 JVM 测试，0 失败（各 1 个既有跳过）；中文资源门禁、Standard Debug lint、双 Release lint 均为 0 error。
- Fold8 API 35 从 alpha.8 原地覆盖 alpha.9，Standard/Power 均 `Success`；普通冷启动与 `ACTION_ASSIST` 均 `Status: ok`，两进程存活且 AndroidRuntime 无崩溃。
- Standard SHA-256 `b88c9149cdf064da2d7fc6e41194847c40794209cd10b5454a99e72e39c127c4`；Power SHA-256 `a5497eab796960f4ed871c624283152e2b57b83c3fe630410477dce67465fc20`。

## Android v1.0.0-alpha.8 - 2026-08-21

### Fold8 与系统操控

- 完整合入 Android PR #3：Fold8 封面、展开、书本与桌面模式采用统一姿态策略，折叠切换时保留当前会话、草稿、滚动位置和输入法状态。
- 新增系统权限中心，集中展示默认助手、通知、电池优化、悬浮窗、通知访问、所有文件、精确闹钟和运行时权限，并为三星封面屏与休眠策略提供明确入口。
- 新增已安装应用枚举与按包名/应用名启动；`android-open` 继续经过产品权限闸门，并拒绝带显式 component 的危险 Intent。
- 聊天页对缺失的系统授权给出可操作提示；Fold8 大小屏布局、运动降级和关键触控目标补充回归测试。

### 编译与稳定性修复

- 修复 Relay 慢订阅压力测试低于 512 条生产缓冲、导致测试永远等不到 fail-closed 的问题；压力场景提升到 5000 条并真实覆盖溢出断流。
- 修正 `FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING` 的 API 守卫：仅 Android 14/API 34+ 传入该类型，Android 8–13 走兼容重载，避免旧系统拒绝启动远程身体常驻服务。
- Standard/Power 各 497 个 JVM 测试，0 失败（各 1 个既有跳过）；中文资源门禁、Standard Debug lint、双 Release lint 均通过（0 error）。
- Fold8 API 35 从 alpha.7 原地覆盖 alpha.8，Standard/Power 均返回 `Success`；普通冷启动与 `ACTION_ASSIST` 均为 `Status: ok`，两进程存活，AndroidRuntime 无崩溃。
- Standard SHA-256 `29b80c5b0a7d2263afad0594286d5336218545e033004c8bf947675a358f3b83`；Power SHA-256 `df96694e6efe7c1343f8c6b1ac7cb0ef7285664aa0d0d24f442606455769c3a5`。

## Android v1.0.0-alpha.7 - 2026-08-19

### 核心修复

- Android Relay Body 改为明确手动开启，默认只控制其他机器；关闭或清除密钥会立即终止旧 WebSocket。
- 修复 stop/steer 后旧 turn 继续回传终态、SSE 快照/实时接缝丢帧、慢订阅者静默丢帧和断线后旧 stream 泄漏。
- Android 主动上报审批/终态事件，断线期间有界缓存、重连后补发。
- Mac 工作台修复远程接管鉴权、事件字段、追问请求体、审批失败恢复和切换会话串状态；Android/Harmony 身体自动使用 `minis` harness。
- iOS 修复推理类型测试 target、Relay 地址/密钥串用和远程 Shell/Agent 绕过本地审批；非视觉模型不再假报已读图。
- Relay 拒绝日志改为 HMAC 指纹 + 限速 + 64KB 轮转；Native Offload 不再记录完整 argv/cwd；DOMPurify 升级至 3.4.13。

### 验证

- iOS MinisLogicTests `243/243`；Mac Client `137/137`、Server `354/354`，typecheck 与定向 eslint 通过。
- Android Standard/Power 各 `443` 个 JVM 测试，0 失败（各 1 个既有跳过）；Relay 并发与签名门禁继续通过。
- Fold8 API 35 从 alpha.6 原地覆盖 alpha.7，Standard/Power 均返回 `Success`；普通冷启动与 `ACTION_ASSIST` 均为 `Status: ok`，进程存活，Logcat 无本 App `FATAL EXCEPTION`。
- Standard SHA-256 `ff9257c23ce865e2edaf53bf02dd32fada9783ac7fbd0f46de1b51ef7aad44ba`；Power SHA-256 `89db6ec66fc7fd1bb2845bff23d653a28922b4b12a9d4466d4aab103ea617abb`。

## HarmonyOS 0.1.0-alpha.2 (100002) - 2026-08-19

- 做成完整远程控制面：产品图标、启动窗、深色界面，首页直接是远程机器而不是空架子。
- 适配 Pura X Max 阔折叠：外屏单栏，展开内屏左右分栏（舰队 + 新任务）。
- 中继钥匙、刷新、配对、新任务、续传、审批保留；本机 Agent / 鸿蒙身体仍未开，设置页写明。
- 覆盖安装必须弹出「本次更新 · Pura X Max 完整控制面」。

### 验证

- `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs`
- `bash src/harmony/scripts/verify_harmony_release_notes.sh`

## HarmonyOS 0.1.0-alpha.1 (100001) - 2026-08-19

- 首个鸿蒙瘦控制面：填中继钥匙后读 `/machines`，可对在线 Mac 或 Android 身体开新任务。
- 断线按 `?after=N` 续上；审批必须带 `approval_id`。配对码只含中继根和机器名。
- 首启弹出「本次更新」：鸿蒙瘦控制面。本机 Agent 与鸿蒙当身体未交付。

### 验证

- 协议层 `node --experimental-strip-types src/harmony/protocol/protocol.test.mjs` 通过。
- `bash src/harmony/scripts/verify_harmony_release_notes.sh` 必须通过后才能装机。
- 本机 `hvigor assembleHap` 已通过，产物为未签名 `entry-default-unsigned.hap`（165K）。`hdc list targets` 为空，未做真机覆盖安装。

## iOS 1.24.0 (94) / macOS leocodebox 1.74.0 / Android 1.0.0-alpha.6 - 2026-08-19

- Android 可作为中继身体（`platform=android` / harness `minis`）；三端机器列表改读 `/machines`。
- 配对码只含中继根和机器名；iPhone 可扫码加入。APNs 在主机出现时重登记。
- 推理规则可编辑、换模型夹档可见；Android 身体的远程任务会带走当前档，Mac CLI 暂用各自默认档。压缩/标题便宜模型、压缩开关。非视觉模型不再假报已读图。
- 写文件/终端默认询问。会话可归档、分组、导入 JSON。系列用语：新任务 / 本机 / 远程 / 进行中 / 审批。
- Android 流式首包超时 30s → 120s。iOS OpenAI/Anthropic 请求超时已是 600s，未改。
- 供应商 JSON 读失败时拒绝再保存，避免空配置覆盖原文件。

### Android 发布前修复

- 移除 `StateFlow.distinctUntilChanged()` 无效操作；Kotlin 在双 flavor 中把该过时用法判为编译错误。
- minis harness 会话事件回放改为锁内快照、锁外发射，修复异步写入时遍历可变列表引发的 `ConcurrentModificationException`。

### 验证（Android 发布机）

- iOS 源码与版本门禁字段已对齐 1.24.0 / 94，并写了本次更新条目。
- Standard/Power 中文资源门禁、各 440 个 JVM 测试（0 失败、各 1 个既有跳过）、双 Release lint（`0 errors`）和 R8 构建全部通过。
- APK 包名、versionCode `100006`、versionName、v2 签名与固定 Alpha 证书指纹均通过 `verify_android_alpha_release.sh`。
- Fold8 API 35 从 GitHub alpha.5 原地升级 alpha.6，Standard/Power 均返回 `Success`；展开几何下普通入口与 `ACTION_ASSIST` 冷启动、`1080×1728` 封面几何冷启动均为 `Status: ok`，进程存活，Logcat 无本 App `FATAL EXCEPTION`。

## macOS leocodebox 1.69.0 - 2026-08-18

### 额度改成问官方要,不再靠猜

- 吸收 CodexBar 的抓取能力:此前被动扫本机日志尾部、等服务端偶然下发额度帧(可能是几小时前的旧数字),现在用本机已有登录态直接调官方接口拿当前额度。Codex(`chatgpt.com/backend-api/wham/usage`)与 Claude Code(`api.anthropic.com/api/oauth/usage`)已打通,实测 Codex 33%@7d、Claude 30%@5h + 24%@7d。
- Claude 凭据**钥匙串优先、文件兜底**,且每个来源用前先查 `expiresAt` —— 本机文件里的 token 已过期 13 天,直接用只会拿到 401。
- 不硬编码窗口白名单:以「有数值 utilization + 有可解析 resets_at」为真实窗口判据,自动滤掉 Anthropic 的内部代号窗口,将来新增窗口也能接住。Codex 窗口长度一律从 `limit_window_seconds` 算,不按 lane 位置假设。
- 面板按 CodexBar 卡片规格重做:310px 卡片、每窗口一行(标题 + 剩余百分比 + 重置倒计时 + 6px 进度条 + 配速),进度条上画出配速位置、50%/20% 警戒刻度与 7 天窗口的工作日刻度。
- 新增配速判断:超前/落后多少、还能撑多久、预计几点用光、多大风险;数据不足以下结论时返回空,不给看起来很确定的 0。
- 权威与估算落到数据结构(`source` 字段):接口数据标「权威」,日志回落标「本机统计」。Gemini/Cursor/Grok/OpenCode 各自写明缺哪一样凭据,不填 0、不编百分比。
- 凭据全程只读:不写回、不刷新、不落日志;测试断言序列化快照里不出现任何 access token。

### 发版更新提示:加自动闸门

- `npm run verify:release-notes` 挂进 `desktop:dist:mac:signed` 链首,版本号与更新说明对不上直接构建失败 —— 1.68.0 那次漏写、装上却弹不出更新的情况不会再发生。
- 缺条目时明说"本版本更新说明缺失",不再 fallback 到上一版内容冒充。
- 修正根 CLAUDE.md 里早已废弃的 `resources/release-notes` JSON 路径,并把「每次发版都必须弹出本次更新」升格为全端通用第一条铁律。

### 验证

- 全量测试 518 通过 / 0 失败(desktop 34 + client 112 + server 372)。
- 端到端实跑 `readAiQuota()`,两家均返回真实权威额度。

## macOS leocodebox 1.68.0 - 2026-08-18

### 工作台外壳重做:对话即首页

- 9 项侧边导航 + 双侧栏 + 仪表盘首页,换成「46px 标题栏 → 820px 指挥条 → 264px 会话列表 + 会话详情 → 30px 状态栏」的对话优先外壳;冷启动直接落在会话上。
- 删除 `DesktopAppRail`、仪表盘首页地位、Fleet 独立 Tab、快速任务独立 Tab、常驻项目树侧栏;项目树移入 ⌘K 唤起的抽屉(仍是同一个 Sidebar,功能未减)。停在已退役 Tab 的旧安装会一次性迁移到对话页。
- 指挥条是全局唯一的新任务入口:Agent、`@目标`、五档权限模式、推理强度,回车即建会话并发出第一条指令;目标忙碌时入队,不吞回车。四个芯片都是下拉菜单而非循环按钮 —— 每一档看得见、可直达,权限模式每档还带一行说明。推理强度在开会话前就能定。
- 底色改为纯色:设计稿的 `#f6f5f1` / `#121514` 实机铺开偏黄/偏绿,色相饱和度各收一档;同时移除外壳上那层 webp 噪点纹理,它正是"底色不纯"的来源。

### 远程会话接管

- 新增三条中继薄代理:远程建会话、SSE 事件流(`?after=N` 全量回放后转实时)、多回合驾驶与叫停。
- 前端按 seq 续传,断线重连补回放不丢不重;审批复用既有的舰队审批接口。leocodebox 不复制远程会话状态。

### 视觉

- `tokens.css` 换成设计稿两套色板(深 `#121514` / 浅 `#f6f5f1`,主色 `#56f0b8` / `#0f766e`),仍走现有 HSL semantic token 体系;新增 7 个工作台专属表面 token。动效全部响应 `prefers-reduced-motion`。
- 设置栏目一个没减,只重新归组(外观移入工作区、插件移入系统),弹窗改 1000×660。

### 状态栏:AI 额度与状态

- 状态栏新增额度计,点开显示本机 AI 用量。借 CodexBar 的思路(不登录任何一家、只读各家 CLI 落在本机的状态),但严格区分「服务端下发的真实额度」与「本机日志累加值」:Codex 从 rollout 日志读权威 `rate_limits`(已用百分比 / 窗口 / 重置时间 / 套餐 / 余额),Claude 只能给近 5 小时的滚动 token 数并标注「本机统计」,读不到就说读不到,不填 0 也不编百分比。
- 未吸收:CodexBar 覆盖的 69 家里,Cursor / Gemini / Copilot / Bedrock 等靠浏览器 cookie 与各家后台 API 取数;本机实测这几家都没有落额度数据,需要另建凭据采集层,本版不做。

### 修复

- 移除 `.leocodebox-app-shell > * { position: relative }`。这条规则会改写每个直接子元素的定位,导致 Leoapi 面板掉到状态栏下方、"打开完整网关设置"的模态掉进文档流、指挥条下拉与远程弹层被主区盖住。改由四个在流子元素各自声明层级,浮层用 fixed / portal;状态栏补上原本靠该规则白拿的 `relative`(体检气泡定位依赖它)。新增断言防止规则被加回。

### 验证

- 前后端 typecheck 全绿;改动文件 eslint `--max-warnings=0` 通过;客户端单测 24 项全过;`npm run build` 通过;`npm run desktop:dev` 实机跑通。
- **尚未签名、未公证、未发布**:本机只有 Apple Development 证书,发布需 Developer ID Application 证书与公证 profile(见 `src/mac/leocodebox/docs/SIGNING.md`)。

## Android v1.0.0-alpha.5 - 2026-08-17

### 紧急修复

- 修复 alpha.4 无法覆盖安装：alpha.4 Release 附件误用了不同调试证书，Android 现场返回 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`。alpha.5 恢复与 alpha.1–alpha.3 相同的个人 Alpha 签名链，可直接从 alpha.3 覆盖安装。
- 完整携带 alpha.4 的助手闪退修复：VoiceInteraction 不再抢占会话窗口，截图与系统入口异常会降级而不是崩溃主进程。
- 修正 README 中与 alpha.4 Release 附件不一致的 SHA-256，不再把未闭环的产物当成可安装版。

### 发布门禁

- 新增 Android Alpha APK 校验脚本，同时核对 Standard/Power 包名、versionCode、versionName、APK 签名有效性和预期证书指纹。
- 发布前必须在已安装 alpha.3 的 Fold8 模拟器上用 `adb install -r` 通过 Standard/Power 覆盖安装，并做冷启动闪退检查。
- README 新增面向 Codex、Cursor、Claude Code 等 Agent 的完整交接手册；同步增加仓库级 `AGENTS.md`，并修正 BUILDING/CONTRIBUTING/CLAUDE 中已过时或相互冲突的 Android 发布说明。

### 验证

- Standard / Power 中文资源门禁、JVM 测试、Release lint 和 R8 双包构建一次通过；lint `0 errors`。
- Fold8 API 35 模拟器从 alpha.3 原地升级 Standard / Power 均返回 `Success`，安装后为 versionCode `100005`。
- Standard / Power 普通冷启动与 `ACTION_ASSIST` 冷启动均为 `Status: ok`，进程存活，Logcat 无 `FATAL EXCEPTION`。

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
- 修掉 alpha.3 起就红的 Release lint：补 `DETECT_SCREEN_CAPTURE`、`AssistState` 标 API 29、磁贴在 API 34 以下仍走旧 `startActivityAndCollapse` 但不再被 lint 判死刑。快捷方式按 Standard / Power 包名拆开。Release APK 交给 CI；本版不伪造 SHA，也不假装已发 GitHub Release。

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
