# Phase 5 交付证据：最终审计、修复与源码交付

日期：2026-08-31
分支：`main`

## 结论与完成比例

藏宝阁 Phase 0–5 的本机可实现源码、迁移、自动化测试和 Mac 生产构建已经完成。iOS 补齐 `treasury_save` / `treasury_update`，Android Agent 工具完成跨端契约对齐并补齐系统快速捕获表面，Mac 四种 Provider 共享同一个 Treasury MCP 工具入口；最终审计和完成定义复审修复了写授权、工具契约分叉、远端缓存完整性、Spotlight 隐私、Share Extension 捕获完整性、错误脱敏、跨 scope 去重、键盘/读屏语义、持久增强任务执行和三端安全缓存治理。

- Phase 5 本机源码与自动化范围：**100%**。
- Phase 0–5 本机施工范围：**100%**。
- 设备、签名和公开发布门禁：**HOLD**。没有发布 APK、IPA、DMG 或热更新。
- 完成定义：当前可称“Phase 0–5 源码交付完成”，不能称“三端正式发版完成”。

## 用户可见变化

### iOS / iPadOS

- Agent 现在可在用户明确要求时保存 link、text、note 和聊天 Artifact，并可更新标题、标签、合集、置顶、归档、阅读状态和批注。
- note 正文先原子写入正文文件，再写入收藏库和搜索索引；写库失败会清理本次新建正文，不留下假成功条目。
- URL 保存执行凭据安全的 HTTP(S) 校验和规范化去重；搜索索引与真实保存正文一致。
- 写工具同时要求当前真实用户消息表达明确意图和工具参数 `user_confirmed=true`。否定表达、伪造 system/assistant/developer 标记、网页/PDF/OCR 引用中的写指令均拒绝。
- `treasury_update` 不提供永久删除；永久删除继续走独立高风险确认流程。
- Share Extension 对图片和文件优先保留 URL/Data 原始字节，仅在系统只提供 `UIImage` 时使用无损 PNG fallback；暂存失败不会登记附件。
- Spotlight 不再回退到正文或带 query 的原始 URL，也不索引生成摘要；只使用明确标题、来源和标签。
- 设置中的存储管理分开显示原始附件、可再生缩略图缓存和同步临时缓存；清理动作只作用于可再生成或可重新下载的数据，不删除收藏、正文、批注或原始附件。
- 持久增强队列现在由主 App 实际领取并执行网页正文、OCR、PDF、音频转写和索引任务；失败状态、五次自动停止和用户显式重试继续使用既有恢复契约。
- App Intents 现在完整提供“收进藏宝阁”“搜索藏宝阁”“打开藏宝阁”。Siri/快捷指令搜索只返回最多五条标题和来源，不朗读正文、OCR、批注、命中片段、ID 或本机路径。
- “打开藏宝阁”使用 App Group 一次性路由标记，覆盖 Intent 独立执行进程到主 App 冷启动的交接；热启动继续通过同一中央路由打开。
- iPad 在可用宽度至少 760pt 且为 regular width 时使用 `NavigationSplitView` 并排显示收藏列表与阅读/高亮详情；分屏或窗口变窄时退化为单栏。布局判断不依赖设备型号或键盘改变后的高度。
- iOS Relay 入口移除旧 `uploadCollections(items)` 整库快照命名、无用数组参数和整库 fingerprint；自动同步现在只调用游标增量 changes，并在 actor 内合并并发触发且不丢失同步期间的新请求。

### Android

