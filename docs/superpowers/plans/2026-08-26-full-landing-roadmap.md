# LeoPhoneAgent 全部落地施工总计划（发版列车 T0–T8）

日期：2026-08-26  
状态：**施工就绪**。本文是「完整升级施工 Prompt」的落地版：Phase 0–8 全部要做，但拆成 9 艘船按顺序发完，每艘船一个用户可见能力。  
基线：`main @ cc033829`，Android `1.0.0-alpha.13` / iOS `1.24.1 (95)` / Mac `1.74.2` / Harmony `0.3.0-alpha.14`  
前置分析：`docs/superpowers/specs/2026-08-26-full-upgrade-feasibility.md`（现状证据、重复实现清单、UI 债都在那份，本文不重复引用原文）

## 怎么用这份计划

每开一轮施工，把「完整升级施工 Prompt」发给施工 Agent，并指定：

```
CURRENT_PHASE   = 本文的某一艘船（T0…T8）
TARGET_PLATFORMS = 该船涉及的端
RELEASE_REQUIRED = 除 T0 外均为 true
DEVICE_TARGETS   = Fold8 / iPhone / 指定 Mac / Harmony 真机
```

铁律不变：一船一个可见能力；只增不减不验收；发版必须 bump + 本次更新真实弹出 + CHANGELOG/README/digest 一致；未知本地改动属于用户。

---

## 0. 相对原 Prompt 我做的三处优化

1. **加了一艘专门的 UI/设计语言船（T2.5）**。原 Prompt 把 UI 散在各阶段，四端不一致（Harmony 橙红、繁中半成品、无障碍缺口、设置深埋）永远排不上队。集中一船清完，此后所有船只做增量 UI。
2. **Phase 8 评测基建不占船位**，从 T2 起旁路建设，每船的验收题从题库里抽，不写进用户「本次更新」。
3. **给每艘船写死了停损和回退**，防止「全部落地」在中途变成「一次落地」：任何一船超停损，只砍该船范围，不动列车顺序。

---

## 1. 列车总览

| 船 | 对应 Phase | 用户可见能力（一句话） | 端 | 版本动作 |
|---|---|---|---|---|
| T0 | Phase 0 | 无（内部四表+基线数字） | 全 | 不 bump，不发 |
| T1 | Phase 1 | 对话/读文件/语音更稳，配置不再被抹掉 | Android+iOS 主，Mac/Harmony 对账 | Android alpha.14、iOS 1.24.2 |
| T2 | Phase 2 | 能用系统 API 办的事不再打开别人的界面，步数明显变少 | Android+iOS | Android alpha.15、iOS 1.25.0 |
| T2.5 | UI 合同 | 四端看起来、说起来是同一个产品；设置能搜到一切 | 全 | 四端各 bump 一次 |
| T3 | Phase 3 | Power：先扫描、再计划、确认、逐项结果、可回滚 | Android | Android alpha.17（T2.5 已占用 alpha.16） |
| T4 | Phase 4 | Mac 操作绑精确窗口，后台不误点；手机接管不重启任务 | Mac 主，iOS/Android 消费 | Mac 1.75.0、iOS 小版本 |
| T5 | Phase 5 | iOS 文件夹授权跨启动保留；捷径丢文件进来直接出结果 | iOS | iOS 1.26.0 |
| T6 | Phase 6 | 断线续上不丢不重；新设备扫码即配，不再理解共享 Key | 全 | 四端各 bump |
| T7 | Phase 7（可选） | 无网也能听懂意图并执行原生动作；家页最多三张主动卡 | Android+iOS | 各 bump |
| 旁路 | Phase 8 | 无（30 题评测跑在每船验收里） | 基建 | 不发 |

顺序依赖：T1→T2→(T2.5 可与 T3 并行准备)→T3→T4→T5→T6→T7。T4 与 T3 错开端别，可流水线：T3 施工时 T4 做 Mac 侧证据基线。

---

## 2. 各船施工卡

### T0 · 瘦身基线（不发版）

