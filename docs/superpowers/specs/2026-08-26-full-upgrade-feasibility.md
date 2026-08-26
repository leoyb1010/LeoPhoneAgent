# LeoPhoneAgent 完整升级可行性与施工总纲

日期：2026-08-26  
状态：分析稿，未授权写功能代码  
基线 checkout：`/Users/leoyuan/Documents/日常 2/LeoPhoneAgent`  
基线提交：`cc033829` `feat(android): ship alpha.13 CLI connection bridge`  
远端：`origin/main` 对齐，ahead/behind `0/0`  
对照输入：用户提供的「完整升级施工 Prompt」+ 仓库现况 + `docs/ABSORB-PLAN-2026-08-19.md` + `docs/ANDROID-OPTIMIZATION-PLAN-2026-08.md` + `docs/COPY-TABLE-2026-08-19.md`

> 本文回答三件事：这份路线会不会让产品更好用、更丝滑、更强；四端 UI 现在卡在哪；下一轮该怎么排，才不会把总路线一次堆进一个版本。

---

## 0. 结论（先看这个）

**会更好用、更丝滑、更强。前提是把它当发版宪法，不当功能超市。**

施工 Prompt 的纪律是对的：一次只做一个用户可见能力、只增不减不验收、真机验证、发版闸门走真实装机路径。按这个做，产品会从「能力很多、入口很深、四端各说各话」变成「同一套任务语言、更少步骤、更少假超时和配置丢失」。

如果把 Phase 0–8 当成一份要一次做完的需求，结果会相反：包体涨、设置更深、第二套 Runtime 渗进来、协议迁移期间任务更不稳。

当前产品已经不是「缺能力」。四端都能独立对话，Android/iOS 有沙箱和 Skills，Mac 是完整第二身体，Android 已能当身体，CLI 已进聊天选择器。真正的缺口是：

1. **可靠性半套**：超时、读文件分页、语音断续、推理规则、配置保护，各端实现不一致。
2. **选路浪费步数**：原生 API 能做的事仍常走 GUI / 远程 / 长推理。
3. **设置和用语太深**：用户要先理解 Provider、Harness、PRoot，才能办完一件事。
4. **重复实现**：Agent Loop、审批、Relay 配对、file_read、Voice、发版弹窗各端各写一份。
5. **CHANGELOG 落后于真实船**：iOS 1.24.1、Mac 1.74.2 没有独立顶栏条目。

**推荐下一轮：压缩版 Phase 0（只出清单，不发用户功能）→ Phase 1 可靠性 + UI 合同（第一艘用户可见船）。不提前做 Action Router、本地模型、Relay v2。**

---

## 1. 对施工 Prompt 的判断

### 1.1 应该全盘保留的

| 条款 | 为什么必须留 |
|---|---|
| 四端形态锁（iPhone/Android 独立，Mac 第二身体，Harmony 瘦控制面） | 和现仓 `ABSORB-PLAN`、README 一致，防止产品退化成遥控器 |
| 每阶段最多一个用户可见能力 | 仓库已经用 alpha 连发证明：一次做多件，发版记录和真机弹窗会对不上 |
| 只增不减不验收 | 重复实现已经很多；再叠 Mobilerun/HAPI/AutoGLM 整套会把主循环撕开 |
| 热更新只许数据/声明，不许远程可执行代码 | 和现有 Mac Developer ID / iOS 签名 / Android 固定指纹铁律同向 |
| 发版 = 版本 + 本次更新事实源 + 真机首启弹出 + README/CHANGELOG/digest | 闸门刚从「只活在 CI」挪到真实装机路径，不能退回去 |
| 主仓直接交付，不另开功能分支 | 与当前用户习惯和 `github-main-safe-upgrade` 一致 |

### 1.2 原文缺了、本文补上的

施工 Prompt 对架构、吸收源、发布、热更新写得很满，但几乎没写 **用户每天看见的界面合同**。四端今天已经不是统一产品面：