- `treasury_search` 支持 kinds、tags、source labels、collection IDs、创建时间、阅读状态和 active+archived 筛选，返回统一 `items` 紧凑结果。
- `treasury_get` 对外统一 `include_annotations`，兼容旧队列的单数参数；缺失条目明确返回正文状态、null 字段和 `truncated=false`。
- `treasury_save` 使用无凭据 HTTP(S) 规范化 URL、返回去重状态并支持合集；`treasury_update` 支持合集且非法阅读状态失败关闭。
- 内容类型、阅读状态和时间边界不再静默忽略；非法筛选会拒绝执行，避免扩大 Agent 查询范围。
- 设置页分开显示藏宝阁原始附件与同步临时缓存；清理仅删除受控 `treasury/sync-outbox`，并拒绝符号链接根目录或越界路径。Standard 与 Power 共用同一安全实现。
- Standard/Power 的 App Shortcut、按需快捷设置图块和桌面小组件现在复用同一个 `minis://action/treasury?capture=1` 路由，直接打开轻量文字/URL 捕获框；普通应用内入口仍只打开藏宝阁。
- 快速捕获请求是一次性状态，覆盖冷启动和热启动；不读取剪贴板、不增加 Accessibility/Shizuku/悬浮窗/Power 权限，也不创建藏宝阁常驻前台服务。

### Mac

- 新增统一 `leocodebox-treasury` MCP，Claude Code、Codex、Cursor 和 OpenCode/Grok Provider 复用同一个实现，不各自维护工具分叉。
- `leocodebox treasury-mcp` 提供 `treasury_search`、`treasury_get`、`treasury_save`、`treasury_update`。
- search 只返回九个紧凑字段；get 支持多个 ID、正文/批注开关、逐条字符预算、`truncated` 和正文状态。
- 手机缓存和 Mac 本机结果合并搜索；同 ID 跨多个 Relay scope 只保留一个结果，get 选择最新 scope。
- 手机正文缓存写入和读取均复核 MIME、byte count 和 SHA-256；不完整或被篡改的缓存不会交给 Agent。
- MCP token 加密保存在数据库，并以 `0600` 权限镜像到本机文件供 stdio 子进程读取；API 使用 timing-safe Bearer token 比较。
- 藏宝阁标签页支持 ArrowLeft/ArrowRight/Home/End、roving tabindex、tab/tabpanel 关联；加载、错误、详情焦点和删除高亮确认具备明确可访问语义。
- 本机和手机详情提供轻量“相关收藏”；本机 PDF 失败可显式重新处理，且重试前重新验证受控路径、PDF 文件头、byte count 与 SHA-256。
- 设置新增“存储空间”，分别统计本机原始文件、手机正文缓存和手机附件缓存。正文与附件缓存可独立确认清理；`treasury/files` 原始文件永不进入清理路径。
- 存储统计与清理拒绝符号链接根目录、realpath 越界和特殊文件；清理前先预检受控路径，避免路径异常时数据库先删而文件未删。

## 追加三轮审计与修复（2026-08-31）

### 第 1 轮：相关正文、相关收藏与后台竞态

- 三端 `treasury_get` 由无条件正文前缀改为围绕标题、摘要、标签和批注命中的相关窗口；无命中才回退前缀。
- 三端实现可解释相关收藏排序，并排除归档、自身以及“文本/文件/图片”等通用来源造成的伪关联。
- iOS 相关收藏切换移除固定 0.25 秒动画假设，改由 sheet 关闭回调安全衔接。
- iOS/Android 网页增强不再覆盖增强期间用户手写的新标题。

### 第 2 轮：持久重试、完整性与 Unicode

- 三端自动任务统一在五次失败后停止；用户显式重试重置 attempt count。
- Android 重试在 Room 事务中同时更新任务与条目可见状态；Mac PDF 重试只重置 `extract_text`，不误唤醒其他失败作业。
- Mac PDF 重试重新验证 realpath 受控目录、文件类型、byte count 和 digest 后才排队。
- Android/Mac 相关正文截断避免拆开 UTF-16 surrogate pair，补 emoji 回归。

### 第 3 轮：类型、lint、构建与边界复核

- 修复 Mac 测试窄类型导致的 TypeScript 正式 typecheck 失败，以及两处 Tailwind 类名顺序零警告门禁。
- 重新执行 iOS 全量逻辑测试与 Share target、Android 双 flavor 编译/单测/androidTest 编译/lint、Mac typecheck/test/lint/build。
- 复核本轮无新依赖、无常驻服务、无 Power 权限泄漏、无密钥/真实收藏/本机敏感路径写入源码。

