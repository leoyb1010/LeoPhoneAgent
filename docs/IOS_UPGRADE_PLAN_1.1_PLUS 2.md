# LeoPhoneAgent iOS 升级计划

状态：1.1.0（Build 23）阶段目标已完成、已安装真机，后续进入 1.1.x 稳定优化
范围：仅 iOS  
基线：LeoPhoneAgent 1.0，提交 `5940de5`  
目标版本：1.1 到 1.4  
使用场景：个人自用，不以 App Store 上架为前提

## 当前实施进度（2026-07-26）

1.1.0 阶段已完成：

- Build 14–18 完成版本化数据库迁移、本地 Artifact Tray、成果版本链、任务结果关联及可选 CloudKit CKAsset 同步。
- Build 19–20 完成个人任务模板、输入槽位、结构化输出、模板导入导出、首页/Composer 固定任务、列表密度与 Background Ready 策略。
- Build 21 完成 LeoHaptics、Reduce Motion、VoiceOver 与关键动效统一审计。
- Build 22 使用 iPhone 上的 1.0.12 Build 13 真实数据库副本完成 v0 → v3 迁移、完整性、外键、行数保持与幂等验证；签名 Release 和三扩展验证通过。
- Build 23 统一正式版本为 1.1.0（23），新增强制一次的本次更新说明与永久更新记录；正式 Archive 由 Team `48H5Y3LNUK` 签名，已覆盖安装到 iPhone 17 Pro Max 并成功启动。
- 安装后设备回读 1.1.0（23），实际数据库为 v3，3 个会话和 16 条消息保持不变，主 App 与 Widget Extension 进程均已确认。

已完成并进入 1.0.1：

- LeoPhoneAgent 独立 Bundle、App Group、iCloud 容器、URL Scheme、仓库链接与个人开发者签名。
- 聊天实时状态卡、会话级活动时间线和设备本地 SQLite 活动记录。
- 等待权限、浏览器接管、后台超时、并发限制等隐私安全原因提示。
- 权限确认页明确“访问什么”和“数据去哪里”，并统一关键触觉反馈。
- `LeoTheme`、`LeoMotion`、Dynamic Type、深浅色和 Reduce Motion 设计基线。
- 1.0.1 升级提示、设置内完整更新记录和仓库 `CHANGELOG.md`。
- 版本规则固定为逐补丁递增，当前已到 `1.0.12`，每次同时递增构建号。
- 1.0.1 已使用开发团队 `48H5Y3LNUK` 完成签名真机构建和覆盖安装。

1.0.2 已完成代码落地：

- 可分享诊断日志移除提示词、消息、回复摘要和工具内容预览，只保留结构化元数据。
- 浏览器动作取消覆盖加载、JavaScript、截图、文本提取和 DOM 等待；取消竞态立即返回并释放旧 Tab。
- 并发工具取消不再依赖“任务取消且用户取消”的双重条件，系统取消也会合成配对结果。
- 停止操作在存在排队消息时明确区分“停止当前并继续队列”和“停止全部并清空队列”。
- 新增 `AgentQueueStopPolicy` 纯逻辑契约与测试。

1.0.5 已完成代码落地：

- 自建 FFmpeg 框架已新增进程内协作取消入口，不依赖危险的进程级信号。
- 转码工作线程和串行锁等待都能响应任务取消，取消返回状态 130。
- 完整 FFmpeg 参数不再写入日志，媒体路径与文件名保持本地私密。

1.0.6 已完成代码落地：

- 新增主屏幕任务 Widget，支持隐私模式、任务深链与一键语音输入。
- iOS 26 长任务接入 Continued Processing，按真实 Agent 循环轮次报告进度。
- 系统中断继续进入可观察、可恢复的暂停链路，不承诺 iOS 不支持的无限后台执行。
- 后台诊断日志不再记录工具错误原文、输出预览、描述和完整网址。
- 新增 `IOS_SYSTEM_CAPABILITY_AUDIT_2026-07-26.md` 作为能力底图与后台实施边界。
- 1.0.6 Build 7 已使用开发团队 `48H5Y3LNUK` 完成签名构建，已覆盖安装并在 iPhone 17 Pro Max 成功启动；主 App 和 Widget Extension 进程均已验证。

1.0.7 已完成代码落地：

- 新增 Apple Capabilities 能力中心，以只读探针展示系统授权状态，不因浏览页面主动申请权限。
- 每项能力统一展示动作、示例、数据去向和 Agent Access 策略，并明确直接调用闸门与系统权限边界。
- Provider Onboarding 接入保存前真实测试：候选凭据先拉取模型并执行匹配能力的最小请求，失败时提供明确的“仍然保存”出口。
- 自动诊断日志继续改为元数据，清理请求正文、流响应预览、OAuth Token 片段、通知标题和浏览网址。
- 逐项实施结论记录于 `REVIEW_IMPLEMENTATION_AUDIT_2026-07-26.md`。
- 1.0.7 Build 8 已使用开发团队 `48H5Y3LNUK` 完成签名构建，覆盖安装到在线 iPhone 17 Pro Max 并成功启动；主 App 与本版本 Widget Extension 进程均已确认。

1.0.8 已完成代码落地：

- 将外观设置的选项模型、语言目录、字号行和自定义分段滑杆纯移动到独立设置支持文件。
- 将首页同步旋转状态与强制同步提示条纯移动到独立状态组件文件。
- `ContentView.swift` 由 5423 行降至 5189 行，本轮不改变 UI、信息架构、文案和动效。
- 通用 iOS 主 App 构建与独立逻辑测试 Bundle 编译已通过。
- 1.0.8 Build 9 已使用开发团队 `48H5Y3LNUK` 完成签名构建，覆盖安装到在线 iPhone 17 Pro Max 并成功启动；设备回读 1.0.8（9），主 App 与本版本 Widget Extension 进程均已确认。

1.0.9 已完成代码落地：

- Activity 独立数据库新增 `agent_run_state`，作为事件日志之外的设备本地当前状态，不修改 CloudKit schema。
- 数据库升级会从已有 Activity 事件回填每个 Run 的最新状态，兼容 1.0.1–1.0.8 数据。
- 进程首次打开时把上一进程遗留的非终态安全转为等待用户继续，覆盖流式文本硬终止的恢复盲区。
- 会话加载和启动徽章对账使用“持久 Run State + 旧消息尾部判断”的兼容策略；不自动执行任务。
- 新任务启动会终结同会话遗留的旧非终态，防止过期恢复标记重新出现。
- 主 App 与独立逻辑测试 Bundle 编译成功；SQLite 回填、恢复和旧 Run 取代语句已在内存数据库验证。
- 1.0.9 Build 10 已使用开发团队 `48H5Y3LNUK` 完成签名构建，覆盖安装到在线 iPhone 17 Pro Max 并成功启动；设备回读 1.0.9（10），主 App 与本版本 Widget Extension 进程均已确认。

