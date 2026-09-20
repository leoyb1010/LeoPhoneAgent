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


## 2026-09-12 Mac W11/W12/W13 implementation

Operate surface, existing teal/system-font tokens, Quiet motion. Implemented modal focus/inert, library navigation, Agent default settings, bounded remote follow and draft preservation. Client tests 181/181, client TypeScript and scoped ESLint passed on synchronized npm-ci validation checkout. Finish detector completed. **HOLD for rendered proof**: parent task owns CUA; drawer/nested dialogs, smallest window, library flow, Reduce Motion and remote >400-row fixture need real runtime validation. Details: outputs/implementation-2026-09-12/mac-ui/IMPLEMENTATION.md.

## 2026-09-20 Mac 2.0.2 adversarial cluster (iOS untouched)

Source/build evidence only; no signed DMG or Electron CUA this turn.

- Version `2.0.2` + `LEO_RELEASE_NOTES` front entry; `verify:release-notes` 3/3.
- Client suite 54/54. Client `tsc --noEmit` passed. Arsenal server test 6/6 with `TSX_TSCONFIG_PATH`.
- Settings can upsert/list/expand custom OpenAI/Anthropic-compatible providers; catalog names match pi-ai 0.85.1 (Opus/Sonnet 5, GPT-5.6/6, Grok 4.6, Gemini 3.8, GLM-5.3, Kimi K3).
- Fleet stale after 2 failed probes; session stream `onOpen` → live / close → 重连中; Enter-to-send; per-session drafts; jump-to-latest; live-only row motion; think rows styled.
- **HOLD**: Electron/runtime walkthrough, signed install, server run-cursor (M01), remote term/files, exact-window still not real act.

## 2026-09-20 Mac 2.0.3 adversarial cluster (iOS untouched)

- Version `2.0.3` + `LEO_RELEASE_NOTES` front entry; `verify:release-notes` 3/3.
- Client suite 55/55. Client `tsc --noEmit` passed.
- `applyEvent` skips `seq <= view.seq` so replay/live overlap does not duplicate rows.
- Ended/failed/orphaned sessions can continue in the same cwd with draft as the first prompt; remote drawer copies path and continues instead of dead copy.
- Drawer is `role=dialog` and focuses Close; NewSessionBox syncs cwd/prompt and keeps an offline machine selectable.
- **HOLD**: Electron/runtime walkthrough, signed install, exact-window still not real act.

## 2026-09-20 Mac 2.0.4 adversarial cluster (iOS untouched)

- Version `2.0.4` + `LEO_RELEASE_NOTES` front entry; `verify:release-notes` 3/3.
- Client suite 55/55. Client `tsc --noEmit` passed.
- Active session stays in the rail when the current filter would hide it (ended while viewing).
- lastLine for orphaned/completed/cancelled is a status, not leftover chat text.
- New sessions remember last model; continue carries original model + cwd; ended/remote panels use Quiet rise.
- **HOLD**: Electron/runtime walkthrough, signed install.

## 2026-09-20 Mac 2.0.5 adversarial cluster (iOS untouched)

- Version `2.0.5` + `LEO_RELEASE_NOTES` front entry; `verify:release-notes` 3/3.
- Client suite 56/56. Client `tsc --noEmit` passed.
- Custom provider id/url validated in the form (http/https, lowercase id); catalog filter when >6 models.
- Continue keeps a model that is not in the local catalog as「原会话」. Model-switch sys row uses product names.
- Timeouts, 502, bad keys, unreachable machines are humanized. Device counts skip ended sessions; stale remotes can still try create.
- **HOLD**: Electron/runtime walkthrough, signed install.

## 2026-09-20 Mac 2.0.6 adversarial cluster (iOS untouched)

- Version `2.0.6` + `LEO_RELEASE_NOTES` front entry; `verify:release-notes` 3/3.
- Client suite 57/57. Client `tsc --noEmit` passed.
- `sessionCanDrive` treats REST terminal status as authoritative so a completed process is not driveable just because the flow row says idle.
- Stop copy no longer claims you can keep talking; toasts humanize `session is not running`.
- Reconnecting composer hint; `harness.translate_error` becomes a sys row.
- **HOLD**: Electron/runtime walkthrough, signed install.

## 2026-09-20 Mac 2.0.7 adversarial cluster (iOS untouched)

- Version `2.0.7` + `LEO_RELEASE_NOTES` front entry; `verify:release-notes` 3/3.
- Client suite 57/57. Client `tsc --noEmit` passed.
- Settings can pin the next-session default model. Empty main retries local/fleet when the service is down.
- `humanizeError` no longer treats `:5020` as HTTP 502. Need sessions ping once; need-strip and product model names in the rail.
- **HOLD**: Electron/runtime walkthrough, signed install.

## 2026-09-20 Mac 2.0.8 adversarial cluster (iOS untouched)

- Version `2.0.8` + `LEO_RELEASE_NOTES` front entry; `verify:release-notes` 3/3.
- Client suite 57/57. Client `tsc --noEmit` passed.
- Drawer Tab cycles inside the open drawer. New session remembers last cwd when the current one is just `~`.
- Settings/channel errors go through `humanizeError`. Approval cards and filter chips use Quiet motion.
- **HOLD**: Electron/runtime walkthrough, signed install.

## 2026-09-20 Mac 2.0.9 adversarial cluster (iOS untouched)

- Version `2.0.9` + `LEO_RELEASE_NOTES` front entry; `verify:release-notes` 3/3.
- Client suite 57/57. Client `tsc --noEmit` passed.
- Command palette and pickers are `aria-modal`. Unknown model ids title-case; Qwen3 Coder / Grok Code / Claude 3.7 Sonnet named.
- **HOLD**: Electron/runtime walkthrough, signed install.

