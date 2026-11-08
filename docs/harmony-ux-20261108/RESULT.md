> 最新交付状态：0.5.0 / 100029 已在 Mate XT2 覆盖安装并回读确认；用户接手后续测试。构建、安装包 SHA256 与证据边界见 [DELIVERY.md](DELIVERY.md)。以下保留分阶段历史记录。

# Harmony UX · Air 实施记录

日期：2026-11-08。主机：LeoyuanAir.local。项目根：`/Users/admin/Dev/harmony-ux-20261108/leobot`。

仅当前独立快照；初始分支 master、工作树干净、无 remote。不访问主仓/其他项目，不执行方案内历史路径或建仓命令，不推送、不启动模拟器、不连接其他机器、不改签名。

> 勾选仅表示源码工作包已实施，不等于完整验收。Studio checkpoint1 的中间快照真实编译失败；共享根因已修，冻结源码须重编译。

## 清单

- [x] L0 源码：主题组件、语义颜色、UI 门禁
- [x] L1 源码：原生 Navigation、sm/md/lg、状态保留、本机右栏
- [x] L2 源码：聊天菜单、分享、滚动、搜索/滑动撤销、触感、骨架、阅读
- [x] L3 源码：系统符号、设置常用卡片与分类跳转
- [x] L4 准备：0.5.0（100029）、三处同步、Studio 指南
- [ ] Studio ArkTS 构建、模拟器渲染与交互（Air 不执行）
- [ ] 最终实机升级、性能与真实账号（未执行，未发布）

## 实际源码基线

### 裸 Button：35

- pages/TerminalPage.ets: 7
- pages/BrainSpacePage.ets: 7
- panes/ChatPane.ets: 6
- chat/Composer.ets: 4
- pages/WorkspacePage.ets: 1
- pages/SoulPage.ets: 1
- pages/SkillsPage.ets: 1
- pages/SchedulePage.ets: 1
- pages/RelayPage.ets: 1
- pages/MemoryPage.ets: 1
- pages/EnvPage.ets: 1
- pages/CollectionsPage.ets: 1
- pages/BodyPage.ets: 1
- pages/AppearancePage.ets: 1
- local/OAuthLoginSheet.ets: 1

### hex 字面量：88

- panes/SettingsPane.ets: 27
- panes/LocalAgentPane.ets: 11
- pages/AppearancePage.ets: 10
- local/ProviderCatalog.ets: 8
- panes/FleetPane.ets: 7
- chat/Composer.ets: 6
- panes/ChatPane.ets: 3
- panes/LocalChatPane.ets: 2
- local/MailTools.ets: 2
- pages/SoulPage.ets: 1
- pages/SkillsPage.ets: 1
- pages/SchedulePage.ets: 1
- pages/RelayPage.ets: 1
- pages/ProviderDetailPage.ets: 1
- pages/ModelGroupsPage.ets: 1
- pages/MemoryPage.ets: 1
- pages/EnvPage.ets: 1
- pages/CollectionsPage.ets: 1
- pages/BodyPage.ets: 1
- pages/AddProviderPage.ets: 1
- local/OAuthLoginSheet.ets: 1

### router.pushUrl：27

- panes/LocalAgentPane.ets: 7
- pages/HomePage.ets: 4
- pages/ProviderListPage.ets: 3
- pages/RuntimePage.ets: 2
- pages/BrainSpacePage.ets: 2
- panes/SettingsPane.ets: 1
- panes/LocalChatPane.ets: 1
- panes/ChatPane.ets: 1
- pages/SystemIntegrationPage.ets: 1
- pages/RemoteWorkspacePage.ets: 1
- pages/McpPage.ets: 1
- pages/FleetPage.ets: 1
- local/InAppBrowser.ets: 1
- local/DocumentScanFlow.ets: 1

## 证据边界

`/Applications/DevEco-Studio.app/Contents` 不存在；使用本机 Node 执行可运行测试。源码匹配门禁仅是静态证据，不能当 ArkTS 编译、渲染、手势或实机证据。没有生成任何模拟截图。

## iOS 参照

同快照 src/ios/Views/Chat 的 ChatInspector、LongImageShareView、ChatTurnScreenshot、LongTextCollapse、LongTextReader；Settings/SettingsHomeView 与 AppearanceSettingsView。保留鸿蒙原生媒介：暖白/石墨分层、青绿主操作，44vp 触点，减少动态，不仿网页或导入新依赖。

## L0 · 源码实施

已迁移 35 个原生裸 Button 至主题操作/图标/富内容按钮；补齐 NavHeader/ListRow/FormField/SectionCard/EmptyState/Skeleton，NavBar 与设置行复用；中继密码表单保留原安全校验。颜色按正文、次级、强调、警告、危险、遮罩/阴影语义收敛；品牌目录与外发邮件 HTML 为明确例外。UI 静态门禁接入 build_hap 链首。

测试：`node src/harmony/scripts/check_ui_tokens.mjs` exit 0；`node --test src/harmony/protocol/ui-tokens.test.mjs` exit 0。首次全套协议测试 exit 1：linux-runtime.test.mjs 的假计时器队列期望 [5]、实得 [2,5]；protocol.test.mjs 引用了快照未包含的 Android Kotlin 文件而 ENOENT。未放宽/跳过/改写原测试，后续单独核查。本机 Node v26.11.1；无 DevEco SDK，未构建/截图。