- 手机是会话列表优先，Mac 是主控台/Dashboard 优先。
- Harmony 强调色是橙红 `#E85030`，其余三端是青绿。
- Android 设置没有搜索；iOS 刚拆成可搜索的五组。
- 繁中：Android 约 46% 词条，iOS 几乎没有 UI 繁中，Harmony 全是写死简中。
- 「新任务 / 本机 / 远程 / 进行中 / 审批」对照表已写在 `docs/COPY-TABLE-2026-08-19.md`，Android 设置里仍有硬编码中文。

没有 UI 合同，后面每个 Phase 都会各自发明入口，设置会继续变深。

### 1.3 和已有规划的关系（避免第三份平行宇宙）

| 已有文档 | 和本总纲的关系 |
|---|---|
| `docs/ABSORB-PLAN-2026-08-19.md` | A 档身体/舰队多数已在 1.24.x / alpha.12–13 落地。B 档推理/读图/超时 = 本总纲 Phase 1。C 档日常好用并入 UI 合同，不单开 Phase。 |
| `docs/ANDROID-OPTIMIZATION-PLAN-2026-08.md` | CLI 进聊天、Artifact、Relay SSE 已落地。未完成项（CLI 审批映射、远程会话并入本机列表、文件互传）排进 Phase 1/2/6，不再另起优化案。 |
| `docs/COPY-TABLE-2026-08-19.md` | 升格为四端硬合同，每个发版都要对词。 |
| 施工 Prompt Phase 2–8 | 保留为后续列车，不在第一艘船实现。 |

---

## 2. 2026-08-26 真实基线

| 端 | 版本 | 用户主表面 | 发版事实源 |
|---|---|---|---|
| Android | `1.0.0-alpha.13` / `100013` | 会话列表 ↔ 聊天；Fold 宽屏双栏；无底栏 | `whats_new_*` 三语 |
| iOS | `1.24.1` (95) | `NavigationSplitView` 会话 + 聊天；设置五组可搜 | `LeoReleaseCatalog.releases[0]` |
| macOS | leocodebox `1.74.2` | Dashboard + Session Rail + 工作区页签 | `LEO_RELEASE_NOTES[0]` |
| HarmonyOS | `0.3.0-alpha.14` / `100019` | 本机 / 远程（窄屏设置另开页） | `ReleaseCatalog.ets` |

CHANGELOG 顶栏仍停在 Harmony 0.3.0-alpha.14；iOS 1.24.1 与 Mac 1.74.2 没有独立顶栏。README 徽章与仓内版本一致。

### 2.1 已经有的（禁止再造）

- 本机 Agent Loop：iOS `AIChatViewModel.runAgentLoop`，Android `ChatViewModel.runAgentLoop` + 定时/无头两套入口，Mac `pi-kernel`，Harmony `localChat.ts`
- 审批：iOS `SensitiveToolGate` + 凭证门；Android Offload + Relay 审批卡；Mac `useSessionApprovals`；Harmony `ChatPane` 批准/拒绝
- 中继：四端都有配对/舰队；Mac 仍留 `src/mac/leoagent/` 灰色回退
- 沙箱：iOS iSH，Android PRoot + Native Offload；Harmony 明确没有 Linux 沙箱
- Android Power：Accessibility + Shizuku，两套 handler，不得漏进 Standard
- 发版弹窗：四端都有闸门；Mac 另有一套 GitHub `VersionUpgradeModal`，内部构建为空

### 2.2 已经重复的（Phase 0 必须点名，后续替换）