## 存储治理与持久任务追加三轮审计（2026-08-31）

### 第 1 轮：iOS 持久增强执行与可再生缓存边界

- 修复持久 `TreasureJob` 只入队但主 App 没有实际领取执行的问题；网页正文、OCR、PDF、音频转写和索引现在使用同一持久任务状态机执行和恢复。
- 存储管理只允许清理缩略图与同步临时缓存；原始附件、正文文件、条目、批注和数据库记录保持不变。
- 增加失败重试、清理后缩略图再生、原始内容保留和受控路径回归测试。

### 第 2 轮：Android 双 flavor 路径安全与 Compose 并发

- Standard/Power 共用 `TreasuryStoragePolicy`，只清理 `treasury/sync-outbox`，拒绝缓存根目录符号链接、子路径逃逸和特殊文件。
- 存储统计在 IO 线程计算不可变快照，再在主线程提交 Compose 状态，避免后台线程直接修改 UI state。
- 中英繁中补齐原始附件/同步缓存文案；Standard 基础能力仍不依赖 Accessibility、Shizuku、悬浮窗或 Power 权限。

### 第 3 轮：Mac 原始/正文/附件分层与确认交互

- 服务端把原始文件、手机正文缓存和手机附件缓存分开统计与删除；正文只删除 `treasure_remote_assets.body`，附件只删除受控 `treasury-assets` 与对应记录。
- 修复符号链接根目录、realpath 越界、特殊文件、零字节缓存、文件丢失但数据库残留和部分完成风险；原始目录只读统计。
- UI 增加确认弹窗、本地化错误、ARIA live/alert、显式 dialog label、窄屏布局和加载骨架；组件、服务、全量 typecheck/lint/test/build 均通过。
- 本机浏览器成功加载客户端，但私有部署登录页阻挡“设置 → 存储空间”的登录后点击走查；没有读取或绕过凭据，因此该新增页面的真实 Electron/浏览器交互保持 HOLD。自动化组件测试已覆盖加载和错误状态，响应式结构通过 typecheck、lint 与 production build。

## 系统入口、增量同步与 iPad 工作台追加三轮审计（2026-08-31）

### 第 1 轮：施工规范逐项复核与 App Intents

- 对照施工规范 8.1 的系统能力要求，确认原代码只有“收进藏宝阁”，补齐“搜索藏宝阁”和“打开藏宝阁”。
- 搜索 Intent 查询限制为 500 字、结果限制为 5 条，输出层只允许标题和来源；新增敏感 snippet、条目 ID、空标题和打开策略回归。
- Intent 定义加入 `MinisLogicTests` 编译源，修复 Swift 6 对静态可变 App Intent 元数据的并发检查。

### 第 2 轮：同步协议真相与阶段性死码

- 重新追踪 `CollectionsView` / `ContentView` 到 `RelayEventCatchUp` 的真实调用链，确认 wire protocol 已经使用游标 changes，而旧 `uploadCollections(items)` 参数被完全忽略。
- 将 API 改为无快照参数的 `syncTreasuryChanges()`，删除整库 fingerprint 和“上传收藏索引”旧语义，避免代码继续暗示每次上传整库。
- `LeoAgentClient` actor 合并重叠同步请求；网络 await 期间到达的新请求会触发额外完整游标轮次，不并发争用 cursor，也不静默漏掉更新。

### 第 3 轮：冷启动交接、iPad 分栏与键盘状态

- 将“打开藏宝阁”从纯进程内静态标记升级为 App Group 一次性标记加热启动通知，消费后同步清除，避免独立 Intent 执行进程导致冷启动路由丢失。
- `CollectionsView` 增加按实际窗口宽度驱动的 `NavigationSplitView`；选中条目在详情列阅读、高亮、更新进度和打开/编辑，删除选中条目会清理详情状态。
- 初版复用了同时依赖高度的聊天布局策略；复审发现键盘可能改变高度并重建未提交批注，因此改为藏宝阁独立纯宽度策略并补 759/760pt、compact size class 和非有限宽度测试。