1.0.10 已完成代码落地：

- 引入 `AgentProcessingTransition`，将旧 `isProcessing` 的四种布尔组合收敛为开始、停止和无变化三种显式结果。
- `didSet` 只通过显式转移选择原有分支，所有同步、卡顿监控、快照与通知副作用保持原位置和原顺序。
- 新增四种布尔边沿的纯逻辑契约测试，为后续逐项把副作用外移到转移处理器提供稳定入口。
- 通用 iOS 主 App 与独立逻辑测试 Bundle 编译成功，未重复尝试已知会挂起的模拟器测试执行器。
- 1.0.10 Build 11 已使用开发团队 `48H5Y3LNUK` 完成签名构建，覆盖安装到在线 iPhone 17 Pro Max 并成功启动；设备回读 1.0.10（11），主 App 与本版本 Widget Extension 进程均已确认。

1.0.11 已完成代码落地：

- `isProcessing.didSet` 已缩减为诊断快照更新与显式转移分发。
- started 分支移入专用处理器，保持云同步延迟、旧 hold 清理和卡顿监控的原始顺序。
- stopped 分支移入专用处理器，保持 post-stop hold、监控释放、安全快照、离屏通知和技能刷新的原始顺序。
- 后台/挂起/转场不触碰大型视图快照的历史安全守卫完整保留。
- 通用 iOS 主 App 与独立逻辑测试 Bundle 编译成功。
- 1.0.11 Build 12 已使用开发团队 `48H5Y3LNUK` 完成签名构建，覆盖安装到在线 iPhone 17 Pro Max 并成功启动；设备回读 1.0.11（12），主 App 与本版本 Widget Extension 进程均已确认。

1.0.12 已完成代码落地：

- 新增 `QuickTaskDefinition`、设备本地任务库和 `QuickTaskEntityQuery`，Siri 与快捷指令可动态读取任务。
- 新的 `RunQuickTaskIntent` 使用 AppEntity；旧 `QuickTaskIntent` 与八个 AppEnum raw ID 原样保留，专门承接历史快捷指令。
- 设置新增 Quick Tasks 管理页，支持新增、编辑、图标选择、排序、自定义任务删除和内置任务恢复。
- 内置任务不可删除，名称、提示词和图标可编辑；系统标识保持稳定，避免已有自动化丢失引用。
- 任务库保存后通知 App Shortcuts 刷新参数；主 App 构建和 App Intents 元数据生成成功。
- 新增稳定标识、归一化、补回内置任务和自定义任务生命周期测试；独立 `MinisTests.xctest` 已编译链接成功，未把模拟器执行写成测试通过。

1.0.4 已完成代码落地：

- 停止信号已从 shell 会话进入 iSH 原生代理层，原生同步等待支持协作取消。
- 取消后返回标准状态 130，且不注册未完成的文件结果。
- 已从无空格隔离路径重编 iSH ARM64 静态库，规避上游 Meson 路径拆分问题。

1.0.3 已完成代码落地：

- Activity 失败终态使用认证、限流、网络、工具和本地环境等稳定原因码，不持久化错误原文。
- 聊天错误卡与 Activity Timeline 共用重试、继续、检查 Provider 和重启本地环境策略。
- Kernel 启动失败覆盖层新增明确重试出口。
- 诊断日志不再写入模型错误正文、工具错误片段或 Provider 响应细节。
- shell 命令正文、工具 JSON、OAuth 请求/响应体、标题生成结果和浏览 URL 已从运行日志移除，仅保留长度、状态码与 host 等元数据。
- 新增 `AgentActivityFailureClassifier` 和恢复策略纯逻辑测试。

验证说明：独立逻辑测试 Bundle 已能编译链接；模拟器测试执行曾被外部运行器关闭，不能记为测试用例执行通过。iOS 模拟器整包链接受仓库内仅含 arm64 的 iSH/FFmpeg 预编译库限制，真机 arm64 构建为本项目的权威验收路径。

- 1.0.12 Build 13 已使用开发团队 `48H5Y3LNUK` 完成签名构建，覆盖安装到在线 iPhone 17 Pro Max 并成功启动；设备回读 1.0.12（13），主 App 与本版本 Widget Extension 进程均已确认。

## 版本与发布治理

1. 每次发布前先确定补丁版本，并同时更新 `MARKETING_VERSION`、`CURRENT_PROJECT_VERSION`、App 内 `LeoReleaseCatalog` 与根目录 `CHANGELOG.md`。
2. App 首次运行新版本时展示一次不可误关的“本次更新”；确认后不重复打扰。
3. “设置 → 关于 → 更新记录”永久保留所有正式版本记录。
4. 发布验收至少包含：`git diff --check`、逻辑测试构建、签名真机构建、覆盖安装、解锁状态启动和关键流程冒烟检查。
5. 不用版本升级换取表面效果；稳定性、数据兼容、可访问性与任务可恢复性优先。

## 品牌与来源清理规则

- 产品界面、Bundle、签名、深链、联网入口、仓库主链接和版本文档使用 LeoPhoneAgent / `leoyb1010` 自有身份。
- 1.0.1 已把“添加到主屏幕”切到 `leoyb1010.github.io/LeoPhoneAgent/launch.html`，页面源码位于 `docs/launch.html`；发布前需在自有仓库开启 GitHub Pages。
- iOS 技能浏览入口改为自有仓库 `skills/`，不再把旧项目技能仓库作为默认入口。
- `/var/minis`、`minis-*` 命令、历史数据库键和部分内部 Target/Type 名称暂作为数据与脚本兼容标识保留；它们不出现在产品品牌层。后续只能通过带迁移与回滚方案的独立版本重命名。
- GPL、第三方依赖许可证、上游来源与原作者法定署名必须保留在许可证/来源文档中；这不属于产品品牌残留。

## 一、结论与重点升级方向

LeoPhoneAgent 当前已经具备很强的底层能力，包括多模型、Linux 沙箱、浏览器自动化、原生设备工具、语音、Shortcuts、Live Activity、iCloud 同步、文件工作区、技能和记忆。下一阶段不应该继续简单堆功能，而应该把这些能力组织成一个可信、顺手、可观察的个人 Agent 产品。

最重要的五个升级方向如下：

1. **统一任务状态与执行控制**
   - 把模型思考、工具调用、浏览器操作、后台运行、等待授权、成功和失败统一成一套 Agent Activity 状态模型。
   - 用户随时知道 Agent 正在做什么、下一步是什么、是否需要自己处理、能否暂停或取消。