## 2026-09-20 Mac 2.0.10 adversarial cluster (iOS untouched)

- Version `2.0.10` + `LEO_RELEASE_NOTES` front entry; `verify:release-notes` 3/3.
- Client suite 57/57. Client `tsc --noEmit` passed. Arsenal 6/6.
- Settings lists this version's items in full. Flagship pretty names cover GPT-5.6 Sol / Gemini 3.8 Flash / GLM-5.3.
- **HOLD**: Electron/runtime walkthrough, signed install. Remote term/files still not proxied. 2.0 shell does not expose exact-window.

## 2026-09-20 Mac 2.0.14 adversarial cluster (iOS untouched)

- Version `2.0.14` + `LEO_RELEASE_NOTES` front entry; `verify:release-notes` 3/3.
- Client suite 70/70. Client `tsc --noEmit` passed. exact-window-routes 6/6.
- Running sessions keep 插话 + 停止. New-session first prompt uses the same Enter-to-send as the composer.
- Workbench local create binds frontmost window after 202 (same as phone path). `window.bound` becomes a sys row; header shows the name, no click proxy.
- **HOLD**: Electron/runtime walkthrough, signed install first-launch overlay. Remote term/files still not fleet-proxied.

## 2026-09-20 Mac 2.0.15 adversarial cluster (iOS untouched)

- Version `2.0.15` + `LEO_RELEASE_NOTES` front entry; `verify:release-notes` 3/3.
- Client suite 72/72. Client + server `tsc --noEmit` passed. leophone.test 24/24 (forget + rehydrate).
- Ended/failed/orphaned sessions can leave the rail (right-click, ⋯, ended composer, ⌘K). Live sessions stay.
- Local journals move to `forgotten/` so restart does not rehydrate them. Remote hide is this-Mac only.
- `desktop:dev` is up: `/health` is `2.0.15`, Vite `5173` 200, Electron launched by the script. Overlay was not screenshot-verified from this agent.
- **HOLD**: signed install first-launch overlay. Remote term/files still not fleet-proxied.

## 2026-09-20 Mac 2.0.16 adversarial cluster (iOS untouched)

- Version `2.0.16` + `LEO_RELEASE_NOTES` front entry; `verify:release-notes` 3/3. Client 73/73. Client `tsc` clean.
- Rail filter counts include the active history row; `run.failed` orphans count as 失败. Light flow/composer share one 720px column.
- WhatsNew re-checks when the injected version changes.
- Runtime: relaunched `desktop:dev` after version inject. `/health` `2.0.16`, Vite `VITE_APP_VERSION=2.0.16`. Electron window screenshot `.ui-pipeline/leocodebox-2.0.16-whatsnew.png` shows 「本次更新」 / v2.0.16 / this version's two items / 知道了.
- **HOLD**: signed install / notarized first-launch. Remote term/files still not fleet-proxied.

## 2026-09-20 Mac 2.0.17 adversarial cluster (iOS untouched)

- Version `2.0.17` + `LEO_RELEASE_NOTES` front entry; `verify:release-notes` 3/3. Client 74/74. Client `tsc` clean.
- Ended sessions that failed for missing login/key offer 去设置 first; continue is secondary.
- Fleet/local names that differ only by `.local` collapse to one machine in the rail and Devices.
- **HOLD**: signed install. Remote term/files still not fleet-proxied. desktop:dev still on the 2.0.16 inject until next relaunch.

## 2026-09-20 Mac 2.0.18 adversarial cluster (iOS untouched)

- Version `2.0.18` + `LEO_RELEASE_NOTES` front entry; `verify:release-notes` 3/3. Client 75/75. Client `tsc` clean. leophone.test 25/25.
- Local pi create refuses when `hasAnyPiAuth` is empty (client also routes to Settings). Rail search matches title / cwd / model.
- Runtime: `desktop:dev` relaunched after the previous 2.0.16 shell was aborted. `/health` is `2.0.18`. Electron shot `.ui-pipeline/leocodebox-2.0.18-whatsnew.png` shows ended composer 「去设置」 first, plus left-rail 「找会话」. Overlay was not in this frame (likely already marked seen after the 2.0.16 card).
- **HOLD**: signed/notarized first-launch overlay. Remote term/files still not fleet-proxied.

## 2026-09-20 Mac 2.0.19 adversarial cluster (iOS untouched)

- Version `2.0.19` + `LEO_RELEASE_NOTES` front entry; `verify:release-notes` 3/3. Client 76/76. Client `tsc` clean.
- Filter chips: only 「全部」 counts the open history row. 「进行中」/「需要你」 stay at the real category. Same-machine fleet extras merge into local instead of being dropped.
- HMR shot `/tmp/leo-runtime/leocodebox-2.0.19-hmr.png`: 全部 1 · 进行中 0 · 需要你 0 · 失败 3 · 历史 1 while viewing the failed orphan. Health was still 2.0.18 until relaunch.
- Runtime: previous 2.0.18 `desktop:dev` aborted; relaunched. `/health` `2.0.19`. Electron shot `.ui-pipeline/leocodebox-2.0.19-whatsnew.png` shows 「本次更新」 / v2.0.19 / this version's two items / 知道了.
- **HOLD**: signed/notarized first-launch overlay. Remote term/files still not fleet-proxied.

## 2026-09-20 Mac 2.0.20 adversarial cluster (iOS untouched)

