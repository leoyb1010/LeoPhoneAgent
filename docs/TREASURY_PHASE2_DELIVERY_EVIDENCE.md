# Phase 2 交付证据：Android 藏宝阁与三端捕获

## 结论

Phase 2 的本机代码实现已完成。Android Standard/Power 共用同一套无 Power 权限依赖的藏宝阁；iOS 增加聊天 Artifact 保存和 iPad 拖放；Mac 增加本机 URL、文字、文件与受控聊天 Artifact 捕获。

本机自动化门禁已覆盖 Android 双 flavor 编译/单测/lint、Mac typecheck/服务端测试/build、iOS 逻辑测试与 Share Extension 独立构建。Android 模拟器、Fold8、TalkBack、200% 字体、iPhone/iPad 主 App 运行和签名发布仍是明确 HOLD，不在没有设备证据时宣称通过。

## 用户可见变化

### Android

- 首页新增“藏宝阁”入口；紧凑 Fold 布局从溢出菜单进入。
- 支持搜索、类型筛选、失败筛选、详情、批注、处理重试、批量置顶和归档。
- 600dp 进入列表/详情双栏，840dp 进入筛选栏/列表/详情三栏；查询、筛选、选中项、详情和未提交批注使用可保存状态。
- 系统分享明确区分“收进藏宝阁”和“发到对话”。
- 支持 URL、文字、图片、多图、PDF、文档、音频和视频原始文件捕获；附件可从详情页通过受限 FileProvider grant 打开。
- 原始保存完成后再由 WorkManager 做网页标题/正文提取、文本文件提取、索引和失败重试。没有引入常驻服务或大体积 OCR SDK；OCR/转写不可用时明确降级为 `partial`，不丢原文件。
- Agent 新增 `treasury_search`、`treasury_get`、`treasury_save`、`treasury_update`。搜索返回来源、命中片段、命中字段和可解释本地相关分；读取明确正文状态和截断；永久删除不在更新工具中。

### iOS/iPadOS

- Artifact Tray 增加“Save to Treasury”，通过现有附件导入器复制受管理版本，不引用会失效的临时路径。
- 收藏列表接受 URL 和文字拖放；网页链接直接保存，文件仍走既有安全导入管道。

### Mac

- `src/mac/leocodebox` 新增认证后的 `/api/treasury` 本机捕获与查询入口。
- CollectionsMirror 同时展示 Mac 本机条目与手机最后成功镜像；手机离线时保留旧内容并显示陈旧/失败状态。
- 支持粘贴 URL/文字、文件选择、拖放和受控聊天 Artifact 捕获。
- 文件流式复制并计算 SHA-256；单文件 100 MB、单批 20 个；列表 API 不返回二进制。

## 数据与协议变化

- Android 捕获统一落到 Phase 1 Room `treasure_*` 表和应用级 `TreasureRepository`。
- URL 使用规范化键去重，文件使用 SHA-256 去重；重复副本立即清理。
- WorkManager 作业最多自动尝试 5 次，进程中断作业可恢复；用户重试会重置尝试次数。
- 处理状态和增强结果同时写入 `sync_state=pending` 与 `treasure_changes`，避免未来增量同步漏掉后台增强。
- 分享暂存文件按当前 share 的文件名定向清理，避免并发分享互相删除原始字节。
- Android Agent 数组参数现在携带 JSON Schema `items.type`，四种 Treasury 工具共用统一定义。
- Android 列表和 `treasury_search` 改用轻量 SQL/FTS 投影，不再把完整正文装入列表结果；FTS `snippet()` 与 `offsets()` 提供紧凑命中片段、命中来源和加权分数。
- Mac 路由仅接受无嵌入凭据的 HTTP(S) URL；错误响应不回传本机绝对路径。
- Mac 列表/搜索投影不返回 `original_text` 或 `body_ref`，命中片段限制为最多 400 字符。

## 三轮审计与修复

### 第 1 轮：数据完整性、恢复与安全

修复：

- OkHttp 旧版本 `Dns` 构造导致 Android 编译失败。
- 附件复制、数据库保存或重命名失败时的临时/目标文件残留。
- SAF 文件选择读取中途超限或失败时，尚未进入批次清单的半成品暂存文件残留。
- 捕获、WorkManager 增强和 Agent 工具总入口的宽泛异常处理吞掉协程取消信号，可能把停止/离开误记为业务失败。
- `ContentResolver` 返回空流时仍生成不存在的暂存文件名；数据库刚提交后的取消清理可能误删已被条目引用的附件。
- 选取文件只有单文件限制、缺少 200 MB 批次限制。
- 全目录清理暂存文件导致并发 share 丢数据。
- 大文本附件和 Agent 读取使用 `readText()` 导致最多 100 MB 全量进内存。
- WorkManager 一次只处理 24 个任务，20 文件批次可能永久留下未处理任务。
- 数据库退避时间与 WorkManager 退避不一致，第二次空跑会提前结束后续重试。
- 每个 `index` 作业重复重建整库 FTS。
- 后台增强更新了条目但没有生成 change log。
- SSRF 仅依赖 Java 基础地址判断，未覆盖 CGNAT、文档网段、benchmark、IPv6 ULA/文档前缀。
- Mac 文件写入可能出现 partial write，数据库失败后目标文件残留，路由错误可能泄露内部消息。