此包 diff --stat（当时，未跟踪新增文件不计入 git diff）：
```
 .../app/entry/src/main/ets/chat/Composer.ets       |  22 ++--
 .../entry/src/main/ets/local/OAuthLoginSheet.ets   |  10 +-
 .../entry/src/main/ets/pages/AddProviderPage.ets   |   2 +-
 .../entry/src/main/ets/pages/AppearancePage.ets    |  23 ++--
 .../app/entry/src/main/ets/pages/BodyPage.ets      |  10 +-
 .../entry/src/main/ets/pages/BrainSpacePage.ets    |  22 ++--
 .../entry/src/main/ets/pages/CollectionsPage.ets   |  14 ++-
 .../app/entry/src/main/ets/pages/EnvPage.ets       |  10 +-
 .../app/entry/src/main/ets/pages/MemoryPage.ets    |  14 ++-
 .../entry/src/main/ets/pages/ModelGroupsPage.ets   |   2 +-
 .../src/main/ets/pages/ProviderDetailPage.ets      |   2 +-
 .../app/entry/src/main/ets/pages/RelayPage.ets     |  28 ++---
 .../app/entry/src/main/ets/pages/SchedulePage.ets  |  10 +-
 .../app/entry/src/main/ets/pages/SkillsPage.ets    |  14 ++-
 .../app/entry/src/main/ets/pages/SoulPage.ets      |  14 ++-
 .../app/entry/src/main/ets/pages/TerminalPage.ets  |  15 +--
 .../app/entry/src/main/ets/pages/WorkspacePage.ets |   4 +-
 .../app/entry/src/main/ets/panes/ChatPane.ets      |  18 ++--
 .../app/entry/src/main/ets/panes/FleetPane.ets     |  12 +--
 .../entry/src/main/ets/panes/LocalAgentPane.ets    |  13 ++-
 .../app/entry/src/main/ets/panes/LocalChatPane.ets |   4 +-
 .../app/entry/src/main/ets/panes/SettingsPane.ets  |  54 +++++-----
 .../app/entry/src/main/ets/theme/Controls.ets      | 118 +++++++++++++++++++++
 .../app/entry/src/main/ets/theme/Tokens.ets        |   8 ++
 .../app/entry/src/main/ets/theme/Widgets.ets       |  78 +-------------
 src/harmony/scripts/build_hap.sh                   |   1 +
 26 files changed, 275 insertions(+), 247 deletions(-)

```

## L1 · 源码实施

导航关系：Home → 本机对话、远程机器、设置；设置 → 供应商/模型组/审批/技能/人格/记忆/邮箱/环境变量/MCP/录音/定时/外观/集成/运行时/终端/工作区/第二大脑/收藏/同步/备份/用量/更新；供应商 → 添加 → 详情；第二大脑 → 收藏/Web；运行时 → 集成/终端；远程对话 → 远程工作区 → 看屏；扫码流程 → DocumentScan。27 处 push 与 replace/back/getParams 迁移至 Home 持有的 NavPathStack，36 个二级页使用 NavDestination。Startup/Recovery 保留根页面。页面 onShown/onHidden 转发原生命周期，第二大脑锁定、浏览器解绑未删除。

宽度来自 EntryAbility 的 windowRect，sm <600 / md <840 / lg >=840；350ms 防抖、1500ms 手动保护、同档不推翻手动开关。本机列表/对话保留相同组件位置，选择/草稿/阅读位置仍由原 store 持有。右栏读取现有工作区与工具结果，审批只显示 UI 回执，不产生授权；无记录时明确说明。

官方 API 核实：OpenHarmony docs master 的 Navigation/NavDestination、TextInput 文档（2026-11-08 获取）；本机无 SDK，仍需 Studio 核实目标 SDK。

`node --test .../harmony-ux.test.mjs .../ui-tokens.test.mjs` exit 0（2 文件）；UI gate exit 0。测试执行实际 LayoutPolicy、AppNavigation adapter 和 ChatViewState；20 次开关仅纯逻辑测试，非 UI 闪烁/返回手势验收。

