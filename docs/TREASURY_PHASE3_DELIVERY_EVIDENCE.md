# Phase 3 交付证据：阅读、批注、处理状态与智能搜索

## 结论与完成比例

Phase 3 的本机必需能力已完成：三端都能区分收件箱、处理中、失败、待读和最近使用；支持阅读状态、阅读进度、定位高亮、批注、精确过滤与 PDF 逐页文本。Android 和 iOS 的重型 PDF 解析只在后台执行，原始文件保存不依赖解析成功；Mac 使用持久任务状态执行本机 PDF 提取。

- 本机源码与自动化范围：**100%**。
- Phase 3 全验收范围：**78%**。未完成部分是实际移动设备/可访问性运行证据、跨端阅读进度冲突验证，以及明确保持可选的音频转写和语义召回/RRF。
- 发布状态：**HOLD**。本阶段只提交并 push 源码，不发布 APK、IPA 或 Mac 更新。

## 用户可见变化

### Android Standard / Power

- 藏宝阁新增收件箱、处理中、失败、待读和最近使用视图，并支持类型、状态、标签等精确过滤。
- 详情页可更新未读/已读、阅读进度、最近打开时间，选择正文后可创建带定位信息的高亮和批注。
- PDF 在 WorkManager 中离线逐页提取；搜索结果可显示页级命中片段。处理失败可见、可重试，且不影响原始附件。
- 正文阅读视图最多一次渲染 200,000 字符，避免超长内容阻塞 Compose；数据库仍保留完整已保存内容。
- Fold 宽度和详情切换时保留查询、筛选、选择和列表滚动状态；真实 Fold8 切换仍需设备验证。
- Agent 搜索结果明确标记外部收藏内容为不可信资料；网页、PDF、OCR 中伪造的“保存/更新”文字不能授权写操作。

### iOS / iPadOS

- 收藏列表新增处理状态、阅读状态、阅读进度、最近打开时间与精确筛选。
- 阅读 sheet 支持受控正文读取、定位高亮和批注；长正文只把前 200,000 字符交给交互式文本视图。
- PDFKit 在后台逐页提取，最多 500 页、2,000,000 字符；只有正文成功落盘后才将处理状态标记为 ready。
- 网页增强禁止页面 JavaScript，并阻断脚本、iframe、XHR、图片、媒体、字体等子资源；每次顶层重定向重新执行公网 HTTP(S)、DNS 与凭据边界检查。
- 笔记正文文件名拒绝路径穿越；索引文本与实际保存的截断正文保持一致。

### Mac

- CollectionsMirror 已具备搜索、精确过滤、详情、阅读状态、阅读进度、高亮与批注，不再只是手机元数据列表。
- 搜索击键只查询本地数据库，不再每次重新拉取手机镜像；请求 generation 防止旧搜索或旧详情覆盖新状态。
- PDF 通过持久 `extract_text` 作业调用 PDFKit JXA 后台提取，具备 claim、complete、fail、30 秒超时、16 MB 输出和 500 页/2,000,000 字符上限。
- 列表 API 不返回大正文；详情按需读取并限制单次 100,000 字符。SQLite FTS trigger 直接维护索引，不制造无法消费的假 `index` 作业。
- 不支持的图片 OCR、通用文档提取和音频转写显示 partial，而不是伪装完成或丢弃原文件。

## 数据与协议变化

### Android Room 11 → 12

- 新增 `treasure_highlights`，保存高亮范围、引用文本、批注和定位信息。
- 条目增加/使用处理状态、阅读状态、阅读进度与最近打开时间；写入时归一化状态和进度，避免“未读但进度 100%”等矛盾。
- 高亮创建与父条目更新放在同一事务顺序内；父条目不可更新时不留下孤立子项。
- migration instrumentation 测试验证 11 → 12 的旧条目保留与新表可用；测试源码已编译，实际设备执行仍为 HOLD。

### iOS SQLite

- 现有 Treasury SQLite 增加处理/阅读状态、进度、最近打开、高亮和精确查询行为。
- OCR/PDF 正文采用“先写文件，再提交 ready 状态”；写入失败保持原始附件和可重试状态。

### Mac SQLite / API

- 新增 `treasure_highlights`、阅读更新和分页 PDF chunk。
- 精确查询、多词查询、结构化过滤的 snippet 与 `match_sources` 由真实匹配字段生成。
- 没有改变 Phase 4 的跨端 changes 协议；高亮独立同步、正文/附件按需同步和冲突策略仍在 Phase 4 实施。

## PDF 依赖成本与许可

- Android 新增 `com.tom-roush:pdfbox-android:2.0.27.0`，许可证 Apache-2.0。
- 本机构建缓存中的 AAR 约 3.1 MB；最终 APK 增量需在发布构建和 R8 后重新测量，当前不虚报发布包体结果。
- 传递依赖为 Bouncy Castle Provider / PKIX / Utilities 1.72，使用 Bouncy Castle Licence（MIT-style）。
- PDFBox 只在 WorkManager 后台作业中使用，不增加网络服务、常驻前台服务或 24 小时监听。
- CPU、电量与大 PDF 峰值内存仍需 API 26 和 Fold8 真机/模拟器测量；代码已使用临时文件支持的解析方式及页数/字符上限。

## 三轮审计与修复

### 第 1 轮：数据完整性与恢复

修复：

