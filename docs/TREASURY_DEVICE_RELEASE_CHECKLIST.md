# 藏宝阁设备测试与发版清单

本清单用于在具备 Xcode、Android Emulator/真机、Fold8 和签名材料的环境关闭 Phase 5 HOLD。每一项必须保留命令输出、截图/录屏、日志、版本、设备信息和产物 digest。任一门禁缺证据时，只能测试或 push 源码，不能发布。

## 共同起点

```bash
git status --short --branch
git fetch --prune --tags origin
git rev-list --left-right --count HEAD...origin/main
git rev-parse HEAD
git rev-parse origin/main
git submodule update --init --recursive
```

- 确认远端为 `https://github.com/leoyb1010/LeoPhoneAgent`。
- 确认 `HEAD == origin/main`，工作区没有未知改动。
- 记录测试提交 SHA；所有安装包、日志和 digest 必须对应该 SHA。
- 不生成或替换仓库既有签名链，不自动创建新的 `debug.keystore` 充当升级证书。

## iOS / iPadOS

### 模拟器

- 安装仓库要求的 Xcode/iOS/watchOS runtime，先跑 `MinisLogicTests` 和 `MinisShare` build。
- 在小屏、标准、大屏 iPhone，以及 iPad 竖屏、横屏、分屏和窗口缩放中完成：捕获、搜索、详情、笔记正文、PDF、批注、多选交给 Agent、save/update 授权拒绝与成功路径。
- iPad 验证 URL、文字、图片/PDF/文件拖放；切换窗口大小后查询、筛选、选中条目和批注草稿不丢失。
- 开启 VoiceOver、最大 Dynamic Type 和 Reduce Motion；验证所有操作可读、焦点顺序正确、状态不只依赖颜色或动画。
- 验证 Share Extension 只保存原始内容和排队，不运行 WebView、OCR 或模型；主 App/Share 并发保存不丢条目。
- 在存储管理分别清理缩略图与同步临时缓存，确认收藏、正文、批注和原始附件仍在；后台任务可重新生成缩略图。

### 真机与发版

- 使用用户自己的签名团队完成 iPhone/iPad 真机安装、后台恢复、Files/Photos/Scanner/Spotlight/App Intents。
- 检查 Spotlight 不包含私密正文。
- 完成 Archive 后记录 Xcode、SDK、证书、Provisioning Profile、bundle/build 版本和 Archive SHA。
- 未实际完成签名、Archive、安装和回归前，不上传 IPA、不声明 iOS 已发布。

## Android Standard / Power

### 自动化基线

```bash
cd src/android
./gradlew compileStandardDebugKotlin testStandardDebugUnitTest lintStandardDebug \
  compilePowerDebugKotlin testPowerDebugUnitTest lintPowerDebug
```

- Standard 与 Power 必须同时成功；Standard 不得出现 Accessibility、Shizuku、悬浮窗或 Power 权限依赖。
- 有设备/AVD 后执行仓库 instrumentation tests，并保存 XML/HTML 报告。

### API 26 与进程恢复

- API 26 冷启动、旧数据库迁移、分享 URL/文字/图片/多图/PDF/文档/文件。
- 分别从 Standard/Power 的 Launcher App Shortcut、快捷设置藏宝阁图块和桌面小组件“收藏”按钮冷/热启动；确认只弹一次文字/URL 捕获框，返回/旋转不重复弹出，普通藏宝阁入口不被强制弹框。
- 确认系统入口不自动读取剪贴板；未授予 Accessibility、Shizuku、悬浮窗或 Power 权限时 Standard 仍可完成捕获。
- 保存原始内容后立即断网、杀进程；重启确认原始内容仍在，WorkManager 继续或可重试。
- 制造 OCR/PDF/索引失败，确认失败可见、可解释、可重试，且附件不丢失。
- 验证预测性返回、SAF 权限失效、附件缺失和 digest 不一致。
- 分别清理同步临时缓存并复核原始附件、正文和条目不受影响；Standard/Power 行为一致，路径异常时必须失败关闭。

### Fold8