- Version `2.0.20` + `LEO_RELEASE_NOTES` front entry; `verify:release-notes` 3/3. Client 77/77. Client `tsc` clean.
- No models: `+ 新会话` / ⌘N / empty-main go to Settings. Failed no-key sessions show a centered 「这个模型还不能用」 card instead of a red line in a white void.
- Runtime: 2.0.19 `desktop:dev` aborted again; relaunched. `/health` `2.0.20`. Electron shot `.ui-pipeline/leocodebox-2.0.20-whatsnew.png` shows 「本次更新」 / v2.0.20 / this version's two items / 知道了. Behind the card: 「这个模型还不能用」 + 去设置.
- Signed DMG: `release/desktop/leocodebox-2.0.20-mac-arm64.dmg` Developer ID + notarized + stapled (`eceb11af…` then final `ffd60340…`). Installed to `/Applications/leocodebox.app` (CFBundleShortVersionString 2.0.20). Clean-profile first launch `/health` 2.0.20. Shot `.ui-pipeline/leocodebox-2.0.20-install.png` shows 「本次更新」 / v2.0.20 / this version's two items / 知道了.
- **HOLD**: remote term/files still not fleet-proxied. No provider logged in, so a live coding turn is still unproven.

## 2026-09-20 Mac 2.0.21 adversarial cluster (iOS untouched)

- Version `2.0.21` + `LEO_RELEASE_NOTES` front entry; `verify:release-notes` 3/3. Client 78/78. Client + server `tsc` clean. `runtime-paths.test` 1/1.
- Settings ranks configured + first-login providers, adds 「找供应商」, and says models come from the live provider after login. Packaged `/health` installMode is `bundled` instead of `npm`.
- Runtime: 2.0.20 notarized install overlay already proven. Electron `desktop:dev` shot `.ui-pipeline/leocodebox-2.0.21-whatsnew.png` shows 「本次更新」 / v2.0.21 / this version's two items / 知道了.
- **HOLD**: remote term/files still not fleet-proxied. Live OAuth/coding turn still unproven.

## 2026-09-20 Mac 2.0.22 adversarial cluster (iOS untouched)

- Version `2.0.22` + `LEO_RELEASE_NOTES` front entry; `verify:release-notes` 3/3. Client 79/79. Client + server `tsc` clean. Catalog tests include unconfigured key providers → empty list.
- Live `/api/leophone/pi/providers`: only `openai-codex` configured, 8 models from `getAvailable()` (`gpt-5.3-codex-spark` … `gpt-6-astra`). 39 unconfigured providers return 0 models (was 33 leaking built-in catalogs).
- Settings homepage: configured + first-login only; 「更多供应商」 for the rest. Main empty state waits for providers before saying 「还没有可用模型」.
- Runtime: Electron shot `.ui-pipeline/leocodebox-2.0.22-whatsnew.png` shows 「本次更新」 / v2.0.22 / this version's two items / 知道了. Development Electron was then quit so the extra Dock tile is gone.
- Live create: `POST /api/leophone/local/sessions` `openai-codex/gpt-5.4-mini` → 202 `hs_ac00c01f85094e8f4d109dec28877695`, then idle. Journal: Codex rejected ChatGPT account for that id; dialect still emitted `run.completed`.
- **HOLD**: ChatGPT-rejected models looked successful (fixed in 2.0.23). Remote term/files still not fleet-proxied. 2.0.22 not signed.

## 2026-09-20 Mac 2.0.23 adversarial cluster (iOS untouched)

- Version `2.0.23` + `LEO_RELEASE_NOTES` front entry; `verify:release-notes` 3/3. Client 79/79. `pi-runtime` includes stopReason=error → `run.failed`. Client + server `tsc` clean.
- New-session default prefers a live id containing `codex` (not a hardcoded model table). ChatGPT-account Codex errors are humanized.
- Runtime: no new Electron/desktop:dev this cluster (user rejected the extra Dock Electron). Overlay/install for 2.0.23 not captured.
- **HOLD**: remote term/files still not fleet-proxied. Successful live coding turn still unproven (`gpt-5.3-codex-spark` not retried). 2.0.23 not signed.

## 2026-09-20 Mac 2.0.24 adversarial cluster (iOS untouched)

- Version `2.0.24` + `LEO_RELEASE_NOTES` front entry; `verify:release-notes` 3/3. Desktop 46/46 (includes helper wiring). Client 79/79. Client + server `tsc` clean.
- `desktop:dev` on macOS starts the backend via `scripts/dev-backend.app` (`LSUIElement` + `LSBackgroundOnly`, Electron binary/Frameworks symlinked in). It no longer spawns `node_modules/electron/dist/Electron.app` as a sibling Dock app.
- Runtime: helper not launched this cluster (user told the extra Dock Electron to stop). Overlay/install for 2.0.24 not captured.
- **HOLD**: remote term/files still not fleet-proxied. Successful live coding turn still unproven. 2.0.24 not signed.

## 2026-09-20 Mac 2.0.25 adversarial cluster (iOS untouched)

- Version `2.0.25` + `LEO_RELEASE_NOTES` front entry. Default skips ChatGPT-rejected live ids (`spark`, `gpt-5.4*`) and lands on first remaining catalog item (`gpt-5.5`).
- Helper-only backend (`dev-backend.app`, no extra on-screen window): `/health` `2.0.24` then source bumped. Live create `openai-codex/gpt-5.5` → `hs_edaf6a2cb18b1c8176f71b25b73b8539`, journal `message.delta`「好」, `run.completed`. `gpt-5.3-codex-spark` / `gpt-5.4` / `gpt-5.4-mini` → `run.failed` ChatGPT account reject.
- Dock: tsx was respawning via resolved `Electron.app` path (the nameless tile). Helper binary is now a hard link; backend starts with in-process tsx `--import`, not `tsx` CLI.
- Runtime: no `desktop:dev` GUI this cluster (user rejected the extra Dock Electron). Overlay/install for 2.0.25 not captured.
- **HOLD**: remote term/files still not fleet-proxied. 2.0.25 not signed.

## 2026-09-20 Mac 2.0.26 adversarial cluster (iOS untouched)