此包累计 diff --stat：
```
 .../app/entry/src/main/ets/chat/Composer.ets       |  22 ++--
 .../src/main/ets/entryability/EntryAbility.ets     |   1 +
 .../app/entry/src/main/ets/layout/FoldLayout.ets   |   8 +-
 .../app/entry/src/main/ets/local/BrowserOAuth.ets  |   5 +-
 .../entry/src/main/ets/local/DocumentScanFlow.ets  |   5 +-
 .../app/entry/src/main/ets/local/InAppBrowser.ets  |   6 +-
 .../entry/src/main/ets/local/OAuthLoginSheet.ets   |  10 +-
 .../entry/src/main/ets/local/ProviderCatalog.ets   |   3 +-
 .../entry/src/main/ets/pages/AddProviderPage.ets   |  15 ++-
 .../entry/src/main/ets/pages/AppearancePage.ets    |  32 +++---
 .../app/entry/src/main/ets/pages/ApprovalPage.ets  |   9 +-
 .../app/entry/src/main/ets/pages/BackupPage.ets    |   9 +-
 .../app/entry/src/main/ets/pages/BodyPage.ets      |  19 ++--
 .../entry/src/main/ets/pages/BrainSpacePage.ets    |  41 ++++---
 .../entry/src/main/ets/pages/CollectionsPage.ets   |  23 ++--
 .../entry/src/main/ets/pages/DocumentScanPage.ets  |  19 ++--
 .../app/entry/src/main/ets/pages/EnvPage.ets       |  19 ++--
 .../app/entry/src/main/ets/pages/FleetPage.ets     |  12 ++-
 .../app/entry/src/main/ets/pages/HomePage.ets      |  46 ++++++--
 .../app/entry/src/main/ets/pages/LocalChatPage.ets |   9 +-
 .../entry/src/main/ets/pages/MailAccountsPage.ets  |   9 +-
 .../app/entry/src/main/ets/pages/McpOAuthPage.ets  |   9 +-
 .../app/entry/src/main/ets/pages/McpPage.ets       |  13 ++-
 .../app/entry/src/main/ets/pages/MemoryPage.ets    |  23 ++--
 .../entry/src/main/ets/pages/ModelGroupsPage.ets   |  11 +-
 .../src/main/ets/pages/ProviderDetailPage.ets      |  15 ++-
 .../entry/src/main/ets/pages/ProviderListPage.ets  |  17 +--
 .../entry/src/main/ets/pages/RecordingsPage.ets    |   9 +-
 .../app/entry/src/main/ets/pages/RelayPage.ets     |  37 +++----
 .../entry/src/main/ets/pages/ReleaseNotesPage.ets  |   9 +-
 .../entry/src/main/ets/pages/RemoteChatPage.ets    |   9 +-
 .../src/main/ets/pages/RemoteWorkspacePage.ets     |  13 ++-
 .../app/entry/src/main/ets/pages/RuntimePage.ets   |  15 ++-
 .../entry/src/main/ets/pages/SSHTerminalPage.ets   |   9 +-
 .../app/entry/src/main/ets/pages/SchedulePage.ets  |  19 ++--
 .../entry/src/main/ets/pages/ScreenSessionPage.ets |   9 +-
 .../app/entry/src/main/ets/pages/SettingsPage.ets  |   9 +-
 .../app/entry/src/main/ets/pages/SkillsPage.ets    |  23 ++--
 .../app/entry/src/main/ets/pages/SoulPage.ets      |  23 ++--
 .../app/entry/src/main/ets/pages/SyncPage.ets      |   9 +-
 .../src/main/ets/pages/SystemIntegrationPage.ets   |  13 ++-
 .../app/entry/src/main/ets/pages/TerminalPage.ets  |  26 +++--
 .../app/entry/src/main/ets/pages/UsagePage.ets     |   9 +-
 .../app/entry/src/main/ets/pages/WebPage.ets       |  14 ++-
 .../app/entry/src/main/ets/pages/WorkspacePage.ets |  29 +++--
 .../app/entry/src/main/ets/panes/ChatPane.ets      |  25 ++---
 .../app/entry/src/main/ets/panes/FleetPane.ets     |  17 +--
 .../entry/src/main/ets/panes/LocalAgentPane.ets    |  84 ++++++++-------
 .../app/entry/src/main/ets/panes/LocalChatPane.ets |  13 +--
 .../app/entry/src/main/ets/panes/SettingsPane.ets  |  61 +++++------
 .../app/entry/src/main/ets/theme/Controls.ets      | 118 +++++++++++++++++++++
 .../app/entry/src/main/ets/theme/Tokens.ets        |   8 ++
 .../app/entry/src/main/ets/theme/Widgets.ets       |  82 ++------------
 .../main/resources/base/profile/main_pages.json    |  40 +------
 src/harmony/scripts/build_hap.sh                   |   1 +
 55 files changed, 681 insertions(+), 462 deletions(-)

```

## L2 · 源码与可运行测试

本机问答使用原生 bindContextMenu：复制、选择文字、最后回答重新生成、Voice 朗读、当前轮次长图预览、删除。删除确认明确按完整轮次删除以保留工具关系，运行/审批/提交中拒绝删除；其余轮次、草稿、工作区不变。长图用真实 ArkUI offscreen componentSnapshot 纵向排版并分段（每段完整文字/图片，最多 80 段超限报错），PNG 写入与资源释放、预览后才打开系统 ShareKit；不声称分享面板打开等于收件成功。缓存 24 小时后在下一次进入时清理。

本机会话 ListItem.swipeAction 置顶/删除，5 秒后调用原删除接口；撤销取消计时，不伪造文件恢复；过期不允许撤销、失败重现列表。搜索继续走原 SessionStore 标题+最近内容。新增首屏/第二大脑骨架、1.5 屏估算+真实行数约束的长回答预览、可选择原文的分页阅读。触感 usage=touch，无 notification/alarm 回退，不影响执行结果。右栏审批回执只在原校验成功之后记录，不保存票据/参数，不产生授权。