| 能力 | 重复份数 | 主实现应落在哪 |
|---|---|---|
| file_read 分页 / 80KB cap | Android / iOS / Harmony 三份 | 共享契约 + 各端薄适配；调用方不再自写分页 |
| Relay 配对编解码 | `RelayPairCodec.kt` / `relayPair.ts` / Harmony `Protocol.ets` | 一份 Golden Fixture，三端对照 |
| Thinking / effort | iOS 可编辑规则 + 硬编码目录；Android 只有 level；Mac 各 CLI localStorage | iOS 规则为源，远程请求必须带走 |
| Voice / TTS / VAD | 四端各写 | 行为对齐，不合并成跨端库 |
| Agent Loop 入口 | Android 至少 3 条 | 一条主循环，定时/无头只做入口 |
| Mac Harness | leocodebox 主路径 + leoagent 回退 | Phase 4 之后收敛，现在只标记 |

---

## 3. 会不会更好用、更丝滑、更强

评分只看「对每天真实任务的影响」，不看技术时髦程度。

| Phase | 更好用 | 更丝滑 | 更强 | 体积/复杂度风险 | 第一轮该不该做 |
|---|---|---|---|---|---|
| 0 瘦身基线 | 间接 | 间接 | 否 | 低（只标记） | **必须先做，但不发用户版** |
| 1 OpenMinis 可靠性 | 高 | 高 | 中 | 低 | **第一艘用户船** |
| 2 Action Router | 高 | 最高 | 中 | 中（加一层决策，禁第二 Runtime） | 第二艘 |
| 3 Android Action 2.0 | 中（Power 高） | 中 | 高 | 高 | 第三艘，且必须砍范围 |
| 4 Mac 精确窗口 | 高（桌面任务） | 高 | 高 | 中 | 与 3 错开 |
| 5 iOS ShellBridge v2 | 高（文件/捷径） | 中 | 中 | 中 | 4 之后 |
| 6 Relay Protocol v2 | 中 | 先降后升 | 中 | 高 | 至少两消费端稳定后再动 |
| 7 本地快脑 + 主动卡 | 低到中 | 容易变差 | 中 | 高 | 可选，最后 |
| 8 评测基础设施 | 否 | 间接 | 间接 | 中 | 从 Phase 2 起旁路建设，不宣传 |

### 3.1 为什么 Phase 1 比 Phase 2/3 更该先做

用户能感到的「不丝滑」，今天主要不是「不会点微信」，而是：

- 慢模型被假超时杀掉
- 长文件读一半对不上行号
- 说话时朗读抢麦、断续丢字
- 供应商读取失败把配置抹掉
- 推理档在 iPhone 设了，派到 Mac/Android 变成默认
- 设置里找不到刚装的能力

这些是每天都撞的。Action Router 和 GKD 式规则引擎会让「跨 App 操控」更强，但先把主循环做稳，成功率才涨得过账。

### 3.2 哪些条目看起来强、实际会让产品变钝

1. **整套 Mobilerun / Open-AutoGLM / HAPI**  
   Prompt 已禁止引入整套，必须守住。只许学选路和敏感接管语义。
2. **Phase 7 把 270M–2B 模型常驻**  
   空闲内存和冷启动红线很容易破。只允许按需下载、用完释放。
3. **Phase 3 把规则订阅做成第二套产品**  
   Standard 用户不该看见 Power 承诺。规则市场会把首页和设置做成 Operit 式水槽，和形态锁冲突。
4. **Phase 6 在消费端还在抖的时候换协议**  
   Mac 1.74.1 刚修过重连风暴、审批时序、队列头阻塞。先吃稳定红利，再升水位。

### 3.3 三种施工策略

**方案 A：按 Prompt 原文 0→8 顺序硬走**  
完整，但 Phase 0 若做成「四端性能大审计」会消耗一整轮却没有用户可见变化。不推荐作为第一轮装机目标。

**方案 B：压缩 Phase 0 + Phase 1 带 UI 合同（推荐）**  
Phase 0 只产出保留/替换/删除/延期四表和主实现定义，不 bump 版本。然后一艘船只交付「更稳的对话和文件/语音」+ 用语/设置可发现性。符合「每阶段一个可见能力」。