- Version `2.0.26` + `LEO_RELEASE_NOTES` front entry. After a ChatGPT Codex reject, the same session stays driveable so the user can switch models, but send is blocked while the current id matches the reject.
- New-session / picker / Settings default mark `spark` / `GPT-5.4*` as possibly unusable; `pickInitialModel` still lands on `gpt-5.5`. Rail dots use `last_event=run.failed` even when REST status is idle.
- Runtime: no `desktop:dev` GUI this cluster (user rejected the extra Dock Electron). Overlay/install for 2.0.26 not captured.
- **HOLD**: remote term/files still not fleet-proxied. 2.0.26 not signed.

## 2026-09-20 Mac 2.0.27 adversarial cluster (iOS untouched)

- Version `2.0.27` + `LEO_RELEASE_NOTES` front entry. Local files drawer calls `POST /api/leophone/local/workspace` to reuse/register the session cwd in the projects table, then FileTree uses that real `projectId`. Fake `harness-${sessionId}` is gone.
- Session cwds under `/tmp` are allowed; `/` and `/etc` are not. New-session warns when the selected Codex id is likely rejected by a ChatGPT account.
- Runtime: helper-only `POST /api/leophone/local/workspace` `{cwd:"/tmp/leo-codex-live"}` → `projectId=a57e34cf-b52d-4e93-bdeb-45a980462b8f` (not `harness-`); second call reused the same id. No extra Electron.app. Overlay/install for 2.0.27 not captured.
- **HOLD**: remote term/files still not fleet-proxied. 2.0.27 not signed.

## 2026-09-20 Mac 2.0.28 adversarial cluster (iOS untouched)

- Version `2.0.28` + `LEO_RELEASE_NOTES` front entry. Local flow edit rows open the files drawer and read the file via the registered project id. Touched files are pinned above the tree.
- Gates: `verify:release-notes` 3/3, client 84/84 (includes `local-files` path/peek + App2 wiring).
- Runtime: helper-only `/health` `2.0.28`. `POST /api/leophone/local/workspace` `{cwd:"/tmp/leo-codex-live"}` → `projectId=a57e34cf-b52d-4e93-bdeb-45a980462b8f`. `GET /files` names `PEEK.txt`, `README.md`. `GET /file?filePath=/tmp/leo-codex-live/README.md` → `{"content":"ok\n"}`. `GET .../PEEK.txt` → `{"content":"peek-body-2.0.28\n"}`. Process was `dev-backend.app` hard-link (inode 160285571, same as Electron binary); no `Electron.app` GUI / extra Dock tile.
- **HOLD**: remote term/files still not fleet-proxied. Overlay/install for 2.0.28 not captured (no `desktop:dev` GUI). 2.0.28 not signed.

## 2026-09-20 Mac 2.0.29 adversarial cluster (iOS untouched)

- Version `2.0.29` + `LEO_RELEASE_NOTES` front entry. Running send after the first turn is `steer` (not a bare prompt). First turn stays `prompt` — spawn sets status to `running` before the opening message, so treating `running` alone as steer queued the first sentence and never started a turn.
- Thinking depth RPC sends pi's `level` field (old `thinkingLevel` is aliased). `session.thinking` is emitted from the outbound command.
- Gates: `verify:release-notes` 3/3, client 85/85, `leophone.test` 26/26.
- Runtime (helper-only, no `desktop:dev` GUI): `/health` `2.0.29`. Spark create `hs_88408dd413f714ba0bfdc512d9734750` first command `prompt` → `run.failed` ChatGPT reject. `set_model openai-codex/gpt-5.5` then send「只回一个字：好」→ `message.delta`「好」, `run.completed`. `set_thinking_level` `{level:low}` → journal `session.thinking`. Second session `hs_ac955a0d120b8a138e05764e704dfdac`: opening prompt then immediate send → `harness.response` `steer`, no `already processing`, `run.completed`.
- **HOLD**: remote term/files still not fleet-proxied. Overlay/install for 2.0.29 not captured. 2.0.29 not signed.

## 2026-09-20 Mac 2.0.30 adversarial cluster (iOS untouched)

- Version `2.0.30` + `LEO_RELEASE_NOTES` front entry. Steer `user.message` carries `mode: 'steer'`; the flow labels that row 「插话」 with a rise + side line (Reduce Motion zeroes it). Opening prompt stays 「你」 and keeps the session title.
- Runtime: helper-only `/health` `2.0.30`. Session `hs_72f1967b0eb18bad768a939795f22d08` journal: first `user.message` `mode:prompt`, second `mode:steer`. Vite-only (no Electron Dock) overlay `.ui-pipeline/leocodebox-2.0.30-whatsnew.png` shows 「本次更新」 / v2.0.30 / this version's two items / 知道了. Flow shot `.ui-pipeline/leocodebox-2.0.30-steer.png` shows 「你」 then 「插话」.
- Helper and Vite were stopped after proof. No extra Dock Electron.
- **HOLD**: remote term/files still not fleet-proxied. Signed install remains 2.0.20.

## 2026-09-20 Mac 2.0.31 adversarial cluster (iOS untouched)