2. **重做聊天主流程，而不是只做表面换肤**
   - 优先升级输入区、消息层级、工具时间线、附件、语音、错误恢复和上下文提示。
   - 聊天页应成为任务控制台，而不只是消息列表。

3. **建立 LeoPhoneAgent 原生视觉与动效系统**
   - 使用冷灰石墨、银色层级和单一青蓝强调色。
   - 动效必须表达反馈、状态变化或层级，不加入纯装饰动画。
   - 统一动画时长、弹簧参数、触感反馈、材质、圆角和语义颜色。

4. **把隐藏能力变成可发现的能力中心**
   - 将 Calendar、Reminders、Health、HomeKit、Photos、Location、NFC、Bluetooth、Weather、Browser、Files、Speech 等能力集中展示。
   - 明确显示授权状态、可执行动作、示例指令和最近调用记录。

5. **围绕 iOS Shortcuts 做可靠自动化**
   - 不在应用内部模拟不可靠的常驻定时器。
   - 使用 App Intents、Shortcuts Automation、Live Activity 和本地通知构建个人工作流。
   - 提供可直接安装或创建的自动化模板。

## 二、产品定位

### 2.1 产品定义

LeoPhoneAgent 是一个运行在 iPhone 上的个人 Agent 控制台。它连接大模型、设备能力、浏览器和本地 Linux 环境，帮助用户完成跨应用、跨数据和长流程任务。

### 2.2 核心体验原则

- **本地优先**：会话、凭据、工作区和个人配置优先保存在设备或用户自己的 iCloud 中。
- **行动透明**：每一步工具执行都有状态、来源、输入摘要、输出摘要和恢复路径。
- **权限最小化**：需要时再请求权限，允许按能力、会话或单次任务控制。
- **可中断**：耗时任务必须支持暂停、取消、继续或转到后台。
- **可恢复**：网络错误、模型切换、应用切后台和工具失败不能让任务静默消失。
- **个人可定制**：重点定制默认模型、快捷动作、首页内容、界面密度和权限策略，而不是提供无意义的装饰选项。

## 三、当前代码与体验审计

### 3.1 已有优势

- SwiftUI 原生应用，已包含 iPhone 与 iPad 分栏适配。
- 多模型 Provider、模型组、故障回退和模型快速测试。
- iSH ARM64 与 Alpine Linux 沙箱。
- 浏览器自动化、多标签页、截图、DOM 和 Cookie 工作流。
- Skills、Memory、Soul、MCP、环境变量与文件工作区。
- Calendar、Reminders、HealthKit、HomeKit、Photos、Location、Maps、Weather、Bluetooth、NFC、Speech、Vision、Media、Clipboard、Notifications 等原生桥接。
- Share Extension、File Provider、Widget、App Intents、Home Screen Quick Actions 与 Live Activity。
- 后台任务跟踪、本地通知、iCloud 同步和会话恢复。
- 已有语音输入、语音播放、图片、视频、音频和 Markdown 渲染能力。

### 3.2 主要问题

#### A. 能力分散，缺少统一入口

设置、权限、技能、MCP、文件、浏览器和原生工具分散在不同页面。新用户很难知道应用到底能做什么，也难以判断某项能力是否已经配置成功。

#### B. 任务状态表达不统一

当前存在多个独立状态表现，包括会话行徽标、聊天工具预览、思考块、浏览器忙碌状态、后台提示、Live Activity 和 Toast。它们缺少统一的状态语义与交互规则。

#### C. 动效已存在，但没有系统化

代码中使用了多组不同的 `easeInOut`、`spring`、重复脉冲和触感反馈。缺少统一 Token，也未形成全面的 Reduce Motion 策略。升级时容易出现动画节奏不一致和性能回退。

#### D. 核心视图体积过大

- `SelectableMarkdownView.swift` 约 8000 行
- `AIChatView.swift` 约 5800 行
- `ContentView.swift` 约 5400 行
- `CollectionViewMessageListV3.swift` 约 4300 行

直接在这些文件中大规模改 UI 风险较高。需要先抽出视觉组件、任务状态组件和交互状态机，再逐步替换现有界面。

#### E. 设置界面缺少 LeoPhoneAgent 品牌层级

当前设置主要使用系统 List 和多色圆形图标，功能完整但更像通用系统设置。需要减少无语义的彩色图标，将颜色集中用于品牌强调和真实状态。

#### F. 独立产品信息与兼容边界

- Provider 数据共享页已改为 LeoPhoneAgent 自有本地说明，不再把上游隐私页作为产品政策。
- 添加到主屏幕已切换到 LeoPhoneAgent 自有 GitHub Pages launcher 与源码。
- 部分内部类型、持久化目录和命令仍保留 `Minis`，用于数据、脚本与二进制兼容；不作为用户可见品牌。

## 四、视觉系统方案

### 4.1 设计方向

设计语言：**Personal Agent Console**  
风格：冷静、精确、原生、具有轻微未来感  
设计参数：

- `DESIGN_VARIANCE = 6`
- `MOTION_INTENSITY = 6`
- `VISUAL_DENSITY = 6`

这意味着界面保留 iOS 原生结构和可访问性，但在聊天控制台、任务状态和关键过渡中建立明显的 LeoPhoneAgent 特征。

### 4.2 色彩

建立 `LeoTheme` 语义颜色，不在业务视图中继续散落硬编码颜色。

| Token | 用途 |
|---|---|
| `surfaceBase` | 页面基础背景 |
| `surfaceRaised` | 输入区、浮层和二级表面 |
| `surfaceInteractive` | 可点击内容背景 |
| `textPrimary` | 主要文字 |
| `textSecondary` | 描述和辅助信息 |
| `accent` | LeoPhoneAgent 青蓝强调色 |
| `running` | 正在执行，仅用于真实运行状态 |
| `success` | 完成状态 |
| `warning` | 需要注意或等待用户 |
| `destructive` | 删除、停止和不可逆操作 |

规则：

- 默认使用系统 Light、Dark 和高对比度适配。
- 品牌强调色全局只使用一套。允许用户从少量经过校准的 Accent 预设中选择，但选择后全 App 统一。
- Provider 品牌色只允许出现在 Provider 身份标识中，不扩散到页面结构。
- 不使用通用 AI 紫色渐变和大面积外发光。

### 4.3 字体与信息层级

- 使用系统 SF 字体与 Dynamic Type。
- 导航标题和任务标题使用语义字体，不硬编码大字号。
- 运行状态、耗时、Token 与文件大小可使用 `monospacedDigit()`，不将整个应用改成等宽字体。
- 正文优先保证阅读长度与选中复制体验。
- 所有主要界面支持更大辅助字体，不只支持现有的应用内字号滑杆。

### 4.4 圆角与材质