**方案 C：跳过可靠性，直接做 Action Router / Power 引擎**  
演示更炫，回归面最大，假超时和配置丢失会继续被当成「新功能 bug」。否决。

---

## 4. 四端 UI / 布局 / 设计分析

### 4.1 设计读法

个人每日使用的跨端 Agent，不是 SaaS 官网，也不是仪表盘。每端用该平台原生控件；品牌只统一 **青绿强调、任务语言、四表面信息架构**。不做网页风玻璃拟态，不把 Mac 主控台搬到手机首页。

| 端 | 现在像什么 | 应该继续像什么 |
|---|---|---|
| iOS | 原生 SwiftUI 分组列表，系统色 + SF Symbols | 继续原生；设置五组是正确方向 |
| Android | Material 3 壳，刻意模仿 iOS 分组和青绿 | 保留青绿，补设置搜索，不要再加深「安卓版 iPhone」错觉到连系统手势都丢掉 |
| Mac | Electron 工作台，暖纸背景 + 青绿，少图标 | 保持工作台，不要做成第二个手机 |
| Harmony | 原生 ArkUI，但橙红强调、文案写死简中 | 瘦控制面保留；强调色和下一项外观船对齐，不在可靠性船里改皮肤 |

### 4.2 信息架构：不要加第五个顶级入口

施工 Prompt 写「对话 / 会话任务 / 设备 / 设置」。对照现状：

| 端 | 实际 IA | 判定 |
|---|---|---|
| Android / iOS | 会话列表就是家；设备藏在设置 | **正确。** 设备不够常用，不该占底栏。把「进行中 / 待审批」做成列表行状态，不要新 Tab。 |
| Mac | Dashboard 开新任务 + Rail 管会话 + Fleet 页签 | **允许例外。** 桌面要同时看项目、CLI、窗口。Fleet 已是工作区页签，不要再叠导航。 |
| Harmony | 本机 / 远程 顶栏 | **正确。** 这就是瘦控制面该有的两个动词。 |

禁止：新底栏、能力市场、形象、额度、把首页改成三张主动卡仪表盘（Phase 7 最多三张卡，也只能挂在现有家页空状态上）。

### 4.3 现在真正碍事的 UI 债

按「用户每天撞几次 × 修复成本」排序：

1. **设置不可发现**  
   Android 长列表无搜索；Harmony 十五页全靠滚；能力（CLI、Skills、MCP、身体）都埋在第三四层。iOS 已证明「五组 + 搜索」能活。
2. **任务状态不在家页**  
   远程进行中、待审批仍主要在舰队页。`ANDROID-OPTIMIZATION-PLAN` 已写「远程会话未并入本机列表」。用户要记住去另一个房间看自己的任务。
3. **四端用词和颜色不齐**  
   对照表在仓库里，界面上没完全落地。Harmony 橙红会让「同一产品」的记忆断开。
4. **繁中和无障碍是半成品**  
   Android zh-TW 约一半；iOS 无繁中选择；Harmony 无障碍 API 未见；Android 大量装饰图标 `contentDescription = null`。
5. **死控件和隐藏能力**  
   iOS 17 以下 Live Activity 死按钮；Android `TODO(webapp-hidden)` 藏起「加到主屏幕」；Mac 另有一套空的升级弹窗。
6. **Mac 主控台残留「用量」语义**  
   `ABSORB-PLAN` C6：UsageCenter 容易看成额度回魂。应改名或折进折叠，不是再做账单。

### 4.4 每端布局合同（后续所有 Phase 都要守）

**窄屏（iPhone、Fold 封面 1080×1728、Harmony 竖屏）**

```
[ 会话列表 ]
  进行中 · 待审批 · 今天 · 更早
  主按钮：新任务
  次入口：设置（齿轮，不占底栏）

点进一条
[ 聊天 ]
  顶：本机 / 远程机器名 + 模型或 CLI 芯片（用户词，不写 harness）
  中：消息、工具卡、交付物
  底：输入、语音、附件
```

