# UI Proof

## Verification scope

- Release level: Phase 5 source delivery；不发布 APK/IPA/Mac 包。
- Screens: Android Treasury 单/双/三栏、Share destination、处理/阅读筛选、详情/定位高亮/批注/重试；iPad drop；Artifact Tray save；Mac 捕获、搜索、阅读、高亮、同步范围、离线合集、按需正文/附件与 Agent 引用工作台。
- Required viewports: Fold8 1080×1728 cover、1768×2208 expanded、200% font；当前无 AVD，视觉状态为 HOLD。

## Automated evidence

- Android Standard/Power: Kotlin compile、instrumentation 测试源码 compile、完整 JVM tests、lint 均通过；lint 0 error；无设备，因此 instrumentation 未执行。
- Android contract tests: Standard/Power 各 612 tests（0 failed、1 skipped）；Room 11→12、精确查询/特殊字符标签、结构化 Agent 筛选、严格时间边界、阅读状态/进度、高亮事务、Agent 授权/注入、PDF 任务边界、相关正文/相关收藏与显式重试状态。
- iOS: MinisLogicTests 317/317；MinisShare direct target simulator build succeeded；Spotlight 不再接收正文/URL/摘要，分享暂存按原始字节成功后发布；200/500 条过滤、相关正文/相关收藏、有限重试和用户标题保护有自动化回归。
- iOS main app: HOLD；`LeoPhoneAgent` scheme 包含嵌入式 Apple Watch App，本机未安装 watchOS 26.5，`xcodebuild` 以 exit 70 在编译前终止。
- Relay: 12/12 安全与协议测试通过，覆盖幂等、乱序、重启、旧 500 快照、按需资产和 MIME/digest 拒绝。
- Mac: typecheck passed；desktop 37/37；client 163/163；server 401/401；全仓 lint 和 production build passed；结构化过滤、相关收藏、UTF-16 截断、有限重试和 PDF 重试完整性有自动化回归。

## Rendered/interaction evidence

- Android emulator screenshots: HOLD，无可用 AVD，未伪造 Fold8/200%/TalkBack 证据。
- iPhone/iPad screenshots: HOLD，主 App 未越过仓库现有 LeoWatch build blocker。
- Mac browser walkthrough: production build 宽/`720×900` 窄布局、本机捕获、六视图 Arrow/Home/End 键盘切换、搜索、详情、阅读、高亮、引用和同步范围控件真实渲染通过；console 0 error/0 warning。真实 Electron 双机 Relay和屏幕阅读器仍 HOLD。

## Code-level accessibility evidence

- Android 交互均使用 Button/IconButton/Checkbox/FilterChip/可点击 Row；图标动作有 content description。
- 非交互状态从 AssistChip 改为 Surface 标签，避免假按钮。
- 详情附件通过受限 FileProvider 只读 grant 打开。
- 查询、筛选、选择、详情 ID、批注草稿使用 rememberSaveable；LazyListState 保持滚动状态。
- Android 列表和 Agent 搜索使用轻量 SQL/FTS 投影，不加载完整正文；Mac 列表投影排除正文与文件引用。
- Mac textarea、搜索、同步 select 和捕获 group 有 label/aria-label；保存区暴露 aria-busy；手机离线和离线缓存结果使用 role=status。
- Mac 六视图使用 tab/tabpanel、roving tabindex、Arrow/Home/End；加载使用 live status，失败使用 assertive alert，详情打开后移动焦点，删除高亮先确认。
- 三端交互式正文视图设字符上限，完整原始内容仍留在本地存储；失败和 partial 状态以文字表达，不只依赖颜色或动效。

## Originality gate