**产出**（全部进 `docs/superpowers/specs/`）：
- 保留 / 替换 / 删除 / 延期四表，逐条带文件路径（起点直接用可行性文档 §2.2 的重复清单：file_read 三份、配对编解码三份、Thinking 三套、Voice 四套、Android Loop 三入口、Mac 双 Harness、Mac 双升级弹窗）。
- 唯一主实现定义：Provider 配置 Store、每端一条 Agent Loop、审批三档语义、leocodebox relay-client 为中继主路径（leoagent 标记有界回退，T4 后收敛）、Android `CliChatEngine` 为 CLI 主方言层。
- 基线数字：四端包体（本机能构建的实测，不能的标「待真机」）、Fold8/iPhone 冷启动、空闲内存、20 个样例任务平均步数（为 T2 的 ≥25% 下降做基准）。

**停损**：不确定引用的一律只标记不删。T0 全程零行为变更。  
**完成定义**：四表 + 基线进仓库文档；`git status` 干净（文档 commit 需用户点头）。

---

### T1 · 可靠性船（Phase 1，第一艘用户船）

**一个可见能力**：慢模型不假死、长文件连续读、语音不丢字、供应商配置读失败不清空、推理档跨端带走。

**吸收**（对上游 OpenMinis 实时对账后只摘文件）：
- Thinking Rules / Model Release Index：iOS 硬编码 `ThinkingLevelCatalog` → 可编辑规则；换模型档位夹紧且可见、切回恢复；远程请求首条带 thinking/effort（补 `ABSORB-PLAN` B1 三块）。
- Vision Group 读图委托（B2）：非视觉模型把图交给指定视觉模型，回复注明谁看的；没配就明说。
- 流式首包超时对账（B5）：Android 30s→120s；iOS 已 600s 不动；结论写进 CHANGELOG。
- Provider 读失败保护（B6）：先对账 iOS `ProviderConfigStore` 与 Android 对应路径，确认有坑再修，禁止顺便重构。
- `file_read` 真实行号 + `next_offset`：三端契约统一（Android `FileReadTool.kt` / iOS `AIChatViewModel+FileTools.swift` / Harmony `LocalTools.ets`），共享 Golden 用例。
- 语音：Silero VAD、短语音累积、录音时暂停朗读、系统 TTS 音色（Android `SpeechRecognitionManager`/`TextToSpeechManager`，iOS `VoiceProvider`）。

**必须替换/删除**：各 Provider 重复推理规则、重复流结束判断、调用方分散的文件分页逻辑。交付报告必须列出删掉的路径。

**随船 UI（最小集，不换皮肤）**：
- `COPY-TABLE` 用语落地：新任务/本机/远程/进行中/审批，四端界面词一致；Android 设置里硬编码中文改 `stringResource`。
- Android 设置加搜索（iOS 五组+搜索已验证可行，照抄交互不照抄实现）。
- 会话列表行显示「进行中/待审批」状态（Android 把远程会话计数带进本机列表头部，先计数后合并，完整合并留给 T6）。
- 补 CHANGELOG 历史债：iOS 1.24.1、Mac 1.74.2 顶栏条目。

**验收门禁**：test_matrix 的 Android（双 flavor 全链）+ iOS（三审计脚本 + MinisLogicTests）+ 真机：Fold8 封面/展开、慢流 120s 不假死、长文件 `next_offset` 行号连续、录音时 TTS 停、读库失败后供应商还在、首启弹 alpha.14/1.24.2 更新。  
**停损**：某家 Provider 方言对不上只修那一家；语音某端搞不定就把那端从本船范围里砍掉写明，不拖船期。

---

### T2 · Action Router（Phase 2）

**一个可见能力**：`把这张图存进相册`、`定个明早 8 点闹钟` 这类事直接原生完成，聊天里一句人话说明走了哪条路，不再截图乱点。

**实现**：现有 Agent Loop **前面**一道最小路由决策（Android `ChatViewModel` / iOS `AIChatViewModel` 各一处入口），四路径：Native Tool → Phone UI → Local CLI → Mac Body；两模式：Fast（1–3 步确定性）/ Reasoning（跨 App 或目标模糊才起计划）。不新建第二套 Agent Framework，路由决策本身用现有模型调用，不引本地模型（那是 T7）。

**吸收边界**：Mobilerun Manager/Executor/Fast 只学结构；ToolCUA 只学 GUI vs 原生工具选路评估法。零 Python/ADB。

**删除**：调用方里「默认先截图再猜」的路径；把散在工具里的「能不能原生做」判断收进路由一处。

