# UI Proof

## Verification scope

- Release level: Android `1.0.0-alpha.21` Standard + Power Release APK; iOS/iPad `1.29.0 (103)` source delivery.
- Routes / screens: Fold8 onboarding/chat workspace, update dialog, compact top bar, system-permission settings, mounted folders, artifact cards.
- Viewports / devices: Fold8 API 35 emulator at 1768×2208 expanded and 1080×1728 cover; cover repeated at 200% system font.
- iOS form factors: content-driven iPhone/iPad single/split policy, iPad multitasking and resizable-window thresholds; generic iOS device build.

## Evidence

- Screenshots / visual diffs: expanded two-pane, cover single-pane, alpha.21 update dialog, and cover 200% font captured from the final source. The first 200% capture exposed a top-bar/status-bar collision; the post-fix capture separates them while preserving full body scaling.
- Storybook stories and tests: N/A (native Compose/SwiftUI). Android Standard/Power each passed 581 JVM tests with one device-conditional skip. iOS layout/action/MIME contracts compile in the device test target; simulator execution remains unavailable because the checked-in iSH static library is device-only.
- End-to-end interactions: published alpha.20 Standard/Power were installed first, then the final alpha.21 APKs covered both with `Success`. Both packages passed cold launch and Android `ASSIST` entry with live PIDs.
- Accessibility checks: 1080×1728 at 200% font produced zero UIAutomator nodes outside the viewport. Compact navigation chrome is capped at 130%, while page content, cards and composer continue to follow the full system scale. Reduce Motion disables bouncing, shimmer, browser breathing/spinners and transcription-ring motion.
- Permission truthfulness: final Standard APK contains none of MANAGE_EXTERNAL_STORAGE, QUERY_ALL_PACKAGES, Shizuku provider/permission/metadata, or the Accessibility service. Power contains them behind its existing product and OS gates. Standard UI no longer links to impossible Power-only grants.
- Console / runtime checks: final APK verification fixed the signer fingerprint, package IDs, versionCode and versionName. Logcat after both cold/assistant launches contained zero app `FATAL EXCEPTION` entries.
- Performance checks: final emulator cold starts were Standard 584 ms and Power 322 ms; assistant entry was Standard 660 ms and Power 242 ms on the same Fold8 API 35 AVD.
- iOS/iPad checks: Xcode 26.6 with iPhoneOS 26.5 SDK completed `generic/platform=iOS` build. Split mode requires regular width, at least 480 pt height, 300 pt sidebar and 440 pt detail, so Stage Manager/split-view resizing does not rely on device-name detection.

## Originality gate

Use for net-new or overhauled work. Maintenance inside an established system may mark this `N/A`.

| Axis | Score (0-2) | Rendered evidence |
|---|---:|---|
| Product specificity | 2 | 本机 Agent、Power 能力和真实执行回执保持同一产品语义 |
| Hierarchy | 2 | 展开态工作区/对话双栏，封面态单栏，更新说明与主动作层级清楚 |
| Composition | 2 | Fold8 两尺寸与 200% 字体均无 UI 树越界 |
| Material and assets | 1 | 延续原生 Material 3 / SwiftUI，无新图片和依赖负担 |
| Typography and color | 2 | 只限制紧凑顶栏的极端缩放，正文与状态语义保持可访问 |
| Interaction and motion | 2 | 减少动态效果有真实静态替代，不靠动画传达唯一状态 |
| Feasibility | 2 | 双 APK 覆盖、冷启动、ASSIST、签名、lint 与设备构建均有证据 |
| **Total** | **13/14** | 通过 11/14 门槛，无零分 |

- Threshold: 11/14, no zero, product specificity = 2, hierarchy = 2.
- Category-interchangeable regions still visible: 设置项与系统授权说明继续使用项目既有 Material 列表外壳。
- Direction correction required, if any: 无；200% 顶栏碰撞已在本轮截图反馈环中修正。

## Snapshot decisions

- Intentional baseline changes: Standard/Power 能力入口按真实 Manifest 分开；本机动作显示执行回执；更多产物格式复用已有预览器；iPad/Fold8 按实际内容空间自适应。
- Rejected changes: 用媒体播放类型伪装 Agent 前台任务；在 compileSdk 36 / AGP 8.13 上强接要求 SDK 37 / AGP 9.1 的 AppFunctions；为视觉升级引入新 UI 框架。

## Remaining risk

- Known issues: Android lint 仍报告仓库既有警告，但 Standard/Power Release 均为 0 error。iOS 仍有既有 Swift 6 隔离和 Objective-C nullability 警告，不是本轮新增。
- Deferred work: iOS 27 专属 API 等 Xcode 27 SDK 后再接入；本次不伪造不可编译声明。真实 Fold8 与 iPad 装机由用户继续做硬件终验。
- Visual verification outstanding: iOS/iPad 本轮没有可运行模拟器截图，因为当前 iSH 静态库仅含 device slice；已用通用真机构建和纯布局契约覆盖代码门。