- Version `2.0.31` + `LEO_RELEASE_NOTES` front entry. Workbench and fleet expose session artifacts JSON + `/text` peek. Remote files drawer can click a touched file and read body via relay; the full remote tree still does not open. `continueSessionDraft` drops ChatGPT-rejected models. `last_event` carries `mode`; rail last line writes 「插话」.
- Gates: `verify:release-notes` 3/3, client 88/88, `test:server` 484/484.
- Runtime (helper-only, no `desktop:dev` GUI): create `hs_9526869b5e705465a4158e9f5b62a60e` write `ART31.txt` (approved once) → idle. `GET /api/leophone/local/sessions/.../artifacts` lists `ART31.txt`. `GET .../artifacts/ART31.txt/text` → `2.0.31-ok`. Summary `last_event` for the opening prompt includes `mode:prompt`. Vite-only overlay `.ui-pipeline/leocodebox-2.0.31-whatsnew.png` shows v2.0.31 notes. Files peek `.ui-pipeline/leocodebox-2.0.31-files.png` shows `ART31.txt` + `2.0.31-ok`.
- Fleet artifact proxy is in source (`fleetArtifactRelayPath` → `/m/.../artifacts` + `/text`). No second machine, so live remote peek is still unproven.
- **HOLD**: remote terminal not fleet-proxied. Live remote file peek unproven. Signed install remains 2.0.20.

## 2026-09-20 Mac 2.0.32 adversarial cluster (iOS untouched)

- Version `2.0.32` + `LEO_RELEASE_NOTES` front entry. Opening the local terminal drawer also calls `ensureWorkspace` for the session cwd. Shell mounts the registered project, not a blank `projectId`. If the directory cannot be registered, the drawer says so.
- Gates: `verify:release-notes` 3/3, client 88/88.
- Runtime: Vite-only (no Electron Dock) overlay `.ui-pipeline/leocodebox-2.0.32-whatsnew.png` shows v2.0.32 notes. Cmd-T opened `终端 ·` with `.xterm` present and no empty-project error. Shot `.ui-pipeline/leocodebox-2.0.32-term.png`. Helper `/health` still `2.0.31` because the helper process was not restarted (client-only cluster).
- **HOLD**: remote terminal not fleet-proxied. Live remote file peek unproven. Signed install remains 2.0.20.

## 2026-09-20 Mac 2.0.33 adversarial cluster (iOS untouched)

- Version `2.0.33` + `LEO_RELEASE_NOTES` front entry. Fleet GET session summary: try `/m/.../sessions/:id`, 404 then fill from fleet snapshot (Python leoagent has list/events/send/stop/approval only — no single GET, no artifacts, no PTY). Artifact `/text` falls back to binary when remote is old leocodebox; current leoagent still 404s artifacts.
- Gates: release-notes 3/3, client 88/88, leophone 29/29.
- Runtime (helper-only): `/health` `2.0.33`. Fleet online: LeodeMac-mini-2, LeoMac-Studio-2, this Mac. `POST /fleet/sessions` claude on mini → `hs_1e67ac54…` running cwd `/Users/leo`. GET summary 200 via snapshot. GET artifacts 404 (honest). POST stop → cancelled, GET summary 200 cancelled. pi create 400. Vite overlay `.ui-pipeline/leocodebox-2.0.33-whatsnew.png`.
- Remote PTY: leoagent + relay have no shell/PTY route. Signed rebuild skipped (would pull Dock Electron).
- **HOLD**: remote terminal still no PTY. Remote file *content* still unreadable until remote ships artifacts. Signed install remains 2.0.20.

## 2026-09-20 Mac 2.0.34 adversarial cluster (iOS untouched)

- Version `2.0.34` + `LEO_RELEASE_NOTES` front entry. `humanizeError('relay 404')` → 「对面这台还没有文件产物接口…」 so the remote files drawer does not dump a raw status.
- Gates: release-notes 3/3, model tests 22/22.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.34-whatsnew.png` shows v2.0.34. Header shows 「远程 2 台在线」. No extra Dock Electron; helper remains `dev-backend.app`.
- **HOLD**: remote terminal still no PTY. Remote file content still 404 on current leoagent. Signed install remains 2.0.20.

## 2026-09-20 Mac 2.0.35 adversarial cluster (iOS untouched)

- Version `2.0.35` + `LEO_RELEASE_NOTES` front entry. Ended sessions no longer reconnect the event stream or label 「重连中」. Clicking a touched file always opens the files drawer (local and remote).
- Gates: `verify:release-notes` 3/3, client 88/88.
- Runtime: Vite-only (no Electron Dock). Overlay `.ui-pipeline/leocodebox-2.0.35-whatsnew.png` shows v2.0.35 / 不再写「重连中」 / 文件抽屉看正文. ART31 orphaned header is 「已停止」 with `hasReconnect:false`. Click `ART31.txt 已改` opens `文件 ·` peek `2.0.31-ok` (`.ui-pipeline/leocodebox-2.0.35-files.png`).
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.36 adversarial cluster (iOS untouched)

- Version `2.0.36` + `LEO_RELEASE_NOTES` front entry. `send()` and the composer banner share `sessionFailTexts` (last_event + sys rows). Enter is gated by `needsModelSwitch`; blocked send toasts 「先换一个模型再发」.
- Gates: `verify:release-notes` 3/3, client 88/88.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.36-whatsnew.png` shows v2.0.36 / 回车也不会再发出去. No extra Dock Electron.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.37 adversarial cluster (iOS untouched)

- Version `2.0.37` + `LEO_RELEASE_NOTES` front entry. `rankModelsForPicker` sinks ChatGPT-rejected spark / GPT-5.4. New session, ⌘K, and in-session picker share the ranked `configuredModels`.
- Gates: `verify:release-notes` 3/3, client 88/88.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.37-whatsnew.png`. New-session model select: selected `openai-codex/gpt-5.5`; options start GPT-5.5 / 5.6 / 6 Astra, spark / 5.4 / 5.4 mini last with 「可能用不了」. Shot `.ui-pipeline/leocodebox-2.0.37-models.png`.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.38 adversarial cluster (iOS untouched)

- Version `2.0.38` + `LEO_RELEASE_NOTES` front entry. Ended sessions get a composer textarea. Enter (not Shift) calls `continueHere` with the draft.
- Gates: `verify:release-notes` 3/3, client 88/88.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.38-whatsnew.png`. Typed 「接着改 ART31，只追一行 2.0.38-ok」 + Enter → newbox prompt + cwd `/tmp/leo-codex-live` + model gpt-5.5. Shot `.ui-pipeline/leocodebox-2.0.38-continue.png`.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.39 adversarial cluster (iOS untouched)