- 页面容器：连续圆角 16pt。
- 输入与紧凑控件：连续圆角 12pt。
- 状态胶囊：全圆角，仅用于状态和短操作。
- 模态浮层使用系统 Material，支持 Reduce Transparency 的纯色回退。
- 卡片只在确实表达层级或可展开状态时使用，普通设置项继续使用分组与留白。

### 4.5 SF Symbols

- 统一 Symbol weight 与 scale。
- 运行、暂停、等待、完成和失败使用固定符号映射。
- 不为每个列表项使用不同的装饰底色圆形图标。
- `sparkles` 只在真正表示 Agent 生成或智能处理时使用。

## 五、动效与动画系统

### 5.1 动效原则

每个动画必须至少表达以下一项：

- 用户操作已被接收。
- 页面层级或焦点发生变化。
- Agent 状态发生变化。
- 内容从临时状态转为稳定状态。
- 错误已经恢复或需要用户介入。

无法说明动效目的时，不添加动画。

### 5.2 Motion Token

建议创建：

```text
src/ios/DesignSystem/Motion/LeoMotion.swift
src/ios/DesignSystem/Motion/LeoHaptics.swift
src/ios/DesignSystem/Motion/ReducedMotionModifier.swift
```

| Token | 建议值 | 用途 |
|---|---:|---|
| `instant` | 0.12s | 图标、复制、轻量反馈 |
| `quick` | 0.20s | 按钮、菜单、输入区状态 |
| `standard` | 0.32s | Sheet 内步骤、状态面板展开 |
| `emphasis` | 0.46s | 新任务开始、任务完成 |
| `interactiveSpring` | response 0.26, damping 0.84 | 拖动、Composer 展开 |
| `gentleSpring` | response 0.38, damping 0.90 | 卡片与面板过渡 |

所有动画只优先改变 `transform`、`opacity` 或由 SwiftUI 管理的布局。避免高频改变阴影半径、模糊半径和大面积材质。

### 5.3 必做动效

#### 会话列表

- 新会话从 Composer 行平滑转为真实会话行。
- 运行中的会话使用低频、低振幅的状态反馈，不持续旋转复杂图形。
- 完成时使用一次性状态过渡和轻触感，不持续闪烁。
- 搜索框从搜索按钮展开时保持空间来源一致。

#### 聊天页

- 输入区在文本、语音、附件和执行中状态之间使用同一容器的形态变化。
- 发送后输入内容收束成用户消息，减少界面跳变。
- 工具执行按照真实顺序进入 Activity Timeline。
- 思考、工具调用和最终回答之间使用层级过渡，不让所有块同时抢夺注意力。
- 新 Token 流式输出不逐字做大幅动画，只在段落首次出现时轻微淡入。

#### 后台与 Live Activity

- 前台任务转入后台时，在聊天页明确显示状态接管，不只发 Toast。
- 从 Live Activity 返回应用时，使用 `matchedGeometryEffect` 或等价的共享状态过渡连接到对应会话。
- 多任务并发时，Live Activity 和 App 内必须使用同一状态文本和图标映射。

### 5.4 触感反馈

- 发送任务：轻触感。
- 需要用户批准：警告触感，仅一次。
- 任务成功：成功触感，仅在用户仍位于相关界面时触发。
- 取消和删除：中等触感。
- 拖动跨过有效吸附点：选择触感。

### 5.5 无障碍与性能

- 全局读取 `accessibilityReduceMotion`。
- Reduce Motion 开启时，所有移动和缩放动画降级为短淡入淡出或即时切换。
- VoiceOver 必须读出任务状态变化，但不能因流式 Token 高频打断用户。
- ProMotion 设备目标保持稳定 60fps 以上，核心滚动路径以 120Hz 设备测试。
- 使用 Instruments 的 SwiftUI、Core Animation 和 Time Profiler 验收聊天滚动与流式输出。

## 六、界面升级方案

### 6.1 会话首页

目标：用户打开应用后能立即开始任务，也能快速看清正在运行和最近完成的工作。

建议结构：

1. 顶部品牌与全局状态。
2. 正在运行区域，仅在存在任务时显示。
3. 最近会话列表，保留当前时间分组和置顶逻辑。
4. 单一主操作：新建任务。
5. 搜索作为次级操作，不与新建任务形成两个同权重浮动按钮。

升级内容：

- 将当前双 FAB 逻辑改为一个主 Composer 或底部操作区。
- 会话行统一显示标题、模型、最新动作、相对时间和一个真实状态。
- 长按菜单保留，但常用动作通过 Swipe Actions 提供。
- 多选工具栏继续使用系统语义，减少自定义叠层。
- 空状态提供 3 到 4 个真实可执行的个人任务模板。

### 6.2 聊天任务控制台

目标：让用户同时看懂对话内容和 Agent 执行过程。

建议将聊天内容分成三层：

- **Conversation**：用户指令和最终回答。
- **Activity**：思考、工具、浏览器、文件和权限步骤。
- **Artifacts**：生成的文件、图片、音频、网页和结构化结果。

核心升级：

- 工具调用统一为 Activity Timeline，不再由不同工具自行决定展示样式。
- 默认折叠低价值技术日志，保留错误、授权和可交互结果。
- 允许用户在任务执行中打开一个“正在做什么”面板。
- 提供暂停、停止、继续、后台运行和重试。
- 错误块必须包含：失败步骤、原因摘要、是否已自动重试、用户可采取的操作。
- 输出文件集中进入 Artifact Tray，可预览、分享、打开文件位置或继续交给 Agent。
- 上下文、Token、Memory 和 Skill 状态移入统一 Session Inspector。

### 6.3 Composer 输入区

Composer 是 1.1 最重要的单个组件。

状态：

- 空闲文本输入
- 多行文本
- 附件已选择
- 语音录入
- 正在发送
- Agent 正在运行
- 等待用户确认
- 编辑已发送内容

定制项：

- 常驻快捷动作最多 3 个，由用户配置。
- 默认模型或模型组快速切换。
- 相机、相册、文件、剪贴板和语音统一进入附件入口。
- 长按发送按钮可选择“等待结果”“后台运行”“使用临时会话”。
- 支持草稿恢复和附件失败恢复。

### 6.4 能力中心

新增 `CapabilitiesView`，集中管理原生能力与权限。

每个能力展示：

- 能力名称和一句具体说明。
- 当前授权状态。
- 可执行操作清单。
- 一条可直接运行的示例指令。
- 最近一次使用时间与结果。
- 权限范围和数据去向。

建议分组：

- 个人信息：Contacts、Calendar、Reminders、Health。
- 环境与设备：Location、Weather、Bluetooth、NFC、HomeKit。
- 内容与媒体：Photos、Vision、Speech、Player、Clipboard。
- 工作工具：Files、Browser、Notifications、Shortcuts。

### 6.5 设置