**UI 允许**：路由结果一句话（「已用系统日历，未打开界面」）；聊天顶部芯片显示当前路径。禁止路由调试面板进正式 UI、禁止新设置页。

**验收**：T0 基线的 20 题 + 新增 10 题跑通；平均步数较 T0 基线降 ≥25%；原生可完成任务 0 次进 GUI;路径间无循环（同任务路径切换 ≤2 次）；路由错误率 <5%（人工判 30 题）。  
**旁路启动 Phase 8**：30 题题库（10 原生/8 App 规则/4 视觉/4 CLI/4 Mac）进 `docs/eval/`，记录成功率、步数、首动作、Token、选路、重复动作、接管、越权。  
**停损**：iOS 系统 API 面比 Android 窄，iOS 侧只接 EventKit/Photos/Reminders/Shortcuts 四类，不硬凑对等。

---

### T2.5 · 设计语言与四端一致船（新增）

**一个可见能力**：四端同一个产品脸：同一强调色体系、同一用语、同一设置结构、繁中完整、无障碍达标、死按钮清零。

**范围**：
1. **色彩**：Harmony 强调色从橙红 `#E85030` 对齐青绿系（iOS 系统青绿 / Android `#2E8B8B`/`#4DD9D9` / Mac HSL 175°）；四端深浅模式对照表进 `docs/DESIGN-TOKENS.md`。
2. **设置四组统一**：我的设备 / Agent / 外观与通用 / 数据与关于。Android、Harmony 重排到这四组；新增能力只准进已有组。
3. **繁中**：Android zh-TW 从 ~46% 补到 100% 且语言选择器加繁中；iOS `Localizable.xcstrings` 补 `zh-Hant` 并开放选择；Harmony 把写死简中抽到资源层（可先只做抽取+简中，繁中跟 Android 词表走）。
4. **无障碍**：Android 装饰图标 `contentDescription` 清理（装饰性显式 null 合规、功能性补标签）、TalkBack 走查主链路；iOS 已有基础，回归即可；Mac 主表面补 aria-label；四端 Reduced Motion 检查。
5. **死控件清零**：iOS 17 以下 Live Activity 死按钮删除或替换静态文案；Android `TODO(webapp-hidden)` 三处要么恢复入口要么删码；Mac 空的 `VersionUpgradeModal` 路径按 T0 标记结论处理；Android 设置 About 行 onClick 接通。
6. **布局合同回归**：窄屏单列（Fold 封面、Harmony 竖屏禁分栏）、宽屏双栏、字体 200%、键盘遮挡，四端各过一遍。

**明确不做**：重做聊天气泡、改 Mac 工作台形态、新增任何顶级导航、动效系统重写。

**验收**：四端截图对照（同一任务同一用词同一色）；`verifyChineseResources`/`verifyChineseSettingsStrings` 过；iOS `IOSVisibleControlAudit`/`IOSAccessibilityMotionAudit` 过；Mac `visibleControls.test` 过；Harmony `verify_harmony_release_notes` 过；TalkBack/VoiceOver 主链路人工走查记录。  
**停损**：Harmony 资源层抽取若动到太多页面，允许分两船（先色彩+用语，后资源层），但两船都在 T3 结束前发完。

---

### T3 · Android Phone Action Engine 2.0（Phase 3，砍瘦版）

**一个可见能力**：Power 版对系统级批量操作（安装/卸载、权限、冻结、清理、批量文件）执行「只读扫描 → 计划 → 风险分级确认 → 执行 → 逐项结果 → 可回滚」。

**两个模块**：
1. **App Rules Engine**：`Package + Activity/Window + Selector + Conditions + Action + SuccessSelector + RiskLevel`；高级 Accessibility Selector（学 GKD 选择器语法，不搬品牌/订阅），快照/节点树审查工具（开发者向，藏在日志页），规则带来源/版本/签名/失效时间，执行后 SuccessSelector 验证，规则失败只降级模型一次。
2. **Power Operation Transaction**：`CapabilityCheck → ReadOnlyScan → Plan → Risk → Confirm → Execute → PerItemResult → Rollback`（学 SD Maid 四段式 + App Manager Runner 分层，进 Power 高权限边界）。