- Version `2.0.39` + `LEO_RELEASE_NOTES` front entry. File peek shows `peekFileCaption` above the body (basename only).
- Gates: `verify:release-notes` 3/3, client 89/89.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.39-whatsnew.png`. Click ART31 → caption `ART31.txt` + body `2.0.31-ok`. Shot `.ui-pipeline/leocodebox-2.0.39-files.png`.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.40 adversarial cluster (iOS untouched)

- Version `2.0.40` + `LEO_RELEASE_NOTES` front entry. File peek head has 「复制正文」; toast 「已复制正文」.
- Gates: `verify:release-notes` 3/3, client 89/89.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.40-whatsnew.png`. Peek shows ART31.txt + 复制正文 + `2.0.31-ok`. Click copy → toast `已复制正文`. Shot `.ui-pipeline/leocodebox-2.0.40-files.png`. No extra Dock Electron.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.41 adversarial cluster (iOS untouched)

- Version `2.0.41` + `LEO_RELEASE_NOTES` front entry. Settings default-model `<select>` uses `rankModelsForPicker` (same sink as new session).
- Gates: `verify:release-notes` 3/3, client 89/89.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.41-whatsnew.png`. Settings options: GPT-5.5 first after the remembered placeholder; spark / 5.4 / 5.4 mini last. Shot `.ui-pipeline/leocodebox-2.0.41-settings.png`.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.42 adversarial cluster (iOS untouched)

- Version `2.0.42` + `LEO_RELEASE_NOTES` front entry. `hiddenHistoryHint` under 「全部」: open history row is not double-counted. Click switches to 历史.
- Gates: `verify:release-notes` 3/3, client 89/89.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.42-whatsnew.png`. Hint 「还有 22 条历史」. Click → 历史23 on, 23 `.srow`. Shot `.ui-pipeline/leocodebox-2.0.42-rail.png`.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.43 adversarial cluster (iOS untouched)

- Version `2.0.43` + `LEO_RELEASE_NOTES` front entry. ⌘D / 「本次改动」shows file pins + peek, not tool stdout. Auto-focus first edit file.
- Gates: `verify:release-notes` 3/3, client 90/90.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.43-whatsnew.png` shows v2.0.43 / 「本次改动」打开文件正文. ⋯ → 本次改动 → drawer `ART31.txt` + `复制正文` + `2.0.31-ok`, no `hello from live gpt-5.5` dump. Shot `.ui-pipeline/leocodebox-2.0.43-diff.png`.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.44 adversarial cluster (iOS untouched)

- Version `2.0.44` + `LEO_RELEASE_NOTES` front entry. `.newbox` uses `leo2-rise` 280ms. Opening the box `scrollTo` rail top.
- Gates: `verify:release-notes` 3/3, client 91/91.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.44-whatsnew.png` shows v2.0.44 / 面板会抬上来. Click `+ 新会话` → `.newbox` `animationName:leo2-rise` `0.28s`, `scrollTop:0`, labels 机器/审批/模型/目录/第一句话. Shot `.ui-pipeline/leocodebox-2.0.44-newbox.png`.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.45 adversarial cluster (iOS untouched)

- Version `2.0.45` + `LEO_RELEASE_NOTES` front entry. `composerShouldFocus` after overlay/drawer/newbox close. Ended composer also uses `taRef`. Live composer gets `leo2-rise`.
- Gates: `verify:release-notes` 3/3, client 92/92.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.45-whatsnew.png` shows v2.0.45 / 点开一条会话就能写. After 知道了, `activeElement` is ended composer textarea. Switch session stays on textarea. `.composer` `leo2-rise` `0.2s`. Shot `.ui-pipeline/leocodebox-2.0.45-composer.png`.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.46 adversarial cluster (iOS untouched)

- Version `2.0.46` + `LEO_RELEASE_NOTES` front entry. Files drawer uses the same first-pin auto-peek as 「本次改动」 (`isPeekDrawer` + `mergeFilePins`).
- Gates: `verify:release-notes` 3/3, client 92/92.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.46-whatsnew.png` shows v2.0.46 / 打开文件抽屉就先看到. ⋯ → 文件 (no filename click) → `ART31.txt` + `复制正文` + `2.0.31-ok`. Shot `.ui-pipeline/leocodebox-2.0.46-files.png`.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.47 adversarial cluster (iOS untouched)

- Version `2.0.47` + `LEO_RELEASE_NOTES` front entry. Session header chip `cwdChipLabel` + ⋯「复制目录」. Titlebar stays display-only (Electron BrowserView).
- Gates: `verify:release-notes` 3/3, client 93/93.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.47-whatsnew.png` shows v2.0.47 / 顶栏能看见这条会话的目录. ART31 chips include `leo-codex-live` title `/tmp/leo-codex-live`. Click → toast `已复制路径`. Shot `.ui-pipeline/leocodebox-2.0.47-cwd.png`.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.48 adversarial cluster (iOS untouched)

- Version `2.0.48` + `LEO_RELEASE_NOTES` front entry. ⋯ menu 「复制标题」 copies `sessionView.title` / summary title.
- Gates: `verify:release-notes` 3/3, client 93/93.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.48-whatsnew.png` shows v2.0.48 / 复制会话标题. ⋯ → 复制标题 → toast `已复制标题`. Shot `.ui-pipeline/leocodebox-2.0.48-title.png`.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.49 adversarial cluster (iOS untouched)