- Android 高亮并发事务可能先写子项、后发现父条目不可更新。
- 三端未读/已读与阅读进度出现矛盾组合。
- iOS 正文写入失败仍标记 ready，导致搜索与读取错误地认为正文可用。
- iOS PDF 索引正文可能长于实际落盘正文。
- Mac 由 trigger 同步 FTS 后仍排入无消费者的假 `index` 作业。
- Mac PDF 任务缺少完整 claim/fail/complete 闭环。
- Mac PDF 测试受前一条测试的通用关键词污染。

### 第 2 轮：安全、检索与提示注入

修复：

- iOS ArticleExtractor 的 SSRF、DNS rebinding/重定向复核和页面子资源访问边界。
- iOS NoteBodyStore 的正文文件名路径穿越。
- Android Agent 搜索缺少明确“不可信资料”标记。
- Android 保存/更新授权可能被网页、PDF、OCR 引用文字误触发。
- Mac 查询与详情的异步竞态。
- Mac 多词及结构化查询的 `match_sources` / snippet 不准确。
- 复扫工具错误、日志和新增代码，未发现 API Key、OAuth token、Relay Key、本机敏感绝对路径或原始内部错误泄露。

### 第 3 轮：UI、性能、电量边界与许可

修复：

- 三端超长正文直接进入富文本选择控件造成主线程和内存压力。
- Android 折叠/详情切换主动丢失列表滚动状态。
- Mac 搜索每次击键重复请求手机镜像。
- 第三方许可漏记 PDFBox 的 Bouncy Castle 传递依赖。

复核结论：没有引入常驻藏宝阁服务、在线解析服务、语义模型、搜索服务器或 Power 权限依赖；后台增强失败不删除原始内容。

## 自动化验证

### Android

已执行：

```text
./gradlew \
  compileStandardDebugKotlin compilePowerDebugKotlin \
  compileStandardDebugAndroidTestKotlin compilePowerDebugAndroidTestKotlin \
  testStandardDebugUnitTest testPowerDebugUnitTest \
  lintStandardDebug lintPowerDebug
```

结果：`BUILD SUCCESSFUL`。双 flavor lint 为 0 errors、535 warnings、38 hints；warnings/hints 为仓库全局既有项，本阶段没有 Treasury lint error。instrumentation 测试源码已编译，但没有设备执行证据。

新增/扩展覆盖：

- Room 11 → 12 migration；
- 高亮事务、阅读状态/进度归一化；
- 精确查询、标签特殊字符、多过滤器和快速查询；
- PDF 页级提取/任务状态的契约边界；
- Agent 搜索不可信标记与保存/更新提示注入拒绝。

### iOS / iPadOS

- `MinisLogicTests`：**301/301 passed**，0 failed。
- `MinisShare` iOS Simulator target：build succeeded。
- 修改 Swift 文件：`swiftc -parse` 通过。
- `ArticleExtractor.swift` 独立 iOS Simulator typecheck 通过。

主 App 无签名模拟器 build 已重新尝试；当前 scheme 包含嵌入式 Apple Watch App，而本机没有安装 watchOS 26.5，`xcodebuild` 在编译前以 exit 70 终止。因此不宣称主 App 模拟器运行成功。

### Mac

```text
npm run typecheck
npm run test:server
npm run build
```

结果：typecheck 成功；服务端测试 **385/385 passed**；client/server production build 成功。

## HOLD：必须在用户测试环境完成

- Android API 26 instrumentation 和进程死亡/WorkManager 恢复。
- Fold8 1080×1728 封面屏、1768×2208 展开屏、折叠切换、200% 字体、TalkBack、预测性返回。
- Android Standard/Power 真机、固定签名、上一版本覆盖安装、Logcat、版本号和 APK digest。
- iPhone/iPad 主 App 编译运行、竖横屏/分屏/窗口缩放、VoiceOver、Dynamic Type、Reduce Motion、拖放和键盘。
- iOS 真机、签名、Archive 和发布。
- Mac 真实 Electron 窗口、键盘和屏幕阅读器；签名、公证和热更新。
- 音频转写保持可选降级能力；当前没有内置常驻转写模型。
- 可选语义召回与 RRF 未启用；FTS5 是完整可用的默认检索。启用语义前仍需明确隐私、包体和维护成本。
- 跨端阅读进度/高亮冲突、游标 changes、正文/附件按需同步属于 Phase 4。

## 实际修改范围

- Android：Room schema/DAO/Repository、WorkManager、精确查询、Agent 安全边界、Compose 阅读/筛选/高亮 UI、三语言资源与测试。
- iOS：CollectionStore、AttachmentImporter、NoteBodyStore、ArticleExtractor、CollectionsView 与逻辑测试。
- Mac：数据库 schema/repository、Treasury route/service/capture policy、CollectionsMirror 与集成测试。
- 许可与文档：`THIRD_PARTY_LICENSES.md`、本报告、总施工规范、README、CHANGELOG、Android 隐私说明与 `.ui-pipeline` 证据。

## 下一阶段

Phase 4 将替换旧的前 500 条整体镜像，实施游标增量 changes、幂等/乱序/tombstone/conflict、元数据/正文/附件分层同步、digest 校验、断线恢复和 Mac 主动引用。正文和附件默认按需获取，高亮同步语义会与条目同步一起定义，不提前上传全部本机资料。