设置首页重组为：

- Agent 与模型
- 能力与权限
- 自动化
- 数据与隐私
- 外观与交互
- 高级运行环境
- 关于

调整：

- Provider、模型组、Token Usage 合并到“Agent 与模型”。
- Skills、Soul、Memory、MCP 保持独立详情页，但首页不再平铺过多入口。
- Storage、Shared Folders、Mounted Folders、iCloud 合并到“数据与文件”。
- Background、Live Activity、Notifications、Shortcuts 合并到“自动化与后台”。
- Rootfs、Environment Variables、Logs、Debug 放入“高级”。
- 替换上游隐私政策链接，个人自用版可以提供本地 Markdown 隐私说明。

### 6.6 Provider 首次配置

升级为清晰的四步流程：

1. 选择 Provider。
2. 选择认证方式。
3. 验证凭据并测试模型。
4. 选择默认模型并完成。

要求：

- 每一步都有明确进度和返回行为。
- 验证错误显示在对应输入下方。
- 保存前执行真实的最小请求测试。
- 清楚说明哪些数据会发送给 Provider。
- 完成后直接创建可用的新会话，避免用户回到设置后不知道下一步。

## 七、定制化方案

定制能力优先服务效率，不做无限主题编辑器。

### 7.1 建议开放的定制项

- 系统、浅色、深色外观。
- 3 到 4 个经过校准的全局 Accent 预设。
- 紧凑、标准、舒展三档会话列表密度。
- 首页默认打开：最近会话、新任务、运行中任务。
- Composer 常驻快捷动作。
- 默认模型组、默认 Thinking Level 和默认运行模式。
- 新任务默认前台或后台策略。
- 工具执行详情默认展开级别。
- 触感反馈开关和 Reduce Motion 跟随系统。
- App Icon 变体，全部使用 LeoPhoneAgent 品牌图形。

### 7.2 不建议开放的定制项

- 任意 RGB 颜色和任意渐变编辑器。
- 每个页面独立主题。
- 任意动画速度滑杆。
- 自定义字体文件。
- 会破坏状态语义的图标替换。

## 八、能力升级路线

### 8.1 P0：可靠性与可观察性

#### 统一 Agent Activity Model

建立跨 App 内、Live Activity、Widget 和通知复用的状态模型：

```swift
enum AgentActivityPhase {
    case preparing
    case thinking
    case usingTool
    case waitingForPermission
    case waitingForUser
    case suspended
    case completed
    case failed
    case cancelled
}
```

每个状态包含：

- sessionId
- 当前步骤与工具
- 用户可执行动作
- 开始时间与耗时
- 可安全展示的输入输出摘要
- 错误与恢复策略

#### 可暂停、可取消、可恢复

- 所有长任务提供一致的停止入口。
- 模型流、浏览器任务和并发工具统一响应取消。
- 应用重启后识别未正常结束的任务，并提供恢复或归档。
- 避免只在 UI 层隐藏任务，底层仍继续消耗 Token。

#### 本地执行记录

- 提供按会话查看的 Activity Log。
- 默认隐藏敏感参数和凭据。
- 支持复制诊断摘要，不需要上传到任何服务器。

### 8.2 P1：个人自动化

#### Shortcuts 模板库

提供可配置模板：

- 分享网页后总结并保存到指定文件夹。
- 拍照识别并写入提醒事项。
- 每日摘要，通过 Shortcuts 的个人自动化触发。
- 从剪贴板创建任务。
- 对指定会话继续追问并返回结果。
- 运行任务后将生成文件传给下一个 Shortcut Action。

#### App Intents 完善

- 参数支持默认模型组、Thinking Level、是否等待结果、附件和目标会话。
- 返回结构化结果，而不只返回纯文本。
- 对超时或进入后台给出明确结果状态。
- 在 Shortcuts 中提供更清晰的动作命名、图标和参数说明。

#### 快捷动作

- Home Screen Quick Actions 可由用户选择 3 个。
- Action Button、Control Center 和 Spotlight 入口作为后续增强项。
- 锁屏与 Dynamic Island 只展示非敏感摘要。

### 8.3 P1：上下文与记忆控制

- Session Inspector 展示当前模型、上下文占用、Memory、Skills、MCP 和挂载文件夹。
- 允许把当前对话中的事实提升为长期 Memory。
- 支持一次性会话，不写入长期 Memory。
- 展示自动压缩与 Offload 的发生时间和影响。
- 提供“这条信息为什么进入上下文”的解释入口。

### 8.4 P1：Artifact 工作流

- 统一管理 Agent 生成的文件、网页、图片、音频和视频。
- 支持版本、预览、Quick Look、分享和继续编辑。
- Artifact 与产生它的工具步骤相互跳转。
- File Provider 中的命名与 App 内一致。
- 删除会话时单独确认是否删除 Artifacts。

### 8.5 P2：智能任务模板

- 用户可以保存一条成功任务为模板。
- 模板只保存必要 Prompt、模型、能力和输入槽位。
- 执行前展示将使用的权限和外部 Provider。
- 模板可以导出为本地文件，但不引入公共模板市场。

## 九、技术实施路线

### 9.1 先建立 Design System

建议目录：

```text
src/ios/DesignSystem/
  Theme/
    LeoTheme.swift
    LeoColors.swift
    LeoTypography.swift
    LeoShape.swift
  Motion/
    LeoMotion.swift
    LeoHaptics.swift
    ReducedMotionModifier.swift
  Components/
    AgentStatusView.swift
    AgentActivityRow.swift
    LeoComposer.swift
    LeoBanner.swift
    LeoEmptyState.swift
    LeoErrorState.swift
    ArtifactCard.swift
```

### 9.2 拆分超大视图

#### `ContentView.swift`

拆分为：

- `SessionHomeView`
- `SessionListView`
- `SessionRow`
- `SessionSearchController`
- `SessionSelectionToolbar`
- `SettingsRootView`
- `AppearanceSettingsView`

#### `AIChatView.swift`

拆分为：

- `ChatScreen`
- `ChatNavigationBar`
- `ChatMessageSurface`
- `AgentActivitySurface`
- `ChatComposerHost`
- `ChatOverlayCoordinator`
- `SessionInspector`

原则：先抽取并保持行为不变，再升级视觉。不要在同一个提交里同时重构状态管理和替换全部 UI。

### 9.3 统一状态源

- Agent 任务状态由单一 Store 提供。
- App 内、Live Activity、Widget 和通知只消费映射结果。
- 禁止每个视图自己推断“是否运行中”。
- 动画由状态转换触发，不由零散 Boolean 组合触发。

### 9.4 Feature Flags

建议使用本地 Feature Flags：

- `newSessionHome`
- `newComposer`
- `activityTimeline`
- `capabilitiesCenter`
- `artifactTray`
- `newSettingsRoot`