本机与远程流式滚动均检查用户位置与迟到回调；本机新消息计数、远程回到底部入口。远程长按仅提供现有协议可支持的复制/选择/朗读/分享；没有臆造远程删除/重新生成端点。远程原审批与网络调用未改。

`node --test .../chat-ux.test.mjs .../harmony-ux.test.mjs .../ui-lifecycle.test.mjs` exit 0（3 文件）；`node --test .../protocol.test.mjs .../remote-controls.test.mjs` exit 0（2 文件）；UI gate exit 0。Unicode 原文守恒、实际 UndoDeletion 时钟/失败、实际 followTail 排队滚动竞态均执行。图片、系统分享、触感与手势仍未运行，须 Studio。

此时累计 diff --stat：
```
 .../app/entry/src/main/ets/chat/Composer.ets       |  22 +--
 .../src/main/ets/entryability/EntryAbility.ets     |   1 +
 .../app/entry/src/main/ets/layout/FoldLayout.ets   |   8 +-
 .../app/entry/src/main/ets/local/BrowserOAuth.ets  |   5 +-
 .../entry/src/main/ets/local/DocumentScanFlow.ets  |   5 +-
 .../app/entry/src/main/ets/local/InAppBrowser.ets  |   6 +-
 .../entry/src/main/ets/local/OAuthLoginSheet.ets   |  10 +-
 .../entry/src/main/ets/local/ProviderCatalog.ets   |   3 +-
 .../entry/src/main/ets/pages/AddProviderPage.ets   |  15 +-
 .../entry/src/main/ets/pages/AppearancePage.ets    |  51 +++--
 .../app/entry/src/main/ets/pages/ApprovalPage.ets  |   9 +-
 .../app/entry/src/main/ets/pages/BackupPage.ets    |   9 +-
 .../app/entry/src/main/ets/pages/BodyPage.ets      |  19 +-
 .../entry/src/main/ets/pages/BrainSpacePage.ets    |  43 +++--
 .../entry/src/main/ets/pages/CollectionsPage.ets   |  23 ++-
 .../entry/src/main/ets/pages/DocumentScanPage.ets  |  19 +-
 .../app/entry/src/main/ets/pages/EnvPage.ets       |  19 +-
 .../app/entry/src/main/ets/pages/FleetPage.ets     |  12 +-
 .../app/entry/src/main/ets/pages/HomePage.ets      |  54 ++++--
 .../app/entry/src/main/ets/pages/LocalChatPage.ets |   9 +-
 .../entry/src/main/ets/pages/MailAccountsPage.ets  |   9 +-
 .../app/entry/src/main/ets/pages/McpOAuthPage.ets  |   9 +-
 .../app/entry/src/main/ets/pages/McpPage.ets       |  13 +-
 .../app/entry/src/main/ets/pages/MemoryPage.ets    |  23 ++-
 .../entry/src/main/ets/pages/ModelGroupsPage.ets   |  11 +-
 .../src/main/ets/pages/ProviderDetailPage.ets      |  15 +-
 .../entry/src/main/ets/pages/ProviderListPage.ets  |  17 +-
 .../entry/src/main/ets/pages/RecordingsPage.ets    |   9 +-
 .../app/entry/src/main/ets/pages/RelayPage.ets     |  37 ++--
 .../entry/src/main/ets/pages/ReleaseNotesPage.ets  |   9 +-
 .../entry/src/main/ets/pages/RemoteChatPage.ets    |   9 +-
 .../src/main/ets/pages/RemoteWorkspacePage.ets     |  13 +-
 .../app/entry/src/main/ets/pages/RuntimePage.ets   |  15 +-
 .../entry/src/main/ets/pages/SSHTerminalPage.ets   |   9 +-
 .../app/entry/src/main/ets/pages/SchedulePage.ets  |  19 +-
 .../entry/src/main/ets/pages/ScreenSessionPage.ets |   9 +-
 .../app/entry/src/main/ets/pages/SettingsPage.ets  |   9 +-
 .../app/entry/src/main/ets/pages/SkillsPage.ets    |  23 ++-
 .../app/entry/src/main/ets/pages/SoulPage.ets      |  23 ++-
 .../app/entry/src/main/ets/pages/SyncPage.ets      |   9 +-
 .../src/main/ets/pages/SystemIntegrationPage.ets   |  13 +-
 .../app/entry/src/main/ets/pages/TerminalPage.ets  |  26 ++-
 .../app/entry/src/main/ets/pages/UsagePage.ets     |   9 +-
 .../app/entry/src/main/ets/pages/WebPage.ets       |  14 +-
 .../app/entry/src/main/ets/pages/WorkspacePage.ets |  29 ++-
 .../app/entry/src/main/ets/panes/ChatPane.ets      |  77 ++++++--
 .../app/entry/src/main/ets/panes/FleetPane.ets     |  17 +-
 .../entry/src/main/ets/panes/LocalAgentPane.ets    | 213 +++++++++++----------
 .../app/entry/src/main/ets/panes/LocalChatPane.ets | 138 ++++++++++---
 .../app/entry/src/main/ets/panes/SettingsPane.ets  | 116 ++++++++---
 .../app/entry/src/main/ets/theme/Controls.ets      | 118 ++++++++++++
 .../app/entry/src/main/ets/theme/Symbols.ets       |  29 ++-
 .../app/entry/src/main/ets/theme/Tokens.ets        |   8 +
 .../app/entry/src/main/ets/theme/Widgets.ets       |  86 +--------
 src/harmony/app/entry/src/main/module.json5        |   1 +
 .../main/resources/base/profile/main_pages.json    |  40 +---
 src/harmony/protocol/brain-document-scan.test.mjs  |   2 +-
 src/harmony/protocol/linux-runtime.test.mjs        |   9 +-
 src/harmony/protocol/protocol.test.mjs             |  12 +-
 src/harmony/protocol/secret-query-models.test.mjs  |   2 +-
 src/harmony/protocol/ui-lifecycle.test.mjs         |  16 +-
 src/harmony/scripts/build_hap.sh                   |   1 +
 62 files changed, 1038 insertions(+), 570 deletions(-)

```