**随船热更新管道（第一次落地，只服务规则）**：按 Prompt 的 Manifest（schemaVersion/sha256/signature/minAppVersion/rollbackTo…），HTTPS+allowlist、签名验证、staging 原子替换、Last Known Good、失败自动回滚一次、用户可手动停用。**只下发声明式规则与目录，永不下发代码。**

**红线**：Standard 零 Power 文案/入口；删除/发送/安装/授权/支付永远确认；连续重复动作两次停止；屏幕三次无变化进恢复；`WhatsNewGateTest`、双 flavor、固定签名指纹照旧。

**明确不做**：规则订阅商店、社区规则源、插件 SDK、桌面/锁屏主动卡（T7）、8B 模型视觉点选。

**验收**：Fold8 真机全套（封面/展开/中途折叠、Assist、Logcat）；Accessibility/Shizuku 拒绝、服务死亡、恢复、升级后授权残留四态；一次真实批量操作（如冻结 3 个 App）完整走事务并回滚成功；Standard 包 `apkanalyzer` 确认无 Power 类。  
**停损**：Selector 引擎若两周内达不到「对 3 个目标 App 稳定命中」，先船载 5 条手写规则发版，引擎泛化留 T3.5。

---

### T4 · macOS Exact Window Body（Phase 4）

**一个可见能力**：Mac 上的操作绑定 `machine + app + pid + window_id + snapshot_id`，后台窗口操作必须有新鲜快照，每步后重观察；手机接管 Mac 任务不重启会话。

**实现**：
- 窗口寻址与快照（学 Peekaboo 的寻址与后台操作政策，MIT 可参考代码）；Accessibility/Menu 优先，坐标兜底。
- Codex app-server 接入 Queue/Steer、Worktree 隔离、Diff/审批（学 CodexMonitor 交互，只吸收协议层）；审批走现有 `useSessionApprovals` 面，不开新 UI。
- 手机侧（iOS/Android 舰队页）显示窗口级任务状态，消费新事件即可，不做窗口缩略图墙。

**收敛**：新主路径稳定 **14 天**后，删 `src/mac/leoagent/` 重复 Harness（保留协议兼容说明），这是全列车最大一笔「减法」。

**验收**：Mac 真机：打开项目→CLI 任务→审批→停止→恢复→Diff→接管全链；后台窗口操作在快照过期时拒绝执行并说明；`npm run` 全套门禁 + 公证链（若发公开版）。  
**停损**：Peekaboo 式后台操作若与现有屏幕权限冲突，先只做前台精确窗口，后台留 T4.5。

---

### T5 · iOS Apple ShellBridge v2（Phase 5）

**一个可见能力**：授权过的文件夹（Security-Scoped Bookmark）跨启动仍可用并成为 Workspace；捷径能丢文件/文本/选模型进来，轻命令在 Extension 直接出结果，需要 iSH/浏览器才唤起主 App。

**吸收**：a-Shell 的 Bookmark 与双执行路径（BSD-3）、Blink 的 SmartKeys/弱网会话思路（GPLv3 只学交互）、Actions 的捷径动作粒度命名（只学产品）。  
**同船**：模型配置安全导入/导出（不含 OAuth/订阅凭据）；多 Shell 会话切换；硬件键盘。  
**明确不做**：换 iSH 底座、做第二个终端 App、Mosh 全套。

**验收**：真机重启后 Bookmark 仍可读写；捷径「文本→摘要→返回」不开 App 完成；`InstallIOSRelease.sh` 唯一入口；VoiceOver/DynamicType 回归。  
**停损**：Extension 内存顶不住的命令列白名单外，明说「此命令需打开 App」。

---

### T6 · Relay Protocol v2（Phase 6）

**一个可见能力**：断网重连后事件续上（`resume=ok/gap`）不丢不重、状态不倒退；新设备扫短码即入列，不再手配共享 Key；远程会话真正并入本机会话列表（补 `ANDROID-OPTIMIZATION-PLAN` 未完成项）。

**先行工程**：Android/iOS/Mac Golden Fixtures 三端对拍（配对编解码三份实现先对齐再改）；Harmony 只消费不发明方言。  
**协议内容**：`protocolVersion+capabilities` 握手、每 Hub/订阅独立 Cursor、Session Patch 版本水位、JWT 单飞刷新、每设备身份+短期二维码配对、持久 Outbox、中继只传密文（学 HAPI 客户端合同思路独立实现，学 Murmur 每设备身份，不复制平台）。