个人使用版仍需要 Flag，方便新界面出现严重问题时快速回退。

## 十、版本与阶段计划

### 1.1：视觉基础与聊天核心

目标：让日常主流程明显提升，同时控制改动风险。

交付：

- LeoTheme、LeoMotion、LeoHaptics。
- 新 Composer。
- 统一 Agent Status 和 Activity Timeline 第一版。
- 会话行与聊天错误状态统一。
- Reduce Motion、Dynamic Type 和 VoiceOver 基线。
- 移除用户可见的上游隐私政策链接。
- 拆分 `ContentView` 和 `AIChatView` 的第一批视觉组件。

完成标准：

- 新建任务到成功完成的全流程使用统一状态。
- 发送、运行、等待授权、失败和完成均有清楚反馈。
- 主聊天滚动无明显掉帧回退。
- Reduce Motion 开启后没有持续脉冲和大幅位移动画。

### 1.2：能力中心与设置重组

交付：

- Capabilities Center。
- 权限状态、示例指令与最近调用。
- 设置首页重组。
- Provider 首次配置流程升级。
- Session Inspector。
- 本地隐私和数据流说明。

完成标准：

- 用户无需阅读文档即可找到所有原生能力。
- 每项权限都能从能力中心检查和跳转修复。
- 新 Provider 配置后可直接完成一次测试对话。

### 1.3：自动化与任务可靠性

交付：

- 统一 Agent Activity Model 完整版。
- 暂停、停止、继续与异常恢复。
- Shortcuts 模板和结构化输出。
- Live Activity 与 App 内状态统一。
- 本地 Activity Log。

完成标准：

- 前台转后台后任务状态不丢失。
- 用户可以明确取消真实底层任务。
- Shortcuts 触发的任务可以返回完成、失败或后台继续的明确结果。

### 1.4：Artifacts 与深度定制

交付：

- Artifact Tray 和文件版本体验。
- 保存成功任务为个人模板。
- 首页、Composer 和默认运行策略定制。
- Accent、密度、触感和 App Icon 预设。

完成标准：

- 生成内容可以从任务步骤、聊天和 Files 三处一致访问。
- 定制项不会破坏品牌色、状态语义或无障碍。

## 十一、优先级矩阵

| 项目 | 优先级 | 用户价值 | 技术风险 | 建议版本 |
|---|---|---:|---:|---|
| Design System 与 Motion Token | P0 | 高 | 低 | 1.1 |
| 新 Composer | P0 | 很高 | 中 | 1.1 |
| Agent Activity Timeline | P0 | 很高 | 中 | 1.1 |
| 统一任务状态模型 | P0 | 很高 | 高 | 1.1-1.3 |
| 错误恢复与真实取消 | P0 | 很高 | 高 | 1.1-1.3 |
| Capabilities Center | P1 | 高 | 中 | 1.2 |
| 设置重组 | P1 | 中 | 中 | 1.2 |
| Provider Onboarding | P1 | 高 | 中 | 1.2 |
| Session Inspector | P1 | 高 | 中 | 1.2 |
| Shortcuts 模板 | P1 | 很高 | 中 | 1.3 |
| Live Activity 状态统一 | P1 | 高 | 中 | 1.3 |
| Artifact Tray | P1 | 高 | 高 | 1.4 |
| 个人任务模板 | P2 | 中 | 中 | 1.4 |
| 深度外观定制 | P2 | 中 | 低 | 1.4 |

## 十二、用户故事

### 查看任务状态

Given 我启动了一个需要浏览器和文件操作的任务  
When Agent 正在执行多个步骤  
Then 我能看到当前步骤、已完成步骤、等待原因和可用控制操作

### 取消任务

Given 一个任务正在消耗模型 Token 或执行工具  
When 我点击停止并确认  
Then 底层请求和工具执行都被取消，界面显示已取消而不是继续后台运行

### 修复权限

Given 某个日历任务因权限不足失败  
When 我打开失败步骤  
Then 我看到缺少的权限、数据用途和跳转系统设置的按钮

### 创建自动化

Given 我希望每天早上运行一条摘要任务  
When 我选择对应自动化模板  
Then LeoPhoneAgent 帮我生成 Shortcuts 配置，并明确说明触发条件和返回结果

### 管理生成文件

Given Agent 生成了 Markdown、图片和音频  
When 任务完成  
Then 我能在 Artifact Tray 预览、分享、定位文件或继续让 Agent 编辑

## 十三、成功指标

个人使用版不需要上传产品分析数据，指标可通过本地诊断和人工测试记录。

### 体验指标

- 从启动到发送第一条任务的操作不超过 2 个主要动作。
- 用户能在 3 秒内判断一个任务处于运行、等待、失败或完成状态。
- Provider 首次配置可以在一个连续流程中完成测试。
- 任何原生能力最多通过 3 层导航到达。

### 可靠性指标

- 取消操作不会留下继续运行的模型流或浏览器任务。
- 前后台切换后，运行状态与真实底层状态一致。
- UI 不出现无法恢复的永久 Loading。
- 核心聊天和会话列表保持现有稳定性，不引入新的 AttributeGraph 生命周期问题。

### 性能指标

- 长会话滚动保持稳定帧率。
- 流式回答期间主线程无持续长任务。
- 首屏不因读取完整会话内容而阻塞。
- 动效只在可见元素上运行，进入后台立即停止非必要动画。

### 无障碍指标

- Dynamic Type 最大常用档位下核心操作不被遮挡。
- VoiceOver 可以完成新建、发送、确认权限、停止和查看结果。
- Reduce Motion 与 Reduce Transparency 均有明确降级。
- 所有状态不只依赖颜色表达。

## 十四、测试策略

### 单元测试

- Agent Activity 状态转换。
- 取消、暂停和恢复逻辑。
- 状态到 Live Activity、通知和 App 内显示的映射。
- Permission 与 Capability 状态映射。
- Composer 状态机。

### UI 测试

- 新任务和草稿恢复。
- 文本、语音和附件发送。
- 工具执行、用户授权、失败、重试和取消。
- 前后台切换与 Live Activity 返回。
- 大字号、Dark Mode 和 Reduce Motion。

### 性能测试

- 100、500、1000 条消息会话滚动。
- 多工具并发执行时的界面刷新。
- 长 Markdown、代码块和图片混排。
- 语音波形与流式文本同时工作。

### 真机矩阵

- 当前主力 iPhone。
- 一台较旧的 iPhone，检查内存和动画性能。
- iPad，确认 NavigationSplitView 和键盘操作没有回退。
- Light、Dark、高对比度、最大常用字号、Reduce Motion。

## 十五、明确不做

本轮不包含：