## L3 · 源码实施

设置入口统一单色系统符号，主题外无任意分类色；常用 2×2 卡片显示实际服务商、默认模型组、审批方式、外观值；四个分组保持展开，顶部分组条滚动到实测布局坐标，保留搜索。卡片使用 card/grouped 与边界线。外观浅/深改日/月符号，系统模式用设备符号，不再用照片/省略号。iOS 对照映射写入 SettingsSymbols.iosToHarmony。新增 sun_max/moon 的目标 SDK 资源可用性尚须 Studio 编译确认；网上检索没有取得可靠资源清单，不能把本地白名单通过写成 SDK 符号验证。

现有协议测试的图标白名单和流式断言适配新 LongAnswer 组件，新增断言确保流式仍直接传完整文字到 Markdown，只有完成后才折叠。此前全套 exit 1 的最终旧 Markdown 断言已定位修正，针对 protocol.test.mjs exit 0；最终全套在版本同步后运行。

此时累计 diff --stat：
```
 .../app/entry/src/main/ets/chat/Composer.ets       |  22 +--
 .../src/main/ets/entryability/EntryAbility.ets     |   1 +
 .../app/entry/src/main/ets/layout/FoldLayout.ets   |   8 +-
 .../app/entry/src/main/ets/local/BrowserOAuth.ets  |   5 +-
 .../entry/src/main/ets/local/DocumentScanFlow.ets  |   5 +-
 .../app/entry/src/main/ets/local/InAppBrowser.ets  |   6 +-
 .../entry/src/main/ets/local/OAuthLoginSheet.ets   |  10 +-
 .../entry/src/main/ets/local/ProviderCatalog.ets   |   3 +-
 .../entry/src/main/ets/pages/AddProviderPage.ets   |  15 +-
 .../entry/src/main/ets/pages/AppearancePage.ets    |  51 +++--
 .../app/entry/src/main/ets/pages/ApprovalPage.ets  |   9 +-
 .../app/entry/src/main/ets/pages/BackupPage.ets    |   9 +-
 .../app/entry/src/main/ets/pages/BodyPage.ets      |  19 +-
 .../entry/src/main/ets/pages/BrainSpacePage.ets    |  43 +++--
 .../entry/src/main/ets/pages/CollectionsPage.ets   |  23 ++-
 .../entry/src/main/ets/pages/DocumentScanPage.ets  |  19 +-
 .../app/entry/src/main/ets/pages/EnvPage.ets       |  19 +-
 .../app/entry/src/main/ets/pages/FleetPage.ets     |  12 +-
 .../app/entry/src/main/ets/pages/HomePage.ets      |  54 ++++--
 .../app/entry/src/main/ets/pages/LocalChatPage.ets |   9 +-
 .../entry/src/main/ets/pages/MailAccountsPage.ets  |   9 +-
 .../app/entry/src/main/ets/pages/McpOAuthPage.ets  |   9 +-
 .../app/entry/src/main/ets/pages/McpPage.ets       |  13 +-
 .../app/entry/src/main/ets/pages/MemoryPage.ets    |  23 ++-
 .../entry/src/main/ets/pages/ModelGroupsPage.ets   |  11 +-
 .../src/main/ets/pages/ProviderDetailPage.ets      |  15 +-
 .../entry/src/main/ets/pages/ProviderListPage.ets  |  17 +-
 .../entry/src/main/ets/pages/RecordingsPage.ets    |   9 +-
 .../app/entry/src/main/ets/pages/RelayPage.ets     |  37 ++--
 .../entry/src/main/ets/pages/ReleaseNotesPage.ets  |   9 +-
 .../entry/src/main/ets/pages/RemoteChatPage.ets    |   9 +-
 .../src/main/ets/pages/RemoteWorkspacePage.ets     |  13 +-
 .../app/entry/src/main/ets/pages/RuntimePage.ets   |  15 +-
 .../entry/src/main/ets/pages/SSHTerminalPage.ets   |   9 +-
 .../app/entry/src/main/ets/pages/SchedulePage.ets  |  19 +-
 .../entry/src/main/ets/pages/ScreenSessionPage.ets |   9 +-
 .../app/entry/src/main/ets/pages/SettingsPage.ets  |   9 +-
 .../app/entry/src/main/ets/pages/SkillsPage.ets    |  23 ++-
 .../app/entry/src/main/ets/pages/SoulPage.ets      |  23 ++-
 .../app/entry/src/main/ets/pages/SyncPage.ets      |   9 +-
 .../src/main/ets/pages/SystemIntegrationPage.ets   |  13 +-
 .../app/entry/src/main/ets/pages/TerminalPage.ets  |  26 ++-
 .../app/entry/src/main/ets/pages/UsagePage.ets     |   9 +-
 .../app/entry/src/main/ets/pages/WebPage.ets       |  14 +-
 .../app/entry/src/main/ets/pages/WorkspacePage.ets |  29 ++-
 .../app/entry/src/main/ets/panes/ChatPane.ets      |  77 ++++++--
 .../app/entry/src/main/ets/panes/FleetPane.ets     |  17 +-
 .../entry/src/main/ets/panes/LocalAgentPane.ets    | 213 +++++++++++----------
 .../app/entry/src/main/ets/panes/LocalChatPane.ets | 138 ++++++++++---
 .../app/entry/src/main/ets/panes/SettingsPane.ets  | 116 ++++++++---
 .../app/entry/src/main/ets/theme/Controls.ets      | 118 ++++++++++++
 .../app/entry/src/main/ets/theme/Symbols.ets       |  29 ++-
 .../app/entry/src/main/ets/theme/Tokens.ets        |   8 +
 .../app/entry/src/main/ets/theme/Widgets.ets       |  86 +--------
 src/harmony/app/entry/src/main/module.json5        |   1 +
 .../main/resources/base/profile/main_pages.json    |  40 +---
 src/harmony/protocol/brain-document-scan.test.mjs  |   2 +-
 src/harmony/protocol/linux-runtime.test.mjs        |   9 +-
 src/harmony/protocol/protocol.test.mjs             |  12 +-
 src/harmony/protocol/secret-query-models.test.mjs  |   2 +-
 src/harmony/protocol/ui-lifecycle.test.mjs         |  16 +-
 src/harmony/scripts/build_hap.sh                   |   1 +
 62 files changed, 1038 insertions(+), 570 deletions(-)

```