- Version `2.0.49` + `LEO_RELEASE_NOTES` front entry. ⌘K commands 「复制标题」 / 「复制目录」 share `copyTitle` / `copyCwd`.
- Gates: `verify:release-notes` 3/3, client 93/93.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.49-whatsnew.png` shows v2.0.49 / ⌘K 也能复制. Palette lists both copy commands; click 复制标题 → toast `已复制标题`. Shot `.ui-pipeline/leocodebox-2.0.49-palette.png`.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.50 adversarial cluster (iOS untouched)

- Version `2.0.50` + `LEO_RELEASE_NOTES` front entry. `composerPlaceholder(cwdChipLabel(cwd), ended)`. `.empty-main` uses `leo2-rise`.
- Gates: `verify:release-notes` 3/3, client 94/94.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.50-whatsnew.png` shows v2.0.50 / 输入框会写出这条会话的目录名. ART31 ended composer placeholder `下一句会带到 leo-codex-live 的新会话…`. Shot `.ui-pipeline/leocodebox-2.0.50-composer.png`.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.51 adversarial cluster (iOS untouched)

- Version `2.0.51` + `LEO_RELEASE_NOTES` front entry. Session header uses unused `.shead-t` + `h1` so the title sits next to status, not only in the display-only titlebar.
- Gates: `verify:release-notes` 3/3, client 94/94.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.51-whatsnew.png` shows v2.0.51 / 会话顶栏写出标题. ART31 `.shead h1` = full prompt, `.shead-state` = 已停止. Shot `.ui-pipeline/leocodebox-2.0.51-shead.png`.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.52 adversarial cluster (iOS untouched)

- Version `2.0.52` + `LEO_RELEASE_NOTES` front entry. Session `.shead h1` is a button: click / Enter / Space calls `copyTitle`.
- Gates: `verify:release-notes` 3/3, client 94/94.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.52-whatsnew.png` shows v2.0.52 / 点会话顶栏标题就能复制全文. Click ART31 h1 → toast `已复制标题`, title hint includes 「点一下复制」. Shot `.ui-pipeline/leocodebox-2.0.52-title.png`.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.53 adversarial cluster (iOS untouched)

- Version `2.0.53` + `LEO_RELEASE_NOTES` front entry. ⌘F / ⋯ / ⌘K open an in-session find strip. Non-matching flow rows get `.frow-miss`. Esc closes find before other layers. Composer does not steal focus while find is open.
- Gates: `verify:release-notes` 3/3, client 95/95.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.53-whatsnew.png` shows v2.0.53 / ⌘F 在这条会话的流水里找. ART31 ⌘F `ART31` → `3 条`, 2 `.frow-miss` (窗口绑定 / 已停止), `.flow-find` `leo2-rise` `0.2s`. Shot `.ui-pipeline/leocodebox-2.0.53-find.png`.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.54 adversarial cluster (iOS untouched)

- Version `2.0.54` + `LEO_RELEASE_NOTES` front entry. ⌘G / Shift+⌘G / Enter cycle find hits. Current row `.frow-hit` + `scrollIntoView`. Status `n / total`.
- Gates: `verify:release-notes` 3/3, client 96/96.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.54-whatsnew.png` shows v2.0.54 / ⌘G 跳到下一条查找. ART31 `ART31` → `1 / 3` user, ⌘G `2 / 3` 写入 ART31.txt, ⌘G `3 / 3` 已批准, Shift+⌘G back to `2 / 3`. Shot `.ui-pipeline/leocodebox-2.0.54-find.png`.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.55 adversarial cluster (iOS untouched)

- Version `2.0.55` + `LEO_RELEASE_NOTES` front entry. Titlebar home copy is `主控` + machine · cwd chip, not the full session prompt. Click-to-copy stays on `.shead h1`.
- Gates: `verify:release-notes` 3/3, client 97/97.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.55-whatsnew.png` shows v2.0.55 / 窗口顶条不再把整段会话标题再写一遍. Titlebar `主控` + `LeoyuandeMacBook-Pro-2.local · leo-codex-live`; shead h1 still the ART31 prompt (23px ellipsis). Click h1 → toast `已复制标题`. Shot `.ui-pipeline/leocodebox-2.0.55-titlebar.png`.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.56 adversarial cluster (iOS untouched)

- Version `2.0.56` + `LEO_RELEASE_NOTES` front entry. `machineChipLabel` strips `.local` for titlebar + rail group. Full name stays on `title`. Session chips stay one row (`shead` 62px).
- Gates: `verify:release-notes` 3/3, client 97/97.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.56-whatsnew.png` shows v2.0.56 / 机器名不再拖着 .local. Titlebar `主控` + `LeoyuandeMacBook-Pro-2 · leo-codex-live`; rail group `LeoyuandeMacBook-Pro-2` with title `.local`. Shot `.ui-pipeline/leocodebox-2.0.56-names.png`.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.57 adversarial cluster (iOS untouched)

- Version `2.0.57` + `LEO_RELEASE_NOTES` front entry. Composer / need-strip / drawer header / remote drawer copy use `machineChipLabel`.
- Gates: `verify:release-notes` 3/3, client 97/97.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.57-whatsnew.png` shows v2.0.57 / 输入框、抽屉和「需要你」条上的机器名也去掉 .local. ⌘E files drawer header `文件 · LeoyuandeMacBook-Pro-2` (no `.local`). Shot `.ui-pipeline/leocodebox-2.0.57-drawer.png`.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.58 adversarial cluster (iOS untouched)

- Version `2.0.58` + `LEO_RELEASE_NOTES` front entry. Closed `.drawer` is `visibility:hidden; pointer-events:none` (delayed until the slide finishes). Open restores both.
- Gates: `verify:release-notes` 3/3, client 97/97.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.58-whatsnew.png` shows v2.0.58 / 关掉的抽屉不再露一条. Closed drawer `hidden/none` at x=1291; ⌘E `visible/auto` header `文件 · LeoyuandeMacBook-Pro-2`; Esc back to `hidden/none`. Shot `.ui-pipeline/leocodebox-2.0.58-drawer.png` has no bottom 终端 bar.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.59 adversarial cluster (iOS untouched)

