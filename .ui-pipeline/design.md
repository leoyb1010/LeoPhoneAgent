# Design Direction

## Direction decision

- Options considered and structural differences: A. 保留单一“使用 Key”开关；B. 新增独立 Leoapi 页；C. 每个 CLI 卡内明确“官方账号 / Leo 模型”两条路径。
- Chosen option and evidence: C；它贴近安装后立即启动的任务，并诚实保留 Cursor 的官方边界。
- Existing visual authority to preserve: Material 3、SettingsSection、主按钮“启动”、次按钮“登录/更新”、现有主题与 LeoMotion。

## Originality contract

- Visitor mode: Operate
- Product truth: 手机同时是模型控制面和 Linux 执行体。
- Concept spine: 先看连接来源，再启动 Agent。
- First viewport / primary task region: 每张 CLI 卡的版本、账号/模型来源状态与启动按钮。
- First-read object and primary action: 当前连接方式；主动作随状态变为“登录”或“启动”。
- Spatial thesis: 纵向单任务卡，展开态保持可读行宽，不增加桌面式侧栏。
- Material and asset strategy: 原生 Compose/Material 图标，不新增图片资产。
- Product-specific signature: 同卡呈现“CLI 官方账号”和“LeoPhoneAgent 模型”两条真实路径。
- Motion grammar: 仅状态切换、进度和对话框进入；尊重系统减少动画。
- Explicit anti-defaults: 不用万能“连接”按钮；不把失败原文当说明；不显示不可执行授权。

## System

- Typography: 现有 Material typography，标题/状态/说明三级。
- Color and surfaces: 现有 surfaceContainer；成功绿、警告橙、错误红只表达状态。
- Grid and spacing: 8dp 基线，卡内 12–16dp，按钮最小 48dp。
- Shape and borders: 沿用 SettingsSection 与 12–16dp 圆角。
- Iconography and imagery: Material 账号、模型、终端与检查图标。
- Density: 封面屏单列紧凑，展开态不无限拉宽正文。

## Composition

- Reading or task path: 安装状态 → 授权来源 → 模型/账号状态 → 启动或登录 → 日志/更新。
- Major regions and their jobs: CLI 摘要、连接方式、主次动作、配置弹窗、失败恢复。
- Scale and density rhythm: 卡片摘要紧凑，配置对话框展开信息，日志按需显示。
- Responsive structural changes: 展开态动作同排；封面态动作换行并保持主按钮优先。

## Components and tokens

- Existing component source: 本仓 Compose Material 组件与 SettingsSection。
- Components to reuse: ListItem、Button、OutlinedButton、FilterChip、AlertDialog、DropdownMenu。
- New components justified: 仅封装重复的 CLI 连接状态，不新增通用设计系统。
- Token changes: 无。

## Motion budget

- Primary motion engine: Compose 原生动画/LeoMotion。
- Functional transitions: 状态刷新、安装进度、登录返回后的徽标更新。
- Dominant effect, if any: 无。
- Reduced-motion behavior: 状态直接切换，不依赖动画表达结果。

## State matrix

| Surface | Loading | Empty | Error | Success | Disabled | Long content | Responsive |
|---|---|---|---|---|---|---|---|
| CLI 卡片 | 探测转圈 | 未安装 | 登录/桥接错误 | 已安装已连接 | 忙碌时禁用 | 版本/错误省略、日志展开 | Fold8 双尺寸换行 |
| 授权配置 | 模型加载占位 | 无兼容模型 | 解释协议边界 | 显示已选模型 | 不兼容项禁用 | 200 字模型 ID | 对话框可滚动 |