## Studio checkpoint1 · 编译问题优先修复

2026-11-08 阅读本项目 STUDIO_NOTES.md 与 parent/leobot-checkpoint1-errors.txt。Studio 对中间快照给出的真实结果为 **FAIL / 38 errors**，不是 Air 的推断。按共享根因实施：

| 错误组 | 源码修复 | 当前证据边界 |
|---|---|---|
| Route 参数/空对象未显式类型（AppNavigation、扫码、阅读/分享、Inspector） | RouteParams/PageRequest 显式字段、new RouteParams 默认值，消费页不再转任意 Object 字典 | Node adapter/扫码测试通过；SDK 编译待重跑 |
| 自定义 SurfaceButton 尾随内容块后非法链式修饰器（Composer/Appearance/BrainSpace/Workspace/Settings/ListRow） | 提取具名 @Builder，改 `SurfaceButton({ content: ... })`，修饰器直接作用于组件调用 | UI gate 防复发；待 Studio ArkTS 证实 |
| LongAnswer.width 遮蔽 CustomComponent.width | 状态改名 contentWidth，布局 `.width()` 保留 | 静态门禁+源码检查 |
| AppNavigation.getState 缺失 | 用原生栈 getAllPathName 返回显式 NavigationState，WebPage 重用判断恢复 | 实际 adapter 测试覆盖根页/扫码页及 pop |
| Copy.sectionLook / @kit.ImeKit | 使用声明存在的 sectionAppearance 与 SDK 正确大小写 @kit.IMEKit（三处） | 静态回归门禁，待编译 |
| arbitrary throw | 删除失败回滚后抛 Error 类型，未改实际失败分支 | 实际 UI handler I/O 失败回滚测试 |

迁移逐文件审计发现并修复 `openrouter.ai` 字符串误替；BrowserOAuth.ets、ProviderCatalog.ets 现与 HEAD 逐字相同。对全部已改 ETS 的 HTTP(S) 字面量与 HEAD 比较，**零变化**。ChatRun、LocalProtocol、SensitiveToolGate、HarnessClient 亦逐字不变。不是通过改模型/审批/协议来修 UI。

`checkpoint1` 针对扫码、布局/导航、UI 生命周期、聊天 I/O 的 4 个 Node 文件 exit 0；git diff --check exit 0。中途新增门禁 fixture 引号语法错误曾 exit 1，已修，最终全套另见下方真实日志。原来的 fixture 失败与中间 ArkTS 失败均保留此记录，没有改写成曾经通过。

## L4 准备（不是发版）

- app.json5 / ReleaseCatalog.ets / 根 CHANGELOG.md 同步 0.5.0 / 100029，原码 100028。
- ReleaseCatalog 第一条明确候选/待验收，0.4.0 历史条目保留；实际执行 catalog 测试验证版本无重复。
- 根 README 区分公开 0.4.0 与新候选；docs/harmony-upgrade-20261108/STATUS.md 只追加新候选，不挪用旧实机证据。
- TEST_GUIDE.md 包括命令、真实入口、状态准备、L0 12 张/L1 折叠与键盘/L2 交互/L3 8 张/最后实机矩阵。没有创建模拟截图/实机结果。