## Android 系统捕获入口追加两轮审计（2026-08-31）

### 第 1 轮：系统表面、统一路由与本地化

- 对照施工规范 8.2，补齐 Standard/Power 的藏宝阁 App Shortcut、按需 Quick Settings Tile 和桌面小组件按钮，三者统一进入 `minis://action/treasury?capture=1`。
- 新入口只打开既有轻量文字/URL 捕获框，不读取剪贴板；普通应用内导航使用不带 capture 的路由，不强制弹框。
- 设置 → 系统权限增加独立“添加藏宝阁收藏图块”，并补齐简中、繁中和英文；顺手修复同一组繁中文案中的简繁混杂。

### 第 2 轮：冷启动重组、一次性状态与权限边界

- 初版在 Compose `startDestination` 计算期间写入一次性状态；复审发现重组可能重放捕获请求，改为在 `LaunchedEffect(initialDeepLink)` 中排队，Treasury 页面消费后立即清零。
- 广播转发从固定强制 `capture=1` 改为保留原始 capture 语义，避免“只打开藏宝阁”的入口被意外升级为写入动作。
- 新增 `capture=1/true/0`、动作映射和一次性消费回归；双 flavor 编译、单测、资源校验和 lint 通过。
- Manifest 中新 Tile 仅使用系统 `BIND_QUICK_SETTINGS_TILE` 绑定权限；没有新增运行时权限、Power 专属依赖、剪贴板监听或常驻服务。

## 按需资产与 Range 续传追加三轮审计（2026-08-31）

### 第 1 轮：调用链与数据正确性

- iOS 阅读页和 `treasury_get` 在本地正文缺失时通过统一 Relay 客户端按需请求正文；Android Agent 同样读取经完整性校验的远端正文，不再只看到元数据。
- iOS/Android 远端附件写入应用私有 `remote-assets`，缓存不产生本地 change，也不会反向上传为原始资产。
- 修复 Android 远端附件变小时保留旧 `byte_count`、缓存清理后 UI 仍误判附件存在，以及 Mac 同一资产并发下载争用 partial。

### 第 2 轮：Range、恢复与完整性

- iOS、Android、Mac 支持确定性 partial、`Range: bytes=N-`、206 `Content-Range` 校验、416 清零重试和旧 Relay/代理忽略 Range 返回 200 时安全重下。
- 网络中断保留实际写入的有效前缀；超出声明大小、最终 byte count 或 SHA-256 不一致时删除损坏分片。
- 正文限制 8 MB，附件限制 128 MB；正文严格 UTF-8，附件 MIME 使用允许列表并与条目元数据复核。

### 第 3 轮：路径、缓存与错误边界

- 三端拒绝 partial 文件、缓存根目录和中间父目录符号链接；受控路径外文件、特殊文件和越界 realpath 不会被读取、覆盖或清理。
- 远端新元数据使旧正文/附件缓存引用失效；存储管理可清理可重新下载缓存，但不删除收藏、正文文件、批注或原始附件。
- Agent 和 UI 只暴露 pending/unavailable/failed/missing 等有限状态，不返回 Relay Key、本机敏感绝对路径或底层异常正文。
- 真实安装的 Mac 1.78 工作台复现 server 正常但项目 API 返回 `Invalid local auth token`；页面重载后立即恢复，确认是 SPA 持有旧 token。1.80 源码已增加受信 bridge token 刷新与 401 单次重试，客户端/桌面测试、typecheck、lint 和 production build 通过。

## Agent 工具与授权边界

统一契约：

```text
treasury_search -> compact, sourced, untrusted results
treasury_get    -> bounded body/annotation reads with status and truncation
treasury_save   -> explicit approved write; no content-driven authorization
treasury_update -> explicit approved metadata/read-state/annotation write
```