- Version `2.0.59` + `LEO_RELEASE_NOTES` front entry. `highlightQueryParts` paints `mark.find-hit` in flow text / files / sys. Ended composer is one row (`endedComposerLead` + cwd chip + actions), no 「目录还在」 paragraph.
- Gates: `verify:release-notes` 3/3, client 98/98.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.59-whatsnew.png` shows v2.0.59 / 查找命中标在正文上. ART31 ⌘F → 3 `mark.find-hit` = `ART31`, `1 / 3`. Ended hint `这是上次留下的记录,进程已不在 · leo-codex-live`, `.composer-end` row 30px, box 91px, pad `8px 12px`. Shot `.ui-pipeline/leocodebox-2.0.59-find.png`.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.60 adversarial cluster (iOS untouched)

- Version `2.0.60` + `LEO_RELEASE_NOTES` front entry. Changing `active` session resets flow find so the previous query does not dim the next transcript.
- Gates: `verify:release-notes` 3/3, client 99/99.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.60-whatsnew.png` shows v2.0.60 / 换一条会话会收起查找. ART31 ⌘F had 3 marks; switch to history row 「从 1 慢慢数到 30」 → find closed, 0 marks. Shot `.ui-pipeline/leocodebox-2.0.60-switch.png`.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.61 adversarial cluster (iOS untouched)

- Version `2.0.61` + `LEO_RELEASE_NOTES` front entry. Find-open ⌘C / strip 「复制」 / ⌘K copies `flowFindHitText` of the current hit. Input selection still uses native copy.
- Gates: `verify:release-notes` 3/3, client 100/100.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.61-whatsnew.png` shows v2.0.61 / ⌘C 复制当前命中整段. ⌘F `30` → `1 / 1` + 1 mark; click 复制 → toast `已复制命中`. Shot `.ui-pipeline/leocodebox-2.0.61-copy.png`.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.62 adversarial cluster (iOS untouched)

- Version `2.0.62` + `LEO_RELEASE_NOTES` front entry. Find strip acts are 上 / 下 / 复制 / 关. Arrow keys in the find field step hits instead of switching the rail.
- Gates: `verify:release-notes` 3/3, client 101/101.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.62-whatsnew.png` shows v2.0.62 / 查找条收成「上 / 下 / 复制 / 关」. ⌘F `一` → `1 / 3` then ArrowDown → `2 / 3`, same session title, acts `上 下 复制 关`. Shot `.ui-pipeline/leocodebox-2.0.62-find.png`.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.63 adversarial cluster (iOS untouched)

- Version `2.0.63` + `LEO_RELEASE_NOTES` front entry. While find is open, ArrowUp/Down always step hits, even after clicking 下 (focus on BUTTON).
- Gates: `verify:release-notes` 3/3, client 102/102.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.63-whatsnew.png` shows v2.0.63 / 查找开着时 ↑↓ 一律跳命中. After 下 then ArrowDown, hits wrap `3 / 3` → `1 / 3`, same session title. Shot `.ui-pipeline/leocodebox-2.0.63-arrows.png`.
- **HOLD**: remote PTY, remote file content on leoagent, signed 2.0.20.

## 2026-09-20 Mac 2.0.65 signed ship (iOS untouched)

- Version `2.0.65` + `LEO_RELEASE_NOTES` front entry. Overlay states the real jump from the installed 2.0.20: live models, local files/steer/continue, remote send/stop without pretending PTY/files exist.
- Gates: `verify:release-notes` 3/3, client 103/103.
- Signed: `LEOCODEBOX_SIGN_IDENTITY` Developer ID `leo yuan (48H5Y3LNUK)` → `release/desktop/leocodebox-2.0.65-mac-arm64.dmg`. Notary `Accepted` twice (bb2af8b0…, 1257ada2…), stapled, Gatekeeper `accepted` / Notarized Developer ID. No `desktop:dev`, no extra Dock Electron.
- Installed `/Applications/leocodebox.app` `CFBundleShortVersionString` **2.0.65**. Packaged `/health` `installMode:"bundled"` `version:"2.0.65"`.
- First-launch overlay `.ui-pipeline/leocodebox-2.0.65-install.png` shows 「本次更新」 v2.0.65 and the three ship items. Vite overlay `.ui-pipeline/leocodebox-2.0.65-whatsnew.png`.
- **HOLD**: remote PTY still missing on leoagent. Remote file body still 404 on current leoagent. Goal stays open.

## 2026-09-20 Mac 2.0.66 window raise (iOS untouched)

- Version `2.0.66` + `LEO_RELEASE_NOTES` front entry. Local bound-window chip calls `POST /leophone/local/sessions/:id/window/raise` (`raiseBoundSessionWindow` re-resolves pid/windowId then focus). Remote chips stay labels.
- Gates: `verify:release-notes` 3/3, client 103/103, exact-window native+routes 12/12.
- Runtime: Vite-only overlay `.ui-pipeline/leocodebox-2.0.66-whatsnew.png` shows v2.0.66 / 点芯片提到前面. Session chip is a `BUTTON` titled `ChatGPT · 点一下提到前面`. No `desktop:dev`. `/Applications` remains notarized 2.0.65 until the next signed ship.
- **HOLD**: remote PTY, remote file body on leoagent. Signed Applications still 2.0.65.