| Axis | Score | Evidence |
|---|---:|---|
| Product specificity | 2 | 原始先保存、处理/阅读状态、PDF 页级命中、Agent 调用与手机陈旧镜像均为藏宝阁真实机制 |
| Hierarchy | 2 | 搜索/列表为首读，详情与捕获动作层级明确 |
| Composition | 2 | Android 1/2/3 栏按可用宽度重组 |
| Material/assets | 2 | 完全复用三端原生系统与仓库 token，无新视觉依赖 |
| Typography/color | 1 | 代码适配动态字体；真实 200% 截图待设备验证 |
| Interaction/motion | 1 | 状态恢复和系统交互已实现；真实折叠/键盘验证待设备 |
| Feasibility | 2 | 双 flavor 与 Mac/iOS 可运行子目标门禁通过 |
| **Total** | **12/14** | 通过门槛，但视觉发布保持 HOLD |

## Remaining risk

- Fold8 折叠时的实际窗口时序、滚动恢复和 200% 顶栏仍需真机/AVD。
- TalkBack、预测性返回、SAF 大批量分享需要设备验证。
- iOS Artifact/Drop 主 App 源文件未获得完整 simulator build/run 证据。
- Mac Electron 双机 Relay、拖放、键盘与屏幕阅读器仍需运行走查。
- 当前附件支持完整文件重试和原子落盘，没有 HTTP Range 断点续传证据。
- 可选音频转写和可选语义召回/RRF 未启用；当前 FTS 基础检索不依赖模型。

## 2026-09-04 release proof

- Android alpha.25: Standard/Power compile passed; both flavors ran 628 JVM tests with 0 failures and 1 skip each; Standard/Power Release lint completed with 0 errors; both signed Release APKs passed package/version/signer/capability-isolation gates.
- Fold8 API 35: alpha.24 → alpha.25 Standard and Power upgrade installs returned `Success`; cold launch and ACTION_ASSIST returned `Status: ok`; no app `FATAL EXCEPTION` was found. The same process id survived 1080×1728 → 1768×2208 resizing.
- Visual evidence: `/tmp/leophone-alpha25-treasury-cover.png`, `/tmp/leophone-alpha25-treasury-before.png`, and `/tmp/leophone-alpha25-treasury-cover-200-v4.png`. Primary filters, Save/Import empty actions, dual-pane starter action and 200% top-bar reachability are visible.
- iOS/iPadOS 1.32.0 source: Watch AppIcon compiled for watchOS, iPhone device target build passed without signing, release/readiness/accessibility/visible-control audits passed, and MinisLogicTests passed 332/332. Per user instruction, no iPhone/iPad installation was performed yet.
- Mac 1.82.0: release-note gate, typecheck, lint, production build, desktop 37, client 168 and server 406 tests passed. Signed DMG/ZIP were produced; 36 nested Mach-O signatures passed strict verification. `/Applications/leocodebox.app` is the only installed copy and `/health` reports version 1.82.0.

Finish state: PASS for source/build and Android Fold8/Mac installed validation. iPhone/iPad remains intentionally pending final real-device installation, not a simulator substitute.

## 2026-09-04 G1/G2 implementation evidence (in progress)

- Mac dashboard source, 16 card/test files, dashboard data hook, animated metric helper and standalone LeoAPI panel were removed rather than hidden.
- The normal local BrowserView now fills the Electron window from y=0; the React workbench title bar owns the traffic-light-safe drag region, eliminating the visible launcher bar stack.
- Workbench title bar now exposes only New Task, device status and Settings. Command Palette no longer switches LeoAPI nodes.
- One Task Dock renders only in the internal new-task state; selected sessions render only their own composer. A quiet TaskStartView replaces the dashboard.
- LeoAPI route management is mounted in Settings → 接口与凭据; the first implementation covers provider list, add/edit, masked secret preservation, model discovery, preview/apply, test, native rollback and current/CC Switch import.
- CodexHost dependency and native payload are upgraded from 0.3.5 to 0.4.4.
- Codex third-party switching is config-only: `experimental_bearer_token` lives in the provider table and official `auth.json` is no longer overwritten.
- Android ActionRouter focused suite passes 13/13. iOS MinisLogicTests passed on the booted iPhone 17 Pro simulator after the separate stale “Codex Test” clone failed to allocate.
- Mac typecheck, production build and client tests passed (162/162). Full server test reached 405/406; its only failure was the old expected CodexHost version and has been updated for 0.4.4. Lint found one radius-tier violation, corrected before the next full gate.

