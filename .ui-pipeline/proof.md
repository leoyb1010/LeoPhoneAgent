# UI Proof

## Verification scope

- Release level: Phase 4 source delivery；不发布 APK/IPA/Mac 包。
- Screens: Android Treasury 单/双/三栏、Share destination、处理/阅读筛选、详情/定位高亮/批注/重试；iPad drop；Artifact Tray save；Mac 捕获、搜索、阅读、高亮、同步范围、离线合集、按需正文/附件与 Agent 引用工作台。
- Required viewports: Fold8 1080×1728 cover、1768×2208 expanded、200% font；当前无 AVD，视觉状态为 HOLD。

## Automated evidence

- Android Standard/Power: Kotlin compile、instrumentation 测试源码 compile、完整 JVM tests、lint 均通过；lint 0 error；无设备，因此 instrumentation 未执行。
- Android contract tests: Room 11→12、精确查询/特殊字符标签、阅读状态/进度、高亮事务、Agent 授权/注入和 PDF 任务边界。
- iOS: MinisLogicTests 304/304；毫秒冲突用例连续 3 次通过；MinisShare direct target simulator build succeeded。
- iOS main app: HOLD；`LeoPhoneAgent` scheme 包含嵌入式 Apple Watch App，本机未安装 watchOS 26.5，`xcodebuild` 以 exit 70 在编译前终止。
- Relay: 12/12 安全与协议测试通过，覆盖幂等、乱序、重启、旧 500 快照、按需资产和 MIME/digest 拒绝。
- Mac: typecheck passed；client 160/160；server 392/392；production build passed。

## Rendered/interaction evidence

- Android emulator screenshots: HOLD，无可用 AVD，未伪造 Fold8/200%/TalkBack 证据。
- iPhone/iPad screenshots: HOLD，主 App 未越过仓库现有 LeoWatch build blocker。
- Mac browser walkthrough: 宽/窄布局、本机捕获、智能视图、搜索、详情、阅读、高亮、引用和同步范围控件真实渲染通过；真实 Electron 双机 Relay、键盘全流程和屏幕阅读器仍 HOLD。

## Code-level accessibility evidence

- Android 交互均使用 Button/IconButton/Checkbox/FilterChip/可点击 Row；图标动作有 content description。
- 非交互状态从 AssistChip 改为 Surface 标签，避免假按钮。
- 详情附件通过受限 FileProvider 只读 grant 打开。
- 查询、筛选、选择、详情 ID、批注草稿使用 rememberSaveable；LazyListState 保持滚动状态。
- Android 列表和 Agent 搜索使用轻量 SQL/FTS 投影，不加载完整正文；Mac 列表投影排除正文与文件引用。
- Mac textarea、搜索、同步 select 和捕获 group 有 label/aria-label；保存区暴露 aria-busy；手机离线和离线缓存结果使用 role=status。
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