### 第 2 轮：Agent 契约、网页增强与 UI/可访问性

修复：

- `treasury_search` 的固定分数和多词查询无法定位真实命中片段。
- 网页增强只取 `<title>`，正文无法被 `treasury_get` 或 FTS 使用。
- 禁止重定向导致常见 HTTP→HTTPS 链接长期处于失败状态；现在最多跟随 3 次，每一跳重新做 DNS 固定和公网地址校验。
- URL 中嵌入用户名/密码可能进入持久层或日志。
- Android 详情状态使用无动作 AssistChip，形成“假按钮”。
- Android 已保存附件缺少可打开入口。
- 紧凑顶栏文字动作在 200% 字体下更易拥挤，改为有 content description 的图标动作。
- Mac 捕获区和搜索框缺少显式无障碍标签及 busy 状态。

### 第 3 轮：冗余、边界和门禁复核

复核项：

- Standard 源集没有 Accessibility、Shizuku、悬浮窗或 Power API 依赖。
- FileProvider 只暴露 `filesDir/treasury/files/`，且仅通过显式只读 URI grant 打开。
- `treasury_save` 同时要求最近真实 USER 消息明确要求保存和工具参数 `user_confirmed=true`；检索正文不能单独授权写入。
- `treasury_update` 同样要求最近真实 USER 消息明确提出安全元数据修改；带 SYSTEM/Assistant、工具名、`user_confirmed` 或“忽略此前指令”等注入标记的文本不能授权保存或更新。
- `treasury_update` 不接受永久删除字段，且至少要有一个支持的更新字段。
- Mac 本机实现只位于 `src/mac/leocodebox`，未写入灰度回退目录。
- 未加入搜索服务、语义模型、常驻前台服务或无关抽象。
- `git diff --check` 通过；最终全量门禁结果见下节。

## 自动化验证

### Android

已通过：

```text
./gradlew compileStandardDebugKotlin compilePowerDebugKotlin
./gradlew compileStandardDebugAndroidTestKotlin compilePowerDebugAndroidTestKotlin
./gradlew testStandardDebugUnitTest testPowerDebugUnitTest
./gradlew lintStandardDebug lintPowerDebug
```

双 flavor instrumentation 测试源码已经成功编译；由于本机没有 Android 模拟器或真机，本阶段没有宣称实际执行 instrumentation 测试。

新增/扩展测试覆盖：

- Treasury 四工具定义和数组 schema；
- 保存/更新授权、否定句和提示注入文本；
- PendingShare 新旧 JSON 兼容；
- 私网、CGNAT、保留/文档 IPv4、IPv6 ULA/文档地址拒绝；
- 大文本读取字符预算；
- SAF 有界复制失败后的半成品清理；
- URL 凭据拒绝。

### iOS/iPadOS

已通过：

- `MinisLogicTests`：298/298，通过，0 failed，0 skipped。
- `xcodebuild -project LeoPhoneAgent.xcodeproj -target MinisShare -configuration Debug -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO build`：BUILD SUCCEEDED。

主 App build 仍被仓库现有 `LeoWatch` target 阻断：当前 Xcode 环境没有 watchOS 26.5，且 LeoWatch AppIcon/SwiftDriver 先于新主 App UI 的完整链接验证失败。因此不宣称 Artifact Tray 和 CollectionsView 已完成主 App 模拟器运行验证。

### Mac

已通过：

```text
npm run typecheck
npm run test:server   # 381/381 passed
npm run build
```

新增测试覆盖 MIME→kind、扩展名净化、HTTP(S) URL 与嵌入凭据边界。

## HOLD：需要用户设备/完整 SDK 的验证

- Android API 26 仪器测试、Standard/Power 真机安装和进程死亡恢复。
- Fold8 1080×1728 封面屏、1768×2208 展开屏、折叠切换、滚动位置、未提交批注和 200% 字体。
- TalkBack、预测性返回、真实 Sharesheet/SAF 多文件与大型附件。
- Android 固定签名指纹、上一版本覆盖安装、APK digest 和发布。
- iPhone/iPad 主 App 模拟器或真机：Artifact 保存、URL/文件/文字拖放、多窗口、VoiceOver、Dynamic Type、Reduce Motion。
- iOS 签名、Archive 和发布。
- Mac 真实界面拖放/键盘/屏幕阅读器验证；签名、公证和热更新。

## 实际修改范围

- Android：`MinisApp.kt`、Room DAO/Repository、分享接收与暂存清理、Agent tool schema/executor、导航/首页入口、`ui/treasury`、WorkManager/capture/file/network policy、三语言资源和测试。
- iOS：`Agent/Artifacts/ArtifactTrayView.swift`、`Views/CollectionsView.swift`。
- Mac：`server/index.ts`、数据库导出、`treasury.routes.ts`、capture policy/test、`CollectionsMirror.tsx`。
- 文档：本报告、总施工规范 Phase 2 证据链接、`.ui-pipeline` 三份 UI 证据。

## 下一阶段

Phase 3 将增加收件箱/处理中/失败/待读/最近使用、阅读进度、高亮与定位批注、PDF 逐页文本、精确过滤语法，以及保持 FTS 为默认的可选语义检索/RRF。不会提前实现完整知识图谱。