Finish state: this interim HOLD is superseded by the final proof below.

## 2026-09-04 unified work-surface final proof

### Round A · product, UI, motion and accessibility

- Mac 1.83.0 installed app: CUA accessibility tree and rendered screenshots at 1024×640 and 1440×960 show one native/React title bar, one Task Dock on New Task, and exactly one composer after entering a session. The title bar exposes New Task, device status and Settings only.
- Settings → 接口与凭据 visibly contains the local gateway, context protection, health monitor, target tabs, provider import/create/test/apply/rollback and CC Switch import. No launcher, sidebar, title-bar or command-palette LeoAPI button remains.
- Mac motion is limited to location/state continuity (`wb-anim-entry`, chip/menu transitions) and is disabled by `prefers-reduced-motion`; dashboard metric rolls and decorative card stagger were deleted with the dashboard.
- Fold8 API 35 rendered at 1768×2208 and 1080×1728. A real 200% font pass exposed a clipped home title and setup-card subtitle; the fix switches narrow/large-font chrome to `Leo`, moves secondary actions into the overflow, enables scrolling and gives step content dynamic height. Re-render confirms the title and first card are no longer clipped.
- iOS/iPad keep native Dynamic Type, NavigationSplitView, Stage Manager sizing, drag/drop and Artifacts. ⌘⇧O now opens Artifacts from a hardware keyboard; iPad physical installation remains explicitly deferred because the device is not present.

### Round B · capability and failure recovery

- Android xAI: authenticated live `/v1/models`, correct xAI default base, full built-in fallback and OAuth Chat-Completions bearer path are covered by MockWebServer tests. Provider groups now filter disabled/hidden/uncredentialed members before fallback/load-balance selection and retain OAuth-only members.
- iOS/Android deterministic intent routing understands reminders, calendar and rail/flight/bus/trip records plus relative dates, weekdays and month/day input. Missing required fields produce one clarification; EventKit/local stores are read back before issuing a success receipt.
- Android cold recovery recognizes tool-result, unfinished tool-use, Continue reminder and ordinary unanswered user tails. iOS uses the same non-empty-user-tail invariant. Long pastes fold out of the composer and >15k text becomes a normal previewable attachment.
- Android sideloaded restricted-settings state is diagnosed from the installer source; Power may clear the app-op only through already-authorized Shizuku and must read back `allow`. A newer Room database is opened read-only for version inspection and left untouched with a guidance screen instead of crashing or wiping data.

### Round C · build, security, performance and release

- Net source change removes roughly 4k lines of Mac dashboard/duplicate-shell code while adding the settings integration and mobile reliability contracts; no new third-party UI or runtime dependency was added. CodexHost is the only dependency update (0.3.5 → 0.4.4).
- Mac: release-note gate, typecheck, lint, production build, npm audit (0 vulnerabilities), desktop 37/37, client 159/159 and server 406/406. Signed DMG/ZIP validate 36 nested Mach-O files; installed `/Applications/leocodebox.app` reports `/health` version 1.83.0.
- Android: Standard/Power compile, 641/641 JVM tests per flavor (0 failed, 1 skipped), Debug lint and Release lint/R8/assembly pass with 0 errors. Both signed Release APKs pass package/version/signer/capability-isolation checks and both cold-launch on Fold8 API 35 without app FATAL/ANR.
- iOS: MinisLogicTests 337/337 and generic iPhone/iPad device build pass with signing disabled. The main simulator build is honestly HOLD because the committed iSH static libraries are iphoneos arm64, exactly as documented in BUILDING.md; this does not block the physical-device build the user will install elsewhere.
- Secrets scan over the patch found only the deliberate fake bearer in a unit test. Codex switching never mutates official `auth.json`; provider-bound secrets remain encrypted/0600 and transactional backups/rollback stay enabled.

Finish state: PASS for source, full build gates, Android Fold8 Release installs and installed Mac 1.83.0. HOLD is limited to iPhone/iPad physical installation and Apple notarization credentials, both external/device-gated and explicitly documented rather than claimed complete.