**宽屏（iPad、Fold 展开 1768×2208、Harmony 横屏）**

```
[ 列表 | 聊天 ]
封面/竖屏禁止左右分栏。Harmony 0.3.0-alpha.8 已修过「按内屏宽度强行分栏」，不能回退。
```

**Mac**

```
[ Session Rail | 工作区（聊天/文件/终端/Git/浏览器/舰队） ]
无项目时才落 Dashboard。Dashboard 只负责「开一条新任务」，不堆监控。
```

**审批**

所有端同一张卡语义：做什么、在哪台机器、允许一次 / 本会话 / 拒绝。不弹系统 Alert 套娃。杀进程后不能显示「已完成」。

**设置**

只保留四组：我的设备、Agent（供应商/技能/记忆/MCP/CLI）、外观与通用、数据与关于。Android 补搜索。新增能力进已有组，禁止新顶级分组。

### 4.5 UI 阶段怎么嵌进发版（不单开「视觉翻新 Phase」）

| 发版 | 允许的 UI 改动 | 禁止的 UI 改动 |
|---|---|---|
| Phase 0 | 无 | 任何视觉 |
| Phase 1 | 用语对齐、Android 设置搜索、家页显示进行中/待审批计数、CHANGELOG 补齐、死按钮删除 | 换主题、换 Harmony 强调色、重做聊天气泡 |
| Phase 2 | 路由结果用一句话人话（「已用系统相册，未打开界面」），不新增设置页 | 路由调试面板进正式 UI |
| Phase 3 | Power 确认/扫描/逐项结果表 | Standard 露出 Power 文案 |
| Phase 4 | 窗口/快照状态进 Mac 工作区，不进手机首页 | 手机上做窗口缩略图墙 |
| Phase 5 | Shortcuts / 文件授权用系统表 | 新「Shell 中心」Tab |
| Phase 6 | 配对、恢复、缺口用现有舰队页 | 新「协议」设置页给用户看 |
| Phase 7 | 家页最多三张主动卡 | 仪表盘化 |

---

## 5. 重排后的列车（仍然是 Prompt 的 0–8，只补入口和停损）

### Phase 0 · 瘦身基线（不发用户功能）

**用户结果：** 无。内部得到四表 + 主实现定义 + 体积/冷启动/内存数字。

**源码边界：** 只读 + 文档。不对不确定引用盲删。

**必须点名的主实现：**

- Provider 配置：各端现有 Store；失败不得回空
- Agent Loop：每端一条主循环
- 审批：现有三档语义
- Relay：leocodebox `relay-client` + 各端 Fleet；leoagent 标为有界回退
- CLI：Android `CliChatEngine` / Mac provider list；禁止第三套方言
- Shell/Offload：iSH / PRoot+Offload / Harmony 无沙箱

**替换/删除：** 只标记。候选：Mac 空的 `VersionUpgradeModal` 路径、Android 隐藏 WebApp 死入口、iOS 17 以下死按钮、未再引用的旧 release-notes 实现（iOS 已删过一份）。

**停损：** 发现「删了会断未知调用」就停在标记，不删。

**验收：** 四表进 `docs/superpowers/specs/`，带文件路径。没有版本 bump。

### Phase 1 · 可靠性定向吸收（第一艘用户船）

**一个可见能力：** 对话、读文件、语音更稳；配置不会被读失败抹掉。

**吸收：** OpenMinis Thinking Rules / Vision Group / 流式超时 / 配置保护 / `file_read.next_offset` / Silero VAD 与录音时暂停朗读。只摘文件，整仓不合。

**必须替换/删除：** 各 Provider 重复推理规则、重复流结束判断、调用方自写文件分页。

**UI 必须一起做：** C5 用语落地；Android 设置搜索；会话列表出现进行中/待审批；补 iOS 1.24.1 与 Mac 1.74.2 的 CHANGELOG 顶栏（历史债，本船顺手还清）。