**迁移纪律**：新设备优先设备密钥；旧共享 Key 兼容一整个版本周期；四端都迁完才停签。发船前提：Mac 1.74.x 稳定性红利已吃满（重连风暴类 bug 30 天未复发）。

**验收**：乱序/重放/断线三类 Fixture 全绿；两消费端（iOS+Android）真机断网 2 分钟重连续传；旧版 App 对新中继仍可用（兼容期内）；文件互传/剪贴板若排进本船，走同一密文通道。  
**停损**：任何一端迁移卡住，全列车停在双栈兼容态，不允许「先停旧签再修」。

---

### T7 · 本地快脑与主动表面（Phase 7，可选船）

**一个可见能力**：无网时能听懂「打开手电筒/记个待办」并原生执行；家页出现至多三类主动卡（正在执行/等待审批/最可能需要的动作）。

**边界**：270M–2B 只做意图/风险/路由/语音纠错/短摘要；**按需下载、可见可删可校验**（走 T3 的热更新管道，type=model-weights）；iOS 优先系统 Foundation Models（LocalBrain 已有），不带自有权重；无任务时模型必须卸载出内存。  
**明确不做**：长文、深研、复杂 GUI 计划、8B/9B、首页仪表盘化、Smartspacer 式插件生态（只学 Requirements 条件引擎思路）。

**验收**：飞行模式下 5 条原生指令成功；空闲内存较 T6 基线退化 ≤15%；冷启动 ≤10%；主动卡可整体关闭。  
**停损**：路由收益（T2 指标）若已足够、快脑收益 <5% 步数改善，本船只发主动卡，模型部分记入 D 档。

---

### 旁路 · Phase 8 评测与可销毁设备

- T2 起建 30 题题库与记录格式；每船验收从题库抽题并回写结果，形成趋势线。
- 设备矩阵：Fold8 封面/展开/中途切换、iPhone/iPad、三台 Mac、Harmony 真机；异常矩阵：网络切换、进程被杀、CLI 授权过期、Provider 慢首包、无 Accessibility 节点、敏感动作停止。
- VirtualBuddy / vphone-cli 只装专用测试 Mac（放宽 SIP 的机器与日常开发机隔离）。
- 永不写进用户「本次更新」。

---

## 3. 全程红线（每船交付报告都要对照）

- 包体：Android 单船 ≤ +8%；iOS/macOS ≤ +10%；冷启动退化 ≤10%；空闲内存 ≤15%。
- 无任务时不常驻：本地模型、浏览器、PRoot、高频轮询。
- 轨迹/截图/日志有上限、自动清理、用户可手动清。
- 每船「本次更新」四端事实源 + 首启真实弹出 + CHANGELOG 根因 + README 徽章/哈希一致。
- Android 双 flavor、固定签名指纹、覆盖安装；iOS 唯一装机入口 `InstallIOSRelease.sh`；Mac 公证链完整；Harmony 签名后才 `hdc install`。
- 永远不做清单沿用可行性文档 §7（整仓 merge、第二 Runtime、商店/形象/额度、热更代码、绕闸门）。

## 4. 里程碑出口标准（列车级）

| 检查点 | 通过标准 |
|---|---|
| T1 出口 | 慢流/长文件/语音/配置四类可靠性缺陷清零；四端用词一致；步数基线已建 |
| T2.5 出口 | 四端截图放一起认不出「哪端是后妈养的」；繁中/无障碍审计绿 |
| T3+T4 出口 | 手机与 Mac 都有「先扫描后确认可回滚」的高危操作面；leoagent 已删 |
| T6 出口 | 任意端断线重连不丢不重；远程会话住进本机列表；共享 Key 退役 |
| 全列车 | 30 题成功率对 T0 基线提升可量化；包体/冷启动/内存未破红线 |

## 5. 现在就能开工的动作

1. 用户点头本计划 → commit 两份文档（本文 + 可行性 spec）。
2. 下一施工会话：`CURRENT_PHASE=T0`，产出四表与基线数字（1 轮内完成，不发版）。
3. 紧接 `CURRENT_PHASE=T1`，按本文施工卡执行并发第一艘船。