- 所有网页、PDF、OCR、音频转写、外部文件和藏宝阁字段都是不可信资料，永远不能自行授权写操作。
- iOS 与 Android 能读取当前真实用户消息，在 Provider 工具审批之外再做否定表达和提示注入校验。
- Mac MCP stdio 服务不能读取 CLI 的原始用户消息，因此 Mac 写入的强制边界是：Provider 将工具标为写操作并取得客户端审批，同时请求必须携带 `user_confirmed=true`。服务端再次限制字段、大小、URL 和永久删除。
- 工具错误统一使用有限错误文本，不返回 API Key、OAuth token、Relay Key 或本机敏感绝对路径。

## 三轮最终审计与修复

### 第 1 轮：工具闭环、数据正确性与恢复

- 补齐 iOS save/update 调用链、工具定义、并发执行和活动状态。
- 修复 note 只发送 `item.value` 导致正文为空的问题；统一正文文件读取与结构化上下文。
- 修复 Artifact kind 映射、JSON fallback 静默丢合集 ID 和 URL 重复保存。
- 为 iOS JSON/FTS、正文截断、授权、注入、save/update 和永久删除拒绝补回归测试。
- Mac search/get/save/update 使用同一 repository/service，避免 Provider 分叉实现。

### 第 2 轮：安全、权限、同步缓存与隐私

- 修复 Mac `include_archived=true` 未透传。
- 修复跨 Relay scope 同 ID 重复搜索、旧 scope 覆盖新 scope。
- 正文缓存写入和 Agent 读取均校验 MIME、byte count、SHA-256。
- MCP token 改为加密数据库值加 `0600` 文件镜像；HTTP token 使用 timing-safe 比较。
- 复扫错误、响应、日志和变更，未发现真实密钥或本机路径泄漏；扫描唯一绝对路径命中为安全测试的合成字符串。
- 完整和 production-only `npm audit` 均为 0 vulnerability。

### 第 3 轮：UI、可访问性、性能边界与冗余

- Mac 六个智能视图补齐 WAI-ARIA tab/tabpanel 关系和完整键盘切换。
- 加载使用 live status；失败使用 assertive alert；详情打开后移动焦点；删除高亮增加确认；加载时不闪烁空态。
- 真实 production build 在应用内浏览器完成宽窗口与 `720×900` 窄窗口走查，六个 tab、搜索、捕获和筛选均可见；控制台 0 error / 0 warning。
- 移除被 `.gitignore` 覆盖的测试落盘方式，将高级 Treasury integration 测试迁到可跟踪目录。
- 复核无新增常驻服务、搜索服务、语义模型、24 小时监听、Power 权限依赖或重复 Provider 工具实现。

### 完成定义复审：跨端契约、捕获完整性与系统索引边界

- 逐项对照施工规范重新核对 Android 四工具，修复 get 参数单复数分叉、search 过滤器缺失、结果 wrapper 不一致和 save/update 合集缺口。
- Android search 对未知 kind、reading state、非法日期及倒置时间区间失败关闭；repository 保留结构化过滤、active+archived 和大小写无关来源语义。
- iOS Spotlight 移除正文、原始 URL 和生成摘要 fallback；Share Extension 移除保存前 JPEG 强制转码，并只在暂存真实成功后发布附件记录。
- 复扫 SQL 参数顺序、路径穿越、凭据 URL、错误文本、debug 输出和本机路径；本轮改动未新增密钥、真实收藏、敏感绝对路径或常驻能力。

### 契约完成度三轮复审：过滤、上限与大库正确性