**不在本船：** Action Router、规则引擎、窗口绑定、协议改版、本地模型。

**建议版本（实现时再定）：** Android `1.0.0-alpha.14`，iOS `1.24.2`，Mac 仅当本船改到桌面才 bump，Harmony 仅当对账出 bug 才 bump。

**定向测试：** 慢模型 120s 内不假死；长文件连续 `next_offset` 行号连续；录音时 TTS 停；读库失败后供应商还在；Fold8 封面/展开列表状态还在。

**停损：** 某 Provider 方言对不上就只修那一家，不「统一重构」所有 Provider。

### Phase 2 · Action Router（第二艘，丝滑最大值）

**一个可见能力：** 能用系统 API 完成的事不再打开别人的界面。

**实现位置：** 现有 Agent Loop **前面** 一道最小决策，不是新框架。

**路径：** Native Tool → Phone UI → Local CLI → Mac Body。  
**模式：** Fast 1–3 步；目标模糊才 Reasoning。

**删除：** 调用方里「先截图再猜」的默认路径。

**验收：** 原生可完成任务不进 GUI；抽 20 个基础任务平均步数降 ≥25%；路径不循环。

**并行：** 开始 Phase 8 的 30 题本，但不写进「本次更新」当卖点。

### Phase 3 · Android Phone Action 2.0（必须砍瘦）

**一个可见能力：** Power 上「先扫描、再计划、确认、逐项结果」。

**保留：** Selector + Conditions + Action + SuccessSelector + RiskLevel。  
**砍掉本船不做：** 规则订阅商店、签名服务器、插件 SDK、桌面/锁屏主动卡（那是 Phase 7）。

**红线：** Standard 零 Power 文案；删除/发送/安装/授权/支付必确认；连续重复两次停；屏幕三次无变化恢复。

**吸收边界：** 学 GKD selector / SD Maid 四段事务 / App Manager Runner 分层。不复制品牌，不把 GPLv3 规则集当默认内置包。

### Phase 4 · macOS Exact Window Body

**一个可见能力：** 操作绑到 `machine + app + pid + window_id + snapshot_id`，不用旧截图连点。

**同时：** Codex Queue/Steer/Worktree/Diff 只接现有审批面。手机接管不重启任务。

**删除窗口：** 新主路径绿 14 天后，才收敛 `src/mac/leoagent/` 重复 Harness。

### Phase 5 · iOS Apple ShellBridge v2

**一个可见能力：** 授权过的文件夹跨启动还在；Shortcuts 能丢文件/文本进来并拿回结果。

**轻命令走 Extension，** 要 iSH/模型/浏览器才唤起 App。

**不在本船：** 换掉 iSH、做第二个终端产品。

### Phase 6 · Relay Protocol v2

**一个可见能力：** 断线后续上，重复事件不把状态倒回去；新设备扫短码即可，不必理解共享 Key。

**必须先有：** Android/iOS/Mac Golden Fixtures。Harmony 跟着消费，不发明第五种方言。

**迁移：** 新设备优先设备密钥；旧共享 Key 兼容一整版；迁完再停签。

**不在本船：** 团队、多租户、社交。

### Phase 7 · 可选本地快脑

只做意图/风险/路由/短摘要/无网原生动作。270M–2B，按需下载，可删，可校验。  
主动卡最多三类，挂在现有家页，不新开仪表盘。  
系统 Foundation Models（iOS LocalBrain）优先于自带权重。

### Phase 8 · 评测与可销毁设备

从 Phase 2 旁路起。30 题：10 原生 / 8 规则 / 4 视觉 / 4 CLI / 4 Mac。  
VirtualBuddy / vphone-cli 只上专用测试 Mac。不写进用户「本次更新」。

---

## 6. 热更新与体积红线（沿用 Prompt，落到现仓）

