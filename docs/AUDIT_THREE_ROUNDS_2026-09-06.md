# 三轮全面审计与升级报告（iOS / Android / Mac，2026-09-06）

基线 `main @ 3e107985`（iOS 1.33.0(108) / Android alpha.26 / Mac 1.83.0），工作分支 `audit/three-rounds-2026-09-06`。鸿蒙不在范围。三轮各自独立做一遍完整审计，每轮换一个镜头：第一轮看用户动线和点名问题的根因，第二轮看系统能力、平台集成与三端一致性，第三轮看性能、安全、死代码和发版就绪。

## 点名问题的根因与修法

### Mac「Claude Code 任务久了无法加载当前对话」

解析不是瓶颈：本机最大的一份转录 40 MB / 920 行，全量解析 73 ms。真正的原因是五件事叠在一起：

| # | 根因 | 修法 |
|---|------|------|
| 1 | `refreshFromServer` 不带 limit。每次 complete / 文件变更 / 重连都把整段转录拉回渲染进程，长任务里粘贴的截图以 base64 内嵌，一次就是几十 MB | 刷新改为有界（当前已显示条数，最少 20 条） |
| 2 | 历史请求没有超时。本地服务一卡，页面永远停在「正在加载会话消息...」 | 60 秒超时，超时进入 error 状态 |
| 3 | 加载失败、以及转录被 Claude Code 定期清理（数据库里 10+ 条 `jsonl_path` 指向已不存在的文件）都渲染成「选择 Agent 开始对话」的空态，看起来像会话没了 | 服务端返回 `transcriptMissing`；客户端分别显示「记录已不在本机」和「无法加载 · 重试」 |
| 4 | 长任务超过 5000 事件后重连，重放缓冲已截断，服务端不告知，客户端静默缺段 | `chat_subscribed.replayTruncated`，客户端自动走 REST 补齐 |
| 5 | WebSocket 没有心跳。Mac 睡眠后 loopback 套接字半开、或本地服务无 FIN 死亡时 `onclose` 永不触发，界面显示已连接却收不到任何事件 | 空闲 30 s 发 `ping`，10 s 内无 `pong` 主动关闭触发既有重连；窗口聚焦 / 可见 / 网络恢复时立即探活 |

附带修复：老同步器把 `<session>/subagents/agent-*.jsonl` 写进父会话 `jsonl_path`（数据库里确有一条），永远加载为空，启动迁移修复；子代理工具明细兼容新的 subagents 目录结构。

### Mac「新任务按钮是假的」

点击只切 tab：URL 仍是 `/session/<id>`、会话列表仍高亮旧会话；已经在新任务页时再点毫无反应；任务坞输入框在没选项目时是 `disabled`，占位写「先在 ⌘K 里选一个项目」，整页没有一个能点的东西。修法：点击同时清空会话选择、回到根路径、把光标送进任务坞；输入框始终可写，回车后自动弹项目抽屉；「当前项目」行可点直接选项目；菜单栏新增「工作环境 → 新任务 ⌘N」。

### 移动端「设置母菜单和子菜单堆在一起」

iOS 设置首页的分组头与子项同为 34 pt 图标框 + 15 pt 标题 + 白底，默认两组展开就是 19 行长得一样。修法：分组头改为低饱和色带 + 小号粗体 + 数量胶囊 + 展开/收起文字，无图标框；子项缩进、28 pt 图标框、常规字重；颜色、字号、缩进三个维度同时区分。「远程机器 / Mac 控制台 / SSH 备用 / 能力中心 / 权限」这些易混条目补一句说明。Android 根设置页的层级本来是对的（分组标签在卡片外），但它与子页用的是两套组件，本轮统一。

## 第一轮 · 用户动线

- Mac 会话列表只有「进行中」和「今天已完成」，昨天及更早的会话只能靠 ⌘K 搜 → 新增「更早」折叠组（默认收起、最多 40 条、记住展开状态）。
- Android 会话多选工具栏的「导出」是 `/* TODO */` 空实现 → 复用 ChatExporter 逐条打包，ACTION_SEND_MULTIPLE 一次分享。
- 三端占位/死按钮扫描：Android 其余 `onClick = {}` 均为拖拽把手或长按容器，属正常；iOS、Mac 无死控件。

## 第二轮 · 系统能力与一致性