- 第一轮核对三端 envelope 与预算：Android/Mac search 增加顶层 `truncated`，Android/Mac get 对超过 100 个 ID 明确顶层截断；iOS get 对齐 100 IDs、50,000 字，并真正执行 reading state / collection filters。
- 第二轮修复固定候选上限导致的漏项：iOS 合集成员读取按 SQLite 参数上限分批，不再静默截到 500；Agent FTS 在结构化过滤前读取当前库全部匹配 ID，不再漏掉第 201 条后的正文命中；Mac 把来源、合集、标签、阅读状态和精确时间下推 SQL，避免先取 500 条再过滤。
- 第三轮修复排序与严格解析：Android 在 SQL `LIMIT` 前使用加权 BM25，旧但高度相关结果不会被 51 条较新弱命中挤掉；Mac 拒绝非法 kind、reading state、倒置区间以及 `2026-02-30` 这类自动归一化日期；远端 kind/reading filter 大小写语义与本机一致。
- 新增 iOS 200/500 条边界和 Mac 500 条后二次过滤回归；复扫提示注入、正文/附件路径、错误脱敏和永久删除边界，未放宽任何写授权或高风险操作。

## 自动化验证

### iOS / iPadOS

- Treasury 定向测试：**57/57 passed**。
- `MinisLogicTests`：**328/328 passed**，0 failed，0 skipped。
- 最新 xcresult：`~/Library/Developer/Xcode/DerivedData/LeoPhoneAgent-eepkwcwlunoccyencmgmqedpdkny/Logs/Test/Test-MinisLogicTests-2026.08.31_07-36-27-+0800.xcresult`。
- `MinisShare` iOS Simulator target：build succeeded。
- 本轮 8 个 Swift 改动文件通过 `swiftc -frontend -parse` 语法解析。
- 主 App target：当前机器缺少 watchOS 26.5 runtime；排除 Watch 诊断后又因 `deps/ish` 固定提交 `8d53d6b9e47aa375d6a932ebb47f4ab6f71e66b1` 上游不可获取而缺少 iSH 头文件/Rootfs 资源。诊断改动均已恢复。保持 HOLD，不声明主 App 完整构建或运行验证。

### Android Standard / Power

执行：

```text
./gradlew compileStandardDebugKotlin testStandardDebugUnitTest lintStandardDebug \
  compilePowerDebugKotlin testPowerDebugUnitTest lintPowerDebug
```

- `BUILD SUCCESSFUL`。
- Standard：**621 tests，0 failures，1 skipped**。
- Power：**621 tests，0 failures，1 skipped**。
- 新增 Range/缓存测试在两个 flavor 均通过；双 lint 0 error。
- Standard lint：0 errors、542 warnings、38 hints；Power lint：0 errors、538 warnings、38 hints。XML 报告未命中本轮修改文件，均为仓库全局既有项。
- Standard 基础藏宝阁未引入 Accessibility、Shizuku、悬浮窗或 Power 权限依赖。

### Mac leocodebox

- `npm run typecheck`：通过。
- `npm run test:desktop`：**37/37 passed**。
- `npm run test:client`：**166/166 passed**。
- `npm run test:server`：**404/404 passed**。
- `npm run lint`：通过，0 error / 0 warning。
- `npm run build`：client/server production build 通过。
- MCP stdio `tools/list`：通过，四工具、annotations 和 schema 可被真实进程枚举。
- 完整 `npm audit`：0 vulnerabilities；production-only audit：0 vulnerabilities。
- 既有藏宝阁工作台真实浏览器证据：宽/窄布局、六视图键盘切换、搜索、捕获、筛选和详情语义通过，控制台 0 error / 0 warning。新增“存储空间”页因本机私有部署登录阻挡，真实交互保持 HOLD；组件测试与 production build 通过。

## 数据迁移、同步与性能证据

- Phase 1 已覆盖 iOS JSON → SQLite 备份/事务/坏条目/中断恢复、Android Room migration、Mac schema、去重、导入导出、tombstone、索引重建和 1,000 条分页。
- Phase 4 已覆盖游标增量、重复/乱序 change、旧游标 410 重建、元数据/正文/附件分层、digest/byte count/MIME 和原子缓存。
- 最新 Mac 1,000 条列表与关键词搜索有自动化有界回归；本轮完整测试中的该用例总耗时约 1.54 秒，包含建库、写入 1,000 条和查询，不等同于单次搜索 P95。
- 没有取得 10,000 条设备 P95、分享反馈 P95、移动端 CPU/峰值内存或电量仪器数据；这些仍需设备环境测量，不能以代码审计替代。
- 代码审计确认 OCR、PDF、索引、迁移和网络请求不在 UI 主线程执行，且没有新增 24 小时常驻藏宝阁服务。