- Android UI 与发布适配。
- 公共账号系统和 LeoPhoneAgent 云端服务器。
- 多人协作和共享工作区。
- 公共技能或模板市场。
- 绕过 iOS 限制的永久后台进程。
- 在 App 内实现不可靠的通用 Cron 调度器。
- 为了视觉效果引入大面积 3D、粒子或持续发光动画。
- 一次性重写整个聊天渲染与 Markdown 引擎。

## 十六、实施顺序建议

建议严格按以下顺序启动开发：

1. 创建 Design System、Motion Token 和无障碍基线。
2. 定义统一 Agent Activity Model，但先通过适配器接入现有状态。
3. 抽取并替换 Composer。
4. 建立 Activity Timeline 与错误恢复 UI。
5. 升级会话列表和首页。
6. 重组设置并加入 Capabilities Center。
7. 统一 Live Activity、通知和 App 内状态。
8. 完善 Shortcuts 与自动化模板。
9. 建立 Artifact Tray。
10. 最后加入深度定制项。

不要先从主题颜色或启动动画开始。LeoPhoneAgent 最有价值的升级，是让任务执行变得可见、可控、可恢复，然后再用统一视觉和动效把这一套体验做得精致。

## 十七、开始开发前的待确认项

- 主力测试 iPhone 型号和系统版本。
- 是否同时保留 iPad 优化，默认建议保留。
- 最常用的三个个人工作流，用于决定首页模板和 Composer 快捷动作。
- 默认使用的 Provider 与模型组。
- 是否需要继续使用 iCloud 多设备同步。
- 是否需要为旧会话和旧设置提供完整迁移。

这些问题不会阻塞 1.1 的 Design System、Composer 和 Activity Timeline 原型，可以在第一阶段开发过程中确定。

## 十八、Product Design 插件复核

本轮使用 Product Design 的 Combined Audit 框架，从任务入口、信息架构、交互摩擦、信任、默认状态、错误恢复、无障碍和一致性八个角度复核了升级计划。

### 18.1 复核后提高优先级的项目

#### 任务入口必须收敛

当前首页同时存在新建、搜索、菜单和多种会话状态入口。1.1 应保留一个明确的主任务入口，将搜索和管理动作降为次级，避免用户打开应用后先判断控件而不是直接发起任务。

#### 权限解释必须出现在失败现场

Capabilities Center 不能替代上下文内错误恢复。日历、照片、健康等权限失败时，聊天中的对应 Activity Step 必须解释缺少什么、为什么需要、将发送到哪里，以及如何修复。

#### 信任信息需要与 LeoPhoneAgent 独立

Provider Onboarding 中的数据共享说明是关键的信任界面。必须移除上游隐私政策链接，并提供 LeoPhoneAgent 本地说明，清楚区分：

- 保存在设备上的数据。
- 同步到用户 iCloud 的数据。
- 直接发送给所选模型 Provider 的内容。
- Agent 调用原生设备能力时读取或写入的数据。

#### 状态不能只靠颜色和动画

运行、等待、完成和失败必须同时使用文字、图标和可访问性标签。持续旋转、脉冲和颜色变化不能成为唯一提示，尤其需要考虑 VoiceOver、Reduce Motion 和色觉差异。

#### 空状态和错误状态属于主流程

以下状态需要和成功界面一起设计并验收：

- 没有 Provider。
- Provider 无效或额度不足。
- 没有会话。
- 权限被拒绝。
- Rootfs 尚未安装或启动失败。
- 工具执行超时。
- 应用从后台恢复但任务已经终止。
- Artifact 文件已被外部移动或删除。

### 18.2 正式视觉审计的证据限制

Product Design 的正式 Audit 要求本轮实际捕获完整流程截图，并将每项结论绑定到对应画面。本轮未将源码审阅冒充为视觉审计。

当前状态：

- iPhone 17 Pro Max 已配对并在线。
- iPad Pro 13-inch 已配对并在线。
- Xcode 已登录开发团队 `48H5Y3LNUK`。
- 新 Bundle ID 的自动签名与 Development Provisioning Profiles 已生成并验证。
- 主应用、Share、File Provider、Widget 与 App Intents 的签名真机构建已通过。
- 包含聊天状态卡与会话 Activity Timeline 的最新签名版已安装到配对 iPhone，Bundle ID 为 `com.leoyuan.leophoneagent`。
- 2026-07-26 最新一次 `devicectl` 启动成功，签名、安装与主进程启动链路均已验证。
- 正式视觉审计仍需将构建安装到真机并实际走完流程，以捕获可靠截图。

设备解锁后，应补做以下六条真实流程审计：

| 步骤 | 捕获流程 | 重点检查 | 当前健康状态 |
|---:|---|---|---|
| 1 | 冷启动到新建任务 | 主操作是否明确、空状态、键盘焦点 | 待截图验证 |
| 2 | 添加首个 Provider | 数据说明、步骤进度、验证错误、完成出口 | 待截图验证 |
| 3 | 发送含附件的任务 | Composer 状态、附件恢复、发送反馈 | 待截图验证 |
| 4 | 工具执行与权限确认 | Activity 层级、风险说明、取消与重试 | 待截图验证 |
| 5 | 转入后台并从 Live Activity 返回 | 状态一致性、隐私摘要、恢复定位 | 待截图验证 |
| 6 | 能力与外观设置 | 信息架构、Dynamic Type、触控目标、对比度 | 待截图验证 |

每一步需要保存稳定画面，记录优势、UX 问题、可见的无障碍风险和截图无法确认的测试项。只有完成这组截图后，才能对视觉层级、间距、对比度和实际动效节奏给出证据充分的最终结论。

### 18.3 插件复核结论

Product Design 复核支持本计划的总体顺序，但进一步强调：

1. 首先解决任务入口与执行状态，而不是首先制作首页装饰。
2. 将信任、权限和失败恢复视为核心产品界面。
3. 设计系统必须覆盖空、错、等、停、恢复，不只覆盖成功状态。
4. 真机截图审计应在 1.1 视觉实现前后各进行一次，形成可比较的基线。

## 十九、2026-07-26 代码评审吸收与实施状态

本节合并《LeoPhoneAgent 升级计划评审与补充》的代码证据与路线修订。后续开发以本节修正后的顺序为准，原计划中与代码现实冲突的假设不再执行。

### 19.1 已采纳的路线修正

