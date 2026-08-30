# Phase 5 交付证据：最终审计、修复与源码交付

日期：2026-08-31
分支：`main`

## 结论与完成比例

藏宝阁 Phase 0–5 的本机可实现源码、迁移、自动化测试、Mac 生产构建和浏览器交互审计已经完成。iOS 补齐 `treasury_save` / `treasury_update`，Android Agent 工具完成跨端契约对齐，Mac 四种 Provider 共享同一个 Treasury MCP 工具入口；最后三轮审计和完成定义复审修复了写授权、工具契约分叉、远端缓存完整性、Spotlight 隐私、Share Extension 捕获完整性、错误脱敏、跨 scope 去重和键盘/读屏语义。

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

### Android

- `treasury_search` 支持 kinds、tags、source labels、collection IDs、创建时间、阅读状态和 active+archived 筛选，返回统一 `items` 紧凑结果。
- `treasury_get` 对外统一 `include_annotations`，兼容旧队列的单数参数；缺失条目明确返回正文状态、null 字段和 `truncated=false`。
- `treasury_save` 使用无凭据 HTTP(S) 规范化 URL、返回去重状态并支持合集；`treasury_update` 支持合集且非法阅读状态失败关闭。
- 内容类型、阅读状态和时间边界不再静默忽略；非法筛选会拒绝执行，避免扩大 Agent 查询范围。

### Mac

- 新增统一 `leocodebox-treasury` MCP，Claude Code、Codex、Cursor 和 OpenCode/Grok Provider 复用同一个实现，不各自维护工具分叉。
- `leocodebox treasury-mcp` 提供 `treasury_search`、`treasury_get`、`treasury_save`、`treasury_update`。
- search 只返回九个紧凑字段；get 支持多个 ID、正文/批注开关、逐条字符预算、`truncated` 和正文状态。
- 手机缓存和 Mac 本机结果合并搜索；同 ID 跨多个 Relay scope 只保留一个结果，get 选择最新 scope。
- 手机正文缓存写入和读取均复核 MIME、byte count 和 SHA-256；不完整或被篡改的缓存不会交给 Agent。
- MCP token 加密保存在数据库，并以 `0600` 权限镜像到本机文件供 stdio 子进程读取；API 使用 timing-safe Bearer token 比较。
- 藏宝阁标签页支持 ArrowLeft/ArrowRight/Home/End、roving tabindex、tab/tabpanel 关联；加载、错误、详情焦点和删除高亮确认具备明确可访问语义。

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

## 自动化验证

### iOS / iPadOS

- Treasury 定向测试：**37/37 passed**。
- `MinisLogicTests`：**308/308 passed**，0 failed，0 skipped。
- xcresult：`~/Library/Developer/Xcode/DerivedData/LeoPhoneAgent-eepkwcwlunoccyencmgmqedpdkny/Logs/Test/Test-MinisLogicTests-2026.08.31_03-38-27-+0800.xcresult`。
- `MinisShare` iOS Simulator target：build succeeded。
- 主 App scheme：本机缺少仓库目标要求的 watchOS runtime，编译前阻断；保持 HOLD，不声明 iPhone/iPad 主 App 已运行。

### Android Standard / Power

执行：

```text
./gradlew compileStandardDebugKotlin testStandardDebugUnitTest lintStandardDebug \
  compilePowerDebugKotlin testPowerDebugUnitTest lintPowerDebug
```

- `BUILD SUCCESSFUL`。
- Standard：**607 tests，0 failures，1 skipped**。
- Power：**607 tests，0 failures，1 skipped**。
- Standard lint：0 errors、542 warnings、38 hints；Power lint：0 errors、538 warnings、38 hints。XML 报告未命中本轮修改文件，均为仓库全局既有项。
- Standard 基础藏宝阁未引入 Accessibility、Shizuku、悬浮窗或 Power 权限依赖。

### Mac leocodebox

- `npm run typecheck`：通过。
- `npm run test:client`：**162/162 passed**。
- `npm run test:server`：**395/395 passed**。
- `npm run build`：client/server production build 通过。
- MCP stdio `tools/list`：通过，四工具、annotations 和 schema 可被真实进程枚举。
- 完整 `npm audit`：0 vulnerabilities；production-only audit：0 vulnerabilities。
- 真实浏览器：宽/窄布局、六视图键盘切换、搜索、捕获、筛选和详情语义通过；控制台 0 error / 0 warning。

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

实际代码范围：

- iOS：`src/ios/Shared/CollectionStore.swift`、`CollectionSearchIndex.swift`、`SharedContainerStore.swift`、`ShareExtension/ShareViewModel.swift`、Agent Chat 工具定义/执行/状态、`ChatStore.swift`、Treasury 测试。
- Android：Treasure repository、统一 Agent tool schema/executor 与契约回归测试。
- Mac server：Treasury MCP stdio/API、CLI 入口、server 挂载、Treasury repository/service、Fleet 缓存校验和 integration tests。
- Mac client：`CollectionsMirror.tsx` 与可访问性测试。

## 明确 HOLD 与未实现能力

- iOS/iPadOS：主 App 模拟器运行、VoiceOver、Dynamic Type、Reduce Motion、拖放、多窗口、外接键盘、真机、签名、Archive、安装与发布。
- Android：API 26、Fold8 `1080×1728` 封面屏、`1768×2208` 展开屏、折叠切换、200% 字体、TalkBack、预测性返回、进程死亡/WorkManager 恢复、固定签名、覆盖安装、Logcat、版本号、APK digest 与发布。
- 跨端：iOS 创建后 Android/Mac 看见、Android 更新后 iOS/Mac 看见、双端同时编辑、离线删除恢复、重复/乱序 change、游标过期和附件下载的真实三设备联网矩阵。
- Mac：双机 Relay 在线/离线、四种 CLI 与 Leo 模型的真实写审批/引用、Electron 屏幕阅读器、签名、公证、热更新与回滚。
- 协议：附件支持完整文件失败重试、临时文件、原子落盘和 digest 校验；**没有 HTTP Range 断点续传**。
- 可选能力：音频转写和语义召回/RRF 未启用；FTS 基础检索不依赖模型。

设备与发布执行步骤见 [藏宝阁设备测试与发版清单](TREASURY_DEVICE_RELEASE_CHECKLIST.md)。隐私与授权边界见 [藏宝阁隐私与安全说明](TREASURY_PRIVACY_AND_SECURITY.md)。