## 修改文件

核心代码提交：

- `ee39ea2` — `feat(ios-treasury): complete save and update tools`
- `db9e9fc` — `feat(mac-treasury): expose unified provider mcp tools`
- `2282d44` — `fix(mac-treasury): harden cache integrity and accessibility`
- `4a583cd` — `fix(android-treasury): align agent tools with cross-platform contract`
- `8b61baf` — `fix(ios-treasury): preserve raw share captures and private spotlight data`
- `386c138` — `fix(treasury): enforce cross-platform filtered search bounds`
- `c574c83` — `fix(ios-treasury): execute persistent enrichment jobs`
- `555765e` — `feat(ios-treasury): add safe cache storage controls`
- `cf3bee4` — `feat(android-treasury): add safe cache storage controls`
- `6552ae6` — `feat(mac-treasury): add safe cache storage controls`
- `19a3323` — `fix(ios-treasury): complete system intents and adaptive workspace`
- `99b4c76` — `feat(android-treasury): add system capture surfaces`

实际代码范围：

- iOS：`src/ios/Shared/CollectionStore.swift`、`CollectionSearchIndex.swift`、`SharedContainerStore.swift`、`ShareExtension/ShareViewModel.swift`、`StorageManagementView.swift`、`CollectionIntents.swift`、`CollectionsView.swift`、`ContentView.swift`、Relay 增量同步入口、Agent Chat 工具定义/执行/状态、`ChatStore.swift`、Treasury 测试。
- Android：Treasure repository、统一 Agent tool schema/executor、`TreasuryStoragePolicy.kt`、`StorageManagementScreen.kt`、统一系统入口/Tile/Shortcut/widget 与契约/路由回归测试。
- Mac server：Treasury MCP stdio/API、CLI 入口、server 挂载、Treasury repository/service、Fleet 缓存校验、`treasury-storage.service.ts` 和 integration tests。
- Mac client：`CollectionsMirror.tsx`、`StorageSettingsTab.tsx` 与可访问性/交互测试。

## 明确 HOLD 与未实现能力

- iOS/iPadOS：本轮新增 App Intents 与 iPad 分栏的主 App 类型检查/模拟器运行；VoiceOver、Dynamic Type、Reduce Motion、拖放、多窗口、外接键盘、真机、签名、Archive、安装与发布。
- Android：API 26、Fold8 `1080×1728` 封面屏、`1768×2208` 展开屏、折叠切换、200% 字体、TalkBack、预测性返回、进程死亡/WorkManager 恢复、Launcher Shortcut/Quick Settings Tile/widget 真实交互、固定签名、覆盖安装、Logcat、版本号、APK digest 与发布。
- 跨端：iOS 创建后 Android/Mac 看见、Android 更新后 iOS/Mac 看见、双端同时编辑、离线删除恢复、重复/乱序 change、游标过期和附件下载的真实三设备联网矩阵。
- Mac：新增存储页的登录后真实 Electron/浏览器走查、双机 Relay 在线/离线、四种 CLI 与 Leo 模型的真实写审批/引用、Electron 屏幕阅读器、签名、公证、热更新与回滚。
- 协议：HTTP Range 源码与本机自动化已完成；真实三设备弱网/断线、大附件和移动端进程死亡续传仍为 HOLD。
- 可选能力：音频转写和语义召回/RRF 未启用；FTS 基础检索不依赖模型。

设备与发布执行步骤见 [藏宝阁设备测试与发版清单](TREASURY_DEVICE_RELEASE_CHECKLIST.md)。隐私与授权边界见 [藏宝阁隐私与安全说明](TREASURY_PRIVACY_AND_SECURITY.md)。