- Mac：WebSocket 心跳与唤醒探活（见上）；菜单栏「新任务 ⌘N」；设置页签与 ChipMenu 的 ARIA 语义检查通过。
- iOS：全部 `navigationTitle` 英文键在 xcstrings 均有 zh-Hans（含 `%@ Protection`）；能力中心 16 条文案全有中文；Siri 短语 zh-Hans 存在。
- Android：三份 `SettingsSection` 实现统一到 SettingsComponents，根设置页改用 SettingsScaffold + SettingsRow（图标形状、圆角、分组头颜色与所有子页一致），删除 `ui/components/SettingsSection.kt`；「反馈」弹层里的 Telegram 群和 `dev@openminis.app` 是上游 OpenMinis 的入口，崩溃报告的「邮件」选项同样寄到 openminis → 只保留本仓库 GitHub Issues 直达，删除 mailto 路径与 4 条无用字符串（8 个语言文件）。
- 能力清单对照：iOS 26 项 `apple-*`，Android 22 个 offload handler。Android 缺而可补的是 maps（导航 Intent）、files（SAF）、camera；reminders 因 Android 无统一 Tasks Provider 已在 README 说明不虚报。

## 第三轮 · 性能、安全、死代码、发版

- Mac 死代码：按目录扫描曾把 standalone-shell / missions / onboarding 判为无引用，删除后 typecheck 与 vite build 立即暴露它们仍被 ProviderLoginModal / MainContent / ProtectedRoute 引用，已全部恢复；只清掉空目录 dashboard/cards。教训：相对路径 `../../x` 的引用不能靠目录名 grep 判死活，要以编译器为准。
- 生产依赖：上一版 CHANGELOG 声称 `npm audit` 0 漏洞，本轮实测 5 项（express 链上的 qs / body-parser，ajv 链上的 fast-uri）。根因是 `overrides` 把 fast-uri 钉在 3.1.5；升到 fast-uri 3.1.7 + qs 6.16.0 后回到 0。
- diff 秘密扫描无发现；relay 安全测试 13/13。
- 发版铁律三端落地：Mac 1.84.0 + `LEO_RELEASE_NOTES`（`verify:release-notes` 3/3）；iOS 1.34.0 (109) + `LeoReleaseCatalog`；Android alpha.27 (100027) + values / zh / zh-rTW 的 `whats_new_current` 与 `whats_new_version`（WhatsNewGateTest 契约）。CHANGELOG 与 README 徽章同步；未构建发布任何 APK / DMG / IPA，README 的 Android 下载区仍指向已发布的 alpha.26。

## 验证

| 端 | 门禁 | 结果 |
|----|------|------|
| Mac | typecheck / lint / verify:release-notes | 通过 / 通过 / 3/3 |
| Mac | desktop / client / server 测试 | 37/37 / 162/162（+3 新增） / 410/410（+4 新增） |
| Mac | production build | 通过 |
| Mac | `npm audit --omit=dev` | 0 漏洞 |
| Android | Standard + Power compileDebugKotlin | 通过（JDK 17） |
| Android | Standard + Power JVM 单测 | 641/641（各 1 跳过，0 失败）×2；首跑因英文更新文案撇号未转义在资源合并阶段失败，修正后复跑通过 |
| iOS | generic iPhone/iPad 设备目标无签名构建（含版本号提升后） | BUILD SUCCEEDED |
| iOS | MinisLogicTests（iPhone 17 Pro 模拟器） | 337/337 |
| relay | test_relay_security | 13/13 |

新增回归测试：重放截断判定、转录缺失响应、子代理路径迁移修复、ping→pong、有界刷新与 error/missing 双态、会话列表「更早」组。

未做实机验证：Mac 桌面端本机未在运行且未获屏幕控制授权，「新任务」与会话加载的修复由单测和构建门禁背书，装机后请按下方步骤复核；iPhone/iPad、Fold8 未装机。

## 记录未改

- Mac 云端模式菜单（Switch Environment / Cloud / Remote Environments）仍是英文，本地模式下隐藏。
- Android 9 个子页仍用裸 TopAppBar 而非 SettingsScaffold（视觉可接受）。
- Android 缺 maps / files / camera 三类本机能力。
- 大文件治理：Mac 单文件 >800 行 12 个；iOS ChatStore / AIChatViewModel >6000 行；Android ChatViewModel 10286 行。

## 装机后复核清单

1. Mac：打开一个跑过很久的 Claude Code 会话，应在数秒内出现最近消息；把 Mac 合盖 5 分钟再打开，状态栏应短暂断开后自动恢复；点标题栏「新任务」应清空右侧、列表取消高亮、光标落在任务坞。
2. iOS：设置首页展开「我的设备」，分组头应为青色色带与数字胶囊，子项缩进。
3. Android：会话列表长按进入多选，勾两条点「导出」，应弹出系统分享面板并带两个 zip。