1. 在 1.1 视觉改造之前插入 P0.5 快速修复包，优先降低隐私、权限与错误能力声明风险。
2. Composer 的真实拆分起点是 `AIChatView.swift` 内的 `inputBar` 及其子组件，不把 `ChatInputBar.swift` 误当成完整 Composer。
3. Activity Timeline 使用独立面板或 sheet，不修改 `CollectionViewMessageListV3` 的 cell 结构。
4. Motion token 首轮沿用现状的 0.12、0.20、0.28、0.35 秒与 spring response 0.3，避免同时引入视觉变化和布局回归。
5. 状态模型在 1.1 只增加执行日志、取消补洞、只读派生相位和统一状态映射，不拆 `isProcessing.didSet`；后者延后到 1.3。
6. Widget 被视为从零新增功能；Live Activity 服务端 push 持续更新明确不做。
7. Activity 数据在 1.1 保持 device-local，不接入 CloudKit V1/V2。
8. 测试基建先于消息列表和数据层重构，所有新状态逻辑优先写成不依赖 SwiftUI 的纯类型。

### 19.2 P0.5 实施清单

| 项目 | 状态 | 验证证据 |
|---|---|---|
| Live Activity 隐私默认开启，同时保留用户已保存选择 | 已完成 | 默认值使用持久键优先，否则为 `true` |
| NFC 与 Bluetooth 纳入应用内权限闸门 | 已完成 | `allCommands` 已补两项并在权限设置显示 |
| NFC NDEF entitlement | 已完成 | 已加入 `NDEF`，签名真机构建通过 |
| 移除未使用的 HealthKit 临床病历 entitlement | 已完成 | `health-records` 声明已删除 |
| 移除未实现的 BGTask、fetch、remote notification 声明 | 已完成 | Info.plist 仅保留实际使用的 audio 与 location |
| Photos 权限文案覆盖查询、整理与删除能力 | 已完成 | Info.plist 文案已修正 |
| List Sessions 返回结构化 `[SessionEntity]` | 已完成 | App Intents 元数据生成与真机构建通过 |
| Get Session Status 直接接收 `SessionEntity` | 已完成 | App Intents 元数据生成与真机构建通过 |
| OAuth 日志不再记录完整授权 URL | 已完成 | 6 个 Provider 只记录授权 host |
| 上游隐私政策链接替换为本地真实披露 | 已完成 | Settings 与 Provider 同意页已更新 |
| Skills WebView User-Agent、iCloud 诊断标题与 Quick Action 标识品牌化 | 已完成 | 用户可见与系统集成标识已替换 |
| GitHub issue/PR 模板与第三方许可主语修正 | 已完成 | 仓库协作文件已独立化 |
| 提示词正文写入磁盘日志 | 当前代码已无此问题 | 队列日志只记录字符数、附件数和队列长度 |
| LeoTheme / LeoMotion / LeoHaptics 基础层 | 已完成第一版 | 新增语义颜色、间距、圆角、触控、现状动效 token 与统一触感入口 |
| 三处 `TimelineView(.animation)` Reduce Motion 分支 | 已完成 | 会话标题、TTS 合成与语音转写在减少动态效果时显示静态状态 |
| Browser 无限旋转与呼吸动画 Reduce Motion 分支 | 已完成 | 地址栏与 Agent 浏览遮罩在减少动态效果时停止循环动画 |
| View 层裸触感调用收敛 | 进行中 | 已迁移错误复制、发送手势、FAB、文件路径和行内代码反馈；ViewModel 中历史调用留待职责迁移 |
| `ChatColors` 与 `SelectableMarkdownTheme` 纯抽离 | 已完成 | 保持原有色值和渲染行为，签名真机构建通过 |
| device-local Activity Log | 已完成第一版 | 独立 `agent-activity.db`，WAL，5000 条滚动上限；不记录 prompt、工具参数、输出或 Provider 回复 |
| 只读 `AgentActivityPhase` 派生状态 | 已完成第一版 | 覆盖 preparing、thinking、using tool、waiting、suspended 与终态，未拆改 `isProcessing.didSet` |
| 统一工具展示映射 | 已完成第一版 | Live Activity 已改用 `AgentToolPresentation`，修复后续表面图标/文案漂移的源头 |
| Logs → Activity 用户界面 | 已完成第一版 | 支持查看、VoiceOver 合并语义、本机隐私说明与独立清理 |
| 聊天当前状态卡 | 已完成第一版 | 输入区上方统一显示运行、等待执行槽和可恢复状态；文字、图标与颜色同时表达语义 |
| 会话 Activity Timeline sheet | 已完成第一版 | 点击状态卡查看当前会话事件；不修改 `CollectionViewMessageListV3` cell 结构 |
| Activity 本机数据排除备份 | 已完成 | 数据库所在目录设置 `isExcludedFromBackup`，不进入 iCloud Backup |
| 权限、浏览器接管与后台等待相位 | 已完成第一版 | `waitingForPermission`、`waitingForUser`、`suspended` 写入统一 Tracker、聊天状态卡和本机 Timeline |
| 权限确认信任说明 | 已完成第一版 | 明确展示访问能力与数据去向，并提供一次性警告、允许和拒绝触感反馈 |

### 19.3 本轮构建门

P0.5、Design Foundation、Activity Log、聊天状态卡、Timeline 与等待原因第一版已使用开发团队 `48H5Y3LNUK` 对配对 iPhone 17 Pro Max 执行完整 Debug 构建。主应用、Share、File Provider、Live Activity extension 与 App Intents 元数据均通过，最新 1.0.4（Build 5）结果为 `BUILD SUCCEEDED`，且新 iSH 静态库已确认导出原生取消符号。1.0.4 已使用 `devicectl` 成功覆盖安装 `com.leoyuan.leophoneagent`；自动启动请求因 iPhone 锁屏被 SpringBoard 拒绝，解锁后完成交互验收。

新增 `AgentActivityModelsTests` 已进入 `MinisTests` 编译流程。本轮同时将 `AgentToolDefinition` 抽为无 Provider 依赖的纯类型，并补齐 Tool Preflight 的测试 target 源文件；`MinisTests` Swift 编译和独立链接均已通过。旧 `TEST_HOST` 与 `BUNDLE_LOADER` 已移除，并新增不构建主 App 的 `MinisLogicTests` scheme，因此测试目标不再链接旧主可执行文件，也不再被仅真机架构的 iSH 静态库阻断。当前两次执行阶段均遇到目标 iOS Simulator 被本机外部模拟器管理进程关闭，Xcode 等待 worker materialize；这属于 runner 环境中断，不记为测试通过或代码测试失败。

### 19.4 下一开发切片

下一切片按低风险到高风险依次执行：

1. 在已完成的 Native Offload 等待取消基础上，继续为 FFmpeg 等长任务接入框架级中断回调。
2. 继续用 `LeoMotion` 机械收敛现有魔数，并迁移剩余 ViewModel 层触感职责。
3. 在不受外部模拟器管理进程影响的环境中执行 `MinisLogicTests`，保留 xcresult 作为单测证据。
4. 完成真机六条流程截图，再按 Product Design 的证据要求做正式视觉审计。