## 明确限制与待验证

1. 当前最终源码没有新的 ArkTS 编译通过证据。Studio 必须先重编译，尤其复核 RouteParams、具名 builder、Navigation 生命周期、sun_max/moon 系统资源及 ShareKit；若仍有编译错误不可进入安装/验收。
2. 所有模拟器渲染/边缘返回/输入法/折叠/读屏/触感/系统分享、最终签名升级与实机性能/账号仍未执行。Air 不把 Node platform mocks 当系统 API 运行。
3. 本机第三栏完整展示文件/工具/本次启动审批摘要；远程保持原机器/对话与工作区用户路径，不把本机文件混入远程。远程删除/重新生成没有既有协议端点，不新增假操作。
4. 审批摘要只在当前启动内存中，非永久审计日志；未保存完整参数/票据。长图 80 段超限明确失败，不截断；缓存由 OS 管理并在下一次进入清理超过 24h 的本功能文件。
5. 当前独立快照保留，未提交、未推送、未改签名、未启动模拟器、未 SSH 或访问其他项目/主仓。Studio 补入的参照文件和 STUDIO_NOTES 不作为新产品文件提交。


## 最终源码检查与冻结交接

- 本机 Node **v26.11.1**；`node --test src/harmony/protocol/*.test.mjs`：**42 / 42 文件通过，0 失败、0 跳过，退出码 0**。原始输出 `evidence/node-tests.log`，退出码 `evidence/test-exit.txt`。
- UI 静态门禁：**0 违规，exit 0**；版本门禁：**0.5.0 / 100029，exit 0**；`git diff --check`：**exit 0**。输出 `evidence/checks.log`。
- 新增实际源码执行测试覆盖：LayoutPolicy/ChatViewState、AppNavigation/getState、Unicode 分页、分享段落、UndoDeletion、延迟滚动、长图 I/O/资源释放（平台模拟对象，非截图）、整轮删除拒绝/回滚、ReleaseCatalog、语义图标声明与负向 UI 门禁样例。
- 所有新源码通过 intent-to-add 纳入 `git diff`，没有提交任何文件；Studio 协调笔记及补入的 Android/Mac 参照仍保留在未跟踪状态。最终差异清单见 `evidence/diff-stat.txt`，已改 Harmony 源码/测试 SHA256 清单见 `evidence/source-manifest.sha256`。
- **在此停止 Air 源码施工，交 Studio 使用冻结源码重新编译。** checkpoint1 38 个错误的修复尚无新编译回执，不宣称构建通过。若 Studio 重编译仍失败，必须以新的真实诊断继续修复后再进入模拟器；无签名/模拟器/实机结果、无发布。