允许热更新：Skills ZIP、Android 声明式 App Rules、模型目录、Thinking Rules、帮助文档、用户可见的本地权重。

禁止：DEX/SO、IPA 可执行、HAP Ability、Electron 主代码、新权限、未签名脚本、绕过确认的规则。

现仓已有 Skills / MCP / 模型列表，不要另做第二套商店。Manifest 字段按 Prompt 的 `schemaVersion=1`，但 **Phase 1 不实现热更新管道**。没有规则引擎就不要先挖管道。

预算（相对本阶段基线，实现时实测填数）：

- Android APK ≤ +8%
- iOS/macOS 包 ≤ +10%
- 冷启动退化 ≤ 10%
- 空闲内存退化 ≤ 15%
- 无任务时不得常驻本地模型、浏览器、PRoot、高频轮询

---

## 7. 明确永远不做

来自施工 Prompt + `ABSORB-PLAN` 形态锁，合并为一张表：

- 整仓 merge OpenMinis / 换 Kotlin 底座 / iOS 上 AutoGLM 或 ADB
- Mobilerun Python/ADB Portal、HAPI 整套、图数据库、第二 Agent Runtime
- 把 iPhone 降成纯节点；没装本 App 的安卓远程控
- 首页仪表盘、形象、商店、额度、托盘常驻
- 本地 8B/9B、权重打进 APK/IPA
- 热更新下发可执行代码
- 为发版绕过 `InstallIOSRelease.sh` / Android 双 flavor 门禁 / Mac 公证

---

## 8. 第一轮（Phase 0→1）施工步骤

实现未授权。下面只作为下一 Agent 的边界，仍是 5–8 步。

1. **证据基线（Phase 0）**  
   跑施工 Prompt 的 preflight；记下四端版本、包体（若本机有上一产物）、冷启动只能写「待真机」。产出四表。
2. **对账上游，不整段搬运**  
   实时看 OpenMinis 的 Thinking Rules、Vision Group、file_read、VAD、配置保护。只列要摘的文件和差异。
3. **先修共享根因**  
   配置读取失败保护、流式首包超时、file_read 契约。各端改一处主函数，不给每个 Provider 打补丁。
4. **语音与推理规则对齐**  
   录音停朗读；短语音累积；iOS 规则可被 Android/Mac 远程请求带走。
5. **UI 合同最小集**  
   用语、Android 设置搜索、列表上的进行中/待审批、删除已确认的死按钮。不改气泡皮肤。
6. **定向验证**  
   单元测试 + 至少一台真机/模拟器走完「慢流、长文件、语音、配置还在、折叠不断页」。
7. **发版材料**  
   只在用户说「做完发版 / 提交推送」之后：bump、写本次更新、CHANGELOG、README、门禁、push、tag。
8. **停**  
   不开始 Phase 2。

---

## 9. 发布与仓库卫生（实现阶段才执行）

- 未知本地改动属于用户，禁止 `reset --hard` / 自动 stash / clean
- 当前要求主仓直接交付时不新建功能分支
- Android 改 `main` 公共层必须 Standard + Power 都验
- 协议改动至少两个消费端
- tag 必须指向已验收提交；禁止上传后再用同版本重构建替换
- 本文件是分析稿，**现在不要 commit，除非用户明确说提交文档**

---

## 10. 下一阶段建议（不提前实现）

用户点头本总纲后，下一会话只做 Phase 0 四表，或直接按方案 B 做 Phase 0+1 连续施工。  
Phase 2 的接口、配置、空 UI 一律不准预埋。

---

## 11. 需要你拍板的一件事

第一艘用户可见船，是：

**B1. 可靠性 + 用语/设置可发现性（推荐）**  
还是  

**B2. 跳过 Phase 0 文档，直接改 Phase 1 代码**  
还是  

**B3. 你指定另一端优先（只做 Android / 只做 iOS / 只做 Mac）**