- 封面屏：`1080×1728`；展开屏：`1768×2208`。
- 冷启动分别验证单栏/双栏/三栏；不要按型号硬编码，以实际窗口宽度和折叠姿态为准。
- 在输入搜索词、选择筛选、滚动列表、选中条目并编辑未提交批注时折叠/展开；上述状态必须全部保留。
- 开启 200% 字体和 TalkBack，验证顶栏、筛选、状态、错误、详情、保存和重试无裁切、无假按钮、焦点可达。
- 执行连续分享、多图、大 PDF、进程死亡和 WorkManager 恢复；记录 ANR、内存和电量。

### 签名、覆盖安装与 APK

- 使用仓库固定升级签名验证 Standard/Power 证书指纹，不得替换既有链。
- 从上一可用版本分别覆盖安装 Standard 和 Power；验证 Room migration、旧收藏、附件、阅读进度、批注和登录状态。
- 核对 versionCode/versionName、包名、flavor、ABI 和源码 SHA。
- 冷启动后保存完整 Logcat，扫描 `AndroidRuntime`、ANR、SQLite、WorkManager、SecurityException 和文件路径错误。
- 对最终 APK 计算并记录 SHA-256；只有所有门禁通过后才允许创建 GitHub Release。

## Mac

### 本机应用

```bash
cd src/mac/leocodebox
npm run typecheck
npm run test:client
npm run test:server
npm run build
npm audit
npm audit --omit=dev
```

- 在真实 Electron 窗口验证宽/窄布局、六视图键盘导航、搜索、捕获、详情、高亮、批注、离线合集和陈旧状态。
- 在“设置 → 存储空间”验证原始文件只读统计、正文/附件缓存独立确认清理、零字节和文件缺失残留；清理后本机原始文件不变。
- 使用 VoiceOver 验证 tab/tabpanel、加载 live region、assertive error、详情焦点和确认对话框。
- 分别从 Claude Code、Codex、Cursor 和 OpenCode/Grok 枚举 `leocodebox-treasury`，执行 search → get → answer、多选引用、截断、文件缺失、保存、更新、归档和审批拒绝。
- 手机离线时确认最后成功内容保留并标陈旧；Relay 恢复后只拉增量，不上传整库。

### 双机 Relay 与跨端矩阵

- iOS 创建，Android/Mac 看见；Android 更新，iOS/Mac 看见。
- 双端同时编辑同一条；验证冲突排序、用户字段保护和最终三端一致。
- 离线删除后恢复；旧 upsert 不得复活 tombstone。
- 注入重复、乱序 change 和过期游标；验证幂等与 410 分页重建。
- 正文/附件按需下载；错误 byte count、digest、MIME 或越界路径必须拒绝。
- 大正文和大附件不进入列表 API；当前不测试或宣称 HTTP Range，因为尚未实现。

### 签名、公证与热更新

- 完成 Developer ID 签名后验证全部嵌套 Mach-O 和 entitlements。
- 实际提交 Apple notarization，并保存 request ID、成功结果和 stapling/Gatekeeper 输出。
- 热更新必须记录版本、下载 URL、文件大小、SHA-256、签名、回滚版本和断网/损坏包拒绝结果。
- 未实际成功时不得写“已签名”“已公证”“已发布热更新”。

## 性能与电量

- 分享成功感知反馈 P95 ≤ 300 ms（不含大型附件物理复制）。
- 1,000 条首屏 P95 ≤ 400 ms；1,000 条搜索 P95 ≤ 150 ms；10,000 条搜索 P95 ≤ 300 ms。
- 本地 `treasury_search` P95 ≤ 500 ms，不含模型生成。
- 分别记录冷/热启动、CPU、峰值内存、主线程卡顿、后台 job 时间、网络字节和 30 分钟电量变化。
- 验证没有藏宝阁常驻前台服务、24 小时剪贴板/截图监听或每次整库同步。

## 完成后提交的证据

- 设备/OS/Xcode/Android Gradle Plugin/JDK/Node 版本。
- 每条命令的完整成功摘要和测试数量。
- iPhone/iPad/Fold8/Mac 截图或录屏；敏感内容必须脱敏。
- 签名指纹、覆盖安装来源版本、最终版本号和产物 SHA-256。
- 三端联网矩阵结果、性能/电量结果和所有失败项。
- 若有修复，重新执行受影响平台完整门禁并提交独立 SHA；push 前再次 fetch，禁止强推。