冻结前累计 `git diff --stat`（包括新建交付文件；随后仅追加此记录）：
```text
 CHANGELOG.md                                       |  10 +
 README.md                                          |   7 +
 docs/harmony-upgrade-20261108/STATUS.md            |   8 +
 docs/harmony-ux-20261108/RESULT.md                 | 392 +++++++++++++++++++++
 docs/harmony-ux-20261108/TEST_GUIDE.md             | 124 +++++++
 docs/harmony-ux-20261108/evidence/checks.log       |   6 +
 docs/harmony-ux-20261108/evidence/diff-stat.txt    |  86 +++++
 docs/harmony-ux-20261108/evidence/node-tests.log   | 207 +++++++++++
 .../evidence/source-manifest.sha256                |  78 ++++
 docs/harmony-ux-20261108/evidence/test-exit.txt    |   1 +
 src/harmony/app/AppScope/app.json5                 |   4 +-
 .../app/entry/src/main/ets/chat/ChatUXPolicy.ets   |  28 ++
 .../app/entry/src/main/ets/chat/Composer.ets       |  66 ++--
 .../app/entry/src/main/ets/chat/LongAnswer.ets     |  34 ++
 .../app/entry/src/main/ets/chat/TurnShare.ets      |  32 ++
 .../src/main/ets/entryability/EntryAbility.ets     |   1 +
 .../app/entry/src/main/ets/layout/FoldLayout.ets   |   8 +-
 .../app/entry/src/main/ets/layout/LayoutPolicy.ets |  22 ++
 .../entry/src/main/ets/local/DocumentScanFlow.ets  |   5 +-
 .../app/entry/src/main/ets/local/InAppBrowser.ets  |   6 +-
 .../entry/src/main/ets/local/OAuthLoginSheet.ets   |  10 +-
 .../src/main/ets/navigation/AppNavigation.ets      |  51 +++
 .../entry/src/main/ets/navigation/Destinations.ets |  81 +++++
 .../entry/src/main/ets/pages/AddProviderPage.ets   |  17 +-
 .../entry/src/main/ets/pages/AppearancePage.ets    |  69 ++--
 .../app/entry/src/main/ets/pages/ApprovalPage.ets  |   9 +-
 .../app/entry/src/main/ets/pages/BackupPage.ets    |  10 +-
 .../app/entry/src/main/ets/pages/BodyPage.ets      |  19 +-
 .../entry/src/main/ets/pages/BrainSpacePage.ets    |  62 ++--
 .../entry/src/main/ets/pages/CollectionsPage.ets   |  24 +-
 .../entry/src/main/ets/pages/DocumentScanPage.ets  |  22 +-
 .../app/entry/src/main/ets/pages/EnvPage.ets       |  19 +-
 .../app/entry/src/main/ets/pages/FleetPage.ets     |  13 +-
 .../app/entry/src/main/ets/pages/HomePage.ets      |  56 ++-
 .../app/entry/src/main/ets/pages/LocalChatPage.ets |  10 +-
 .../app/entry/src/main/ets/pages/LongTextPage.ets  |  37 ++
 .../entry/src/main/ets/pages/MailAccountsPage.ets  |  10 +-
 .../app/entry/src/main/ets/pages/McpOAuthPage.ets  |  10 +-
 .../app/entry/src/main/ets/pages/McpPage.ets       |  13 +-
 .../app/entry/src/main/ets/pages/MemoryPage.ets    |  24 +-
 .../entry/src/main/ets/pages/ModelGroupsPage.ets   |  11 +-
 .../src/main/ets/pages/ProviderDetailPage.ets      |  15 +-
 .../entry/src/main/ets/pages/ProviderListPage.ets  |  17 +-
 .../entry/src/main/ets/pages/RecordingsPage.ets    |  10 +-
 .../app/entry/src/main/ets/pages/RelayPage.ets     |  37 +-
 .../entry/src/main/ets/pages/ReleaseNotesPage.ets  |   9 +-
 .../entry/src/main/ets/pages/RemoteChatPage.ets    |  10 +-
 .../src/main/ets/pages/RemoteWorkspacePage.ets     |  14 +-
 .../app/entry/src/main/ets/pages/RuntimePage.ets   |  15 +-
 .../entry/src/main/ets/pages/SSHTerminalPage.ets   |  10 +-
 .../app/entry/src/main/ets/pages/SchedulePage.ets  |  19 +-
 .../entry/src/main/ets/pages/ScreenSessionPage.ets |  10 +-
 .../app/entry/src/main/ets/pages/SettingsPage.ets  |   9 +-
 .../app/entry/src/main/ets/pages/SkillsPage.ets    |  24 +-
 .../app/entry/src/main/ets/pages/SoulPage.ets      |  23 +-
 .../app/entry/src/main/ets/pages/SyncPage.ets      |   9 +-
 .../src/main/ets/pages/SystemIntegrationPage.ets   |  14 +-
 .../app/entry/src/main/ets/pages/TerminalPage.ets  |  27 +-
 .../app/entry/src/main/ets/pages/TurnSharePage.ets | 108 ++++++
 .../app/entry/src/main/ets/pages/UsagePage.ets     |   9 +-
 .../app/entry/src/main/ets/pages/WebPage.ets       |  14 +-
 .../app/entry/src/main/ets/pages/WorkspacePage.ets |  53 ++-
 .../app/entry/src/main/ets/panes/ChatInspector.ets |  87 +++++
 .../app/entry/src/main/ets/panes/ChatPane.ets      |  78 +++-
 .../app/entry/src/main/ets/panes/FleetPane.ets     |  18 +-
 .../entry/src/main/ets/panes/LocalAgentPane.ets    | 213 +++++------
 .../app/entry/src/main/ets/panes/LocalChatPane.ets | 138 ++++++--
 .../app/entry/src/main/ets/panes/SettingsPane.ets  | 120 +++++--
 .../entry/src/main/ets/release/ReleaseCatalog.ets  |  21 +-
 .../src/main/ets/store/ChatInteractionStore.ets    |  16 +
 .../app/entry/src/main/ets/store/UndoDeletion.ets  |  32 ++
 .../app/entry/src/main/ets/theme/Controls.ets      | 122 +++++++
 .../app/entry/src/main/ets/theme/Haptics.ets       |   9 +
 .../app/entry/src/main/ets/theme/Symbols.ets       |  29 +-
 .../app/entry/src/main/ets/theme/Tokens.ets        |   8 +
 .../app/entry/src/main/ets/theme/Widgets.ets       |  86 +----
 src/harmony/app/entry/src/main/module.json5        |   1 +
 .../main/resources/base/profile/main_pages.json    |  40 +--
 src/harmony/protocol/brain-document-scan.test.mjs  |   2 +-
 src/harmony/protocol/chat-ux.test.mjs              |  82 +++++
 src/harmony/protocol/harmony-ux.test.mjs           |  59 ++++
 src/harmony/protocol/linux-runtime.test.mjs        |   9 +-
 src/harmony/protocol/protocol.test.mjs             |  12 +-
 src/harmony/protocol/secret-query-models.test.mjs  |   2 +-
 src/harmony/protocol/ui-lifecycle.test.mjs         |  16 +-
 src/harmony/protocol/ui-tokens.test.mjs            |  35 ++
 src/harmony/scripts/build_hap.sh                   |   1 +
 src/harmony/scripts/check_ui_tokens.mjs            |  39 ++
 88 files changed, 2818 insertions(+), 615 deletions(-)

```
