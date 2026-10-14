# 协议兼容台账:iOS ↔ 中继 ↔ Mac

> 状态:2026-10-14 · 对应 iOS 1.68.0(开发中)/ Mac 1.9.0 / 中继 0.2.1。
> 用途:列出手机远控链路上**每一个**为旧版本、旧部署或另一种实现而存在的兼容垫片——它为什么在、没有它会怎样、怎么检测、什么条件下可以删。
> 不是设计文档;设计见 `docs/specs/ios-device-routing.md`。

## 范围

- 覆盖:iOS(`src/ios/Agent/Gateway/`、设置页网关视图、通知 / 快捷指令 / 全自动里调用网关的几处)、中继(`src/mac/leoagent/relay.py`、`relay_client.py`)、Mac 桌面端手机桥(`.../host/leo/link/`)、本机 leoagent(`server.py`、`harness.py`)。
- 不覆盖:Android / 鸿蒙作为「中继身体」时自己的内部垫片(例如 `RelayFleetClient.kt`);只在 iOS、中继或 Mac 为它们保留了垫片时才列出。
- 版本号取自 `CHANGELOG.md`,日期取自提交记录;没有证据的版本不写。

## 怎么读

路径简写(行号取自本文写成时的源码,删垫片前请以 `grep` 重新确认):

| 简写 | 实际路径 |
|---|---|
| `GW/` | `src/ios/Agent/Gateway/` |
| `GV` | `src/ios/Views/Settings/GatewayViews.swift` |
| `IOS/` | `src/ios/` |
| `TEST/` | `src/ios/MinisTests/` |
| `LINK/` | `src/mac/leophone/packages/desktop/src/host/leo/link/`(Mac 桌面端的手机桥) |
| `PY/` | `src/mac/leoagent/`(中继 `relay.py`、`relay_client.py`、本机 leoagent `server.py` / `harness.py`) |

状态列:
- **必需** — 不是「旧版本」问题,是协议里长期存在的差异或合同,不能删。
- **候选** — 舰队(三台 Mac + 中继)全部升到「可删条件」里的版本后可以删。**先核对版本再删**,见下一节。
- **死代码** — 现行实现已经不会触发它,可直接清。

**怎么知道舰队现在是什么版本**(删候选垫片前的必做步骤):
1. 中继:`GET {中继}/relay/health` → `version`(当前源码 `PY/relay.py:52`,0.2.1)。
2. Mac:中继的在线列表 `GET {中继}/relay/api/machines` 每行带 `version`(Mac App 版本)和 `server`(`leophoneagent` = 新桌面端;注册内容见 `LINK/relayLink.ts:231`)。iOS 已把它解析进 `RelayDiscoveredMachine.version`(`GW/RelayMachinesClient.swift:8`),但目前没有任何逻辑读它。
3. 单台 Mac 的功能位:`GET /v1/capabilities` 的 `app_version`、`features.*`、`device.capabilities[]`(`LINK/bridge.ts:432`)。
4. CHANGELOG 记录的最后一次装机核对:2026-10-01 三台 Mac 均为 1.3.5、中继 0.2.1(`CHANGELOG.md` iOS 1.49.2 条目)。**1.3.5 之后三台是否都升到了 ≥ 1.6.0,本文没有证据,需要上面第 2 步实测。**

## 总览

| 编号 | 垫片 | 状态 | 删除条件(一句话) |
|---|---|---|---|
| A1 | 后续消息的 `full_auto` 只在要全自动时带 | 候选 | 所有 Mac ≥ 1.6.0 |
| A2 | 全自动被拒 → 降级逐项审批,新编号重发 | 400 分支候选 / 403 分支必需 | 400:Mac ≥ 1.6.0;403:不删 |
| A3 | 内置修复步骤(Mac 没带 `steps`) | 候选 | Mac ≥ 1.6.0 且本机 leoagent 已更新 |
| A4 | 403 带原因 ≠ 密钥被拒 | 必需 | — |
| A5 | Mac 桥:认不出调用方的 403、`strictCallers`、`mayUseFullAuto` | 候选(strictCallers 退出条件) | 中继 ≥ 0.2 全覆盖 |
| A6 | 中继转发调用方类别 `caller` / `X-Leo-Caller-Kind` | 候选 | 中继 ≥ 0.2 全覆盖 |
| A7 | Mac 桥:旧客户端的 `always` 当 `session` | 候选 | 没有任何客户端再发 `always` |
| A8 | 通知里「本次会话允许」失败回退「允许一次」 | 必需 | ACP 方言开放 `session`,且通知带 choices |
| A9 | 关全自动:旧 Mac 404/503 当作无事 + 每条消息带「关」 | 候选 | 所有 Mac/leoagent 有 `/harness/full-auto` |
| B1 | 中继 0.1 → 0.2 迁移与多主钥匙 | 候选 | 没有 0.1 数据、不再有旧钥匙 |
| B2 | iPhone 以 `legacy` 设备身份配对(`kind=legacy` 一次性码) | 必需(直到 iOS 会轮询待定配对) | iOS 实现 `join/{pendingId}` 轮询 |
| B3 | 老中继没有 `join-tokens` | 候选 | 中继 ≥ 0.2 全覆盖 |
| B4 | 配对码 v1 / v2 / 裸 JSON,「这是旧码」分支 | 候选 | 不再有 v1 码 |
| B5 | `/machines` 行的 `platform/server/version` 两种位置 | 候选 | 只剩一种形状 |
| B6 | 密钥复制残渣清洗 + 长度 ≥ 16 | 必需 | — |
| B7 | 同一中继根下多把密钥逐把试 | 必需 | — |
| B8 | `registered` 回执的 `version` / `revokedDeviceIds` / `pin` | 候选 | 中继 ≥ 0.2 全覆盖 |
| B9 | 机器专属钥匙被拒(4001)后改用注册钥匙重领 | 必需 | — |
| C1 | 续传信封 `type` / `event` 两种拼写 + 410 `min_after` | 死代码(对现行对端) | 无更早的 Android 构建 |
| C2 | `seq <= lastSeq` 去重 | 必需(纯防御) | — |
| C3 | `journal_status=1` 与 durability 帧 | 候选 | 所有后端都发 durability |
| C4 | 未知事件保真、`user.message` / `session.note` | 必需 | — |
| C5 | 引擎(Hermes)路径:无 id 的 SSE → 轮询、本地审批编号 | 必需(直到引擎入口移除) | 引擎入口移除 |
| D1 | `X-Leo-Queue` / `X-Leo-Request-Id` 离线排队 | 候选 | 中继 ≥ 0.2 全覆盖 |
| D2 | 中继排队结果查询 | 候选 | 同 D1 |
| D3 | `/operations/<id>` 回执 + `hostKeepsReceipts` | 候选 | 所有 Mac ≥ 1.3.4 |
| D4 | 回执轮询上限(无回执的旧 Mac) | 候选 | 同 D3 |
| D5 | outbox 归属的 `legacy:` 种子 | 候选 | 所有已存主机都有 `outboxIdentity` |
| D6 | 直连发出后中继失败 → 结果未确认 | 必需 | — |
| E1 | 直连 → 中继回落及其节奏 | 必需(长期设计) | — |
| E2 | 老 Mac 没有直连:授权只问不重试 | 候选 | 所有 Mac ≥ 1.3.4 |
| E3 | 直连路径白名单与能力门控 | 必需 | — |
| E4 | `relayServices` 缺失时从 harnessURL 推导 | 候选 | 所有已存主机都有 `relayServices` |
| E5 | Mac→中继的 `*.ts.net` DNS 回退 | 必需(网络层) | — |
| F1 | `server == leophoneagent` 分流(zcode / 直连发现) | 必需 | — |
| F2 | `isAndroidBody` 判定写了两份 | 必需(可收口) | — |
| F3 | Mac 桥把本机 leoagent 的 harness 并进能力列表 | 必需 | — |
| F4 | `archive` 路由 + 本机隐藏、`available` 状态 | 候选 | 所有 Mac ≥ 1.3.1/1.3.2 |
| F5 | `ssh_host_keys` 可缺省 | 候选 | 所有 Mac ≥ 1.3.5 |
| F6 | 引擎端口(8645)与编码会话端口(8647)并存 | 必需(直到引擎入口移除) | 引擎入口移除 |
| G1 | 补拉:游标修复、无 seq 指纹、`approval_id ‖ request_id` | 候选 | 无 < iOS 1.61 的游标遗留 |
| G2 | APNs `environment` 缺省 `development` | 必需 | — |
| G3 | 通知回调:无 session_id 时反查 | 必需 | — |
| H1 | `GatewayHost` 新增字段全部可选 | 必需 | — |
| H2 | `outboxIdentity` 回填 | 候选 | 同 D5 |
| H3 | `/health` 的 401/403 算「可达」 | 必需 | — |
| I1 | 中继 `/collections` 整库快照适配器 | 候选 | 没有 < iOS 1.31 的客户端 |
| I2 | 藏宝阁游标 410 → 重建快照 | 必需 | — |
| K1 | `LeoLinkProblem` 依赖的状态码与文案 | 必需(契约) | — |

---

## A. 全自动与设备身份

### A1 后续消息的 `full_auto` 只在要全自动时带
- **引入**:iOS 1.55.0(2026-10-06)。
- **没有它**:全自动关着时,对 Claude Code / Codex / Grok 的每条后续消息都带 `full_auto:false`;Mac 1.6.0 之前的桥对非 LeoPhoneAgent 任务带 `full_auto` 回 400「全自动只支持 LeoPhoneAgent 任务」(建任务路径:提交 `d9be43f9` 删掉的那一行;后续消息路径来自 iOS 注释的记录,源码里已无法复现),请求发不出去。
- **如何检测**:请求带了 `full_auto` 且被 400;或中继在线列表里该机器 `version < 1.6.0`。
- **可删除条件**:所有 `server=leophoneagent` 的 Mac `version ≥ 1.6.0`。删后 `steerValue` 可对所有 CLI 统一返回 `want`(LeoPhoneAgent 任务本来就总是带 true/false)。
- **位置**:`GW/HarnessFullAuto.swift:31`;调用 `GW/LeoAgentHarness.swift:384`;测试 `TEST/LeoAgentHarnessFullAutoTests.swift`(`testSteerValueKeepsOldDesktopCompatible`)。

### A2 全自动被拒 → 降级逐项审批,新编号重发
- **引入**:iOS 1.55.0(2026-10-06)。
- **没有它**:Mac 回 403(认不出这台 iPhone)或旧桌面回 400 时,任务 / 消息直接失败,全自动一开反而用不了。
- **如何检测**:`HarnessFullAuto.isRefusal`:请求了全自动,且状态 403,或状态 400 且 CLI 不是 `zcode`。只在 Mac **明确拒绝**时降级;超时 / 5xx / 409 是「结果未知」,永不走这条路(见 D6)。
- **可删除条件**:400 分支随 A1 一起删(Mac ≥ 1.6.0)。**403 分支不删**——它也覆盖设备身份被撤销 / 未登记这类现行的真实拒绝。
- **位置**:`GW/HarnessFullAuto.swift:39`;调用 `GW/LeoAgentHarness.swift:324`(建任务)、`:419`(发消息)、`:590`、`:609`(排队 / 回执结果);`IOS/Agent/Intents/MacFleetIntents.swift:215`(Siri / 快捷指令)。

### A3 内置修复步骤(Mac 没带 `steps`)
- **引入**:iOS 1.55.0(2026-10-06)。
- **没有它**:Mac 1.6.0 之前的 403 只有一句「认不出」,没有 `error.steps`,会话里用户不知道怎么修(要在运行中继的 Mac 上升级 `relay.py` 到 0.2、更新本机 LeoBot、再回手机重发)。
- **如何检测**:403 的 message 不含 `\n1. `(`GW/HarnessFullAuto.swift:69`)——Mac 新版把编号步骤拼进了 message。
- **可删除条件**:所有 Mac ≥ 1.6.0 且本机 leoagent 含 `d9be43f9`。然后删 `fallbackSteps` 与 `refusedNote` 的内置分支,只显示 Mac 给的步骤。
- **位置**:`GW/HarnessFullAuto.swift:54`、`:61`、`:75`(解析 `error.steps`);`GW/LeoAgentClient.swift:297`。Mac 侧同一份合同:`LINK/linkPolicy.ts:43`、`PY/server.py:54`。

### A4 403 带原因 ≠ 密钥被拒
- **引入**:iOS 1.41.0(2026-09-25)。
- **没有它**:Mac 的「设备授权已撤销」「认不出是哪台设备」被显示成「密钥被拒绝,去粘贴密钥」,方向全错。
- **如何检测**:`validate`:401,或 403 且正文没有 message → `GatewayError.unauthorized`;403 带 message → `GatewayError.http(403, message)`。
- **可删除条件**:不删(现行合同:403 带原因 = 钥匙对、但这件事不允许)。
- **位置**:`GW/LeoAgentClient.swift:278`。`LeoLinkProblem` 依赖同一约定(K1)。

### A5 Mac 桥:认不出调用方的 403、`strictCallers`、`mayUseFullAuto`
- **引入**:`strictCallers` Mac 1.2.3(2026-09-25);`legacy` / `master` 与 iPhone 同权 Mac 1.2.5(2026-09-26),`mayUseFullAuto` 在 1.3.2 成形;403 的 `code/fix/steps` Mac 1.6.0(2026-10-06)。
- **没有它**:中继 0.1 不附调用方,所有请求都是 `unknown`;若一律按「认不出」处理,连自己的 iPhone 也批不了命令;若一律放行,谁拿到 0.1 通道发一句话就能让 Mac 免审批跑命令。所以:连着 0.2(注册回执带 `version`、每个请求都附调用方)时,认不出身份的请求只能拒绝审批;连着 0.1 时调用方恒为 `unknown`,不能收紧(否则自己的 iPhone 也批不了),只是仍不能开全自动。
- **如何检测**:Mac 注册后收到的 `registered.version` 是否为字符串(`LINK/relayLink.ts:278`)。
- **可删除条件**:中继 0.1 永久退役(所有中继 `/relay/health.version ≥ 0.2`)后,`strictCallers` 恒为 true,可删开关与 `unknown` 分支。
- **位置**:`LINK/bridge.ts:101`;`LINK/session.ts:321`;`LINK/linkPolicy.ts:59`、`:49`;`LINK/bridge.ts:647`(审批 403);本机 leoagent 同合同 `PY/server.py:61`。

### A6 中继转发调用方类别 `caller` / `X-Leo-Caller-Kind`
- **引入**:中继 0.2(2026-09-24,提交 `90755585`);`X-Leo-Caller-Kind` 随 Mac 1.6.0(2026-10-06)。
- **没有它**:0.1 的中继不附调用方;Mac / leoagent 无法区分 iPhone、Android、主钥匙,只能全部当 `unknown`(见 A5)。
- **如何检测**:转发帧有无 `caller`(`PY/relay.py:1750`);leoagent 收到的请求头 `X-Leo-Caller-Kind`——没有这个头 = 直接持本机钥匙的调用方(Mac 桥自己、同 WiFi 直连),与主钥匙同等对待。
- **可删除条件**:同 A5。
- **位置**:`PY/relay_client.py:178`、`PY/server.py:49`、`LINK/leoagentForward.ts:25`。

### A7 Mac 桥:旧客户端的 `always` 当 `session`
- **引入**:Mac 1.2.0(2026-09-25)。
- **没有它**:旧客户端(或旧版通知 / 手表)回 `always`,Mac 若照字面当「永久放行」,会给 Claude Code 写入永久允许规则。桥里把它降为「本任务都允许」。
- **如何检测**:审批请求体 `choice == "always"`。
- **可删除条件**:没有任何客户端(iOS / Android / 鸿蒙 / 手表)再发 `always`。iOS 当前只发 `once` / `session` / `deny`(`GW/HarnessApprovalNotifier.swift` 的 `choice` 映射)。
- **位置**:`LINK/bridge.ts:633`。

### A8 通知里「本次会话允许」失败回退「允许一次」
- **引入**:iOS 1.44.0 第三轮审计(2026-09-26,提交 `01472c47`)。
- **没有它**:ACP 方言(`session/request_permission`)的 CLI 只开放 `once / always / deny`(`PY/harness.py:682`),对它回 `session` 被 400;通知按钮没有机会看到 choices,审批就静默失败。回退只回退到 `once`,**绝不回退到 `always`**(Claude Code 的 `always` 会写永久规则)。
- **如何检测**:`approveHarness` 回 400。
- **可删除条件**:ACP 方言也开放 `session`,**且**通知带上请求里的 choices。目前是现行差异,不只是旧版本问题。
- **位置**:`GW/HarnessApprovalNotifier.swift:167`、`:170`。

### A9 关全自动:旧 Mac 404/503 当作无事 + 每条消息带「关」
- **引入**:iOS 1.41.0(2026-09-25)的 `turnOffFullAuto`;桥(LeoPhoneAgent 任务)Mac 1.2.0;本机 leoagent(Claude Code / Codex / Grok)的 `POST /harness/full-auto` Mac 1.6.0(2026-10-06)。
- **没有它**:手机关掉全自动后,Mac 上已开的全自动任务仍免审批地跑。旧 Mac 没有这条路(404)或没配 leoagent(503)时,桥把它当「没有可关的」;leoagent 超时 / 出错回 502,让手机重试(重复关是幂等的)。手机另有两道兜底:关开关时对每台 Mac 按 0/1/5/20 秒重试四次,之后发给这台 Mac 的每条消息也会带「关」。
- **如何检测**:`POST /harness/full-auto` 回 404 / 503 / 502。
- **可删除条件**:所有 Mac ≥ 1.6.0 且 leoagent 已更新后,可删「404/503 当无事」分支;重试与每条消息带「关」是安全兜底,保留。
- **位置**:`LINK/bridge.ts:694`、`:700`;`PY/server.py:394`;iOS `GW/LeoAgentHarness.swift:139`、`IOS/Agent/Session/FullAuto.swift:41`。

---

## B. 中继身份、配对与发现

### B1 中继 0.1 → 0.2 迁移与多主钥匙
- **引入**:多主钥匙(`RELAY_KEYS`)中继 0.1(2026-08-06);0.1 `device-keys.json` 迁移中继 0.2(2026-09-24)。
- **没有它**:手机历史上存过任意一台 Mac 的旧钥匙,统一钥匙后旧钥匙全被拒;0.1 发出的设备钥匙在升到 0.2 后全部失效。
- **如何检测**:`~/.leoagent/relay-state.json` 不存在且 `device-keys.json` 存在时首启迁移;`RELAY_KEYS` 环境变量里有额外钥匙。
- **可删除条件**:没有 0.1 数据(`device-keys.json`)、所有手机已换成设备钥匙、不再需要额外主钥匙。
- **位置**:`PY/relay.py:133`、`:873`。

### B2 iPhone 以 `legacy` 设备身份配对(`kind=legacy` 一次性码)
- **引入**:中继 0.2(2026-09-24);Mac 出码 Mac 1.3.0(2026-09-26)。
- **没有它**:中继 0.2 的 `kind=iphone` 码兑换后进入「待定」,要 Mac 点允许、手机轮询 `GET /relay/api/join/{pendingId}` 才拿到钥匙。**iOS 没有实现这个轮询**(`pendingId` / `pollSecret` 在 iOS 里不存在),所以 Mac 明确要 `kind=legacy`(兑换即发钥匙)。结果:**经二维码配对的 iPhone 在中继上都是 `legacy` 设备**(设备名「旧版设备」;手工粘贴主钥匙的是 `master`),`iphone` 这个类别目前没有 iOS 客户端在用。
- **如何检测**:中继 `GET /relay/api/devices` 里 iPhone 的 `kind`;`join` 回 202 + `pendingId` 表示拿到了 `iphone` 码(iOS 会按「配对码无效」处理,见 K1)。
- **可删除条件**:iOS 实现待定配对轮询,Mac 改发 `kind=iphone`,再去掉对 `legacy` 的依赖。在此之前这是必需的,**不能把 `legacy` 当成只有 Android / 鸿蒙才有**。
- **位置**:`LINK/pairing.ts:131`;`PY/relay.py:1059`、`:1103`、`:1106`;iOS `GW/RelayMachinesClient.swift:101`(只认 `accessKey`)。Mac 侧 `legacy` 调用方类别另见 `LINK/session.ts:22`、`LINK/relayLink.ts:44`、`LINK/directGrants.ts:43`、`LINK/operationReceipts.ts:43`。

### B3 老中继没有 `join-tokens`
- **引入**:Mac 1.3.0(2026-09-26)。
- **没有它**:2026-08 之前部署的中继没有 `POST /relay/api/join-tokens`(回 404),Mac 的「连接手机」页会让用户点一个必然失败的按钮。
- **如何检测**:不带钥匙 POST 一次:401/403 = 支持,404/405 = 不支持,其余 = 说不准(`unknown`,允许用户点了再说)。
- **可删除条件**:所有中继 ≥ 0.2。
- **位置**:`LINK/pairing.ts:102`、`:137`;`LINK/index.ts:181`。

### B4 配对码 v1 / v2 / 裸 JSON,「这是旧码」分支
- **引入**:v1 随 Android 成为中继身体(2026-08-19,iOS 1.24.1);v2(带一次性码 `join` + `exp`)T6(2026-08-26,iOS 1.27.0)。
- **没有它**:v1 码只有中继根和机器名,不带 `join`——手机没法换钥匙,只能借已存在的同根密钥;裸 JSON 是早期粘贴格式。
- **如何检测**:`RelayPairPayload.parse` 按前缀 `leoagent-body:v2|` / `leoagent-body:v1|` / `{` 分流;v1 / 裸码且本机没有同根密钥时界面提示「这是旧码」。
- **可删除条件**:不再有任何端生成 v1 / 裸码。Mac 现在只出 v2(`LINK/pairing.ts:16`);Android 的 `RelayPairCodec` 需另行核对。
- **位置**:`GW/RelayMachinesClient.swift:261`、`:295`;`GV:381`。

### B5 `/machines` 行的 `platform/server/version` 两种位置
- **引入**:2026-08-20(iOS 1.24.x,PR #5 审计)。
- **没有它**:中继行历史上把 `platform/server` 放在顶层;现行 leocodebox 把它们嵌在 `info` 下。只读一种位置,Android 身体就会被误判成 Mac。
- **如何检测**:行里是否有顶层 `platform` / `server`,还是只有 `info.platform` / `info.server`;`device` 同理。中继现行写法是 `{**m.info, "name", "online", "connected_at"}`(`PY/relay.py:1698`)。
- **可删除条件**:所有注册方只剩一种形状。
- **位置**:`GW/RelayMachinesClient.swift:80`、`:213`。

### B6 密钥复制残渣清洗 + 长度 ≥ 16
- **引入**:2026-08-20 起(iOS 1.24.x,PR #5 审计)。
- **没有它**:从终端复制密钥常带上 zsh 行尾的 `%` 或换行,密钥永远被拒;过短的串被当成密钥发出去只会换来 401。
- **如何检测**:iOS 写入钥匙串前 `normalizedAccessKey` 去掉首尾空白与 `%`;中继同样容错(`rstrip("%")`);iOS 侧长度 `< 16` 当未授权,不发请求。
- **可删除条件**:不删(用户手工粘贴密钥的入口仍在)。
- **位置**:`GW/GatewayHostStore.swift:383`;`GW/RelayMachinesClient.swift:130`;`PY/relay.py:799`。

### B7 同一中继根下多把密钥逐把试
- **引入**:2026-08-20(iOS 1.24.x,`T-relay-key-fallback`)。
- **没有它**:原先按中继根去重,同一个根下只留第一台主机的密钥;`hosts[0]` 的密钥一过期,整条发现链就 401 到底,即使 `hosts[1]` 存着好钥匙也轮不到。
- **如何检测**:`RelayMachinesClient.credentials(from:)` 对「中继根 + 密钥」去重;设置页刷新时第一把成功即止,并用它覆写该根下所有机器的密钥(自愈)。
- **可删除条件**:不删。
- **位置**:`GW/RelayMachinesClient.swift:186`;`GV:261`。

### B8 `registered` 回执的 `version` / `revokedDeviceIds` / `pin`
- **引入**:中继 0.2(2026-09-24);`revokedDeviceIds` 同步到 Mac Mac 1.3.4(2026-09-28)。
- **没有它**:0.1 的回执没有 `version`(Mac 据此判断 `strictCallers`,见 A5),不认 `pin`(首次注册领取机器专属钥匙,之后名字只认它),也不下发被撤销的设备清单(Mac 的直连授权无从同步撤销)。
- **如何检测**:回执里有没有 `version` / `machine_key` / `revokedDeviceIds`。Mac 对 0.1 一律记 `"0.1"`。
- **可删除条件**:中继 0.1 永久退役。
- **位置**:`PY/relay.py:1301`;`LINK/relayLink.ts:266`、`:228`。

### B9 机器专属钥匙被拒(4001)后改用注册钥匙重领
- **引入**:Mac 1.2.5(2026-09-26,提交 `5e97b015`);中继的 4001 / 4003 关闭码随 0.2。
- **没有它**:机器被解钉、中继状态丢失、首次存钥匙没存上时,Mac 永远带着旧钥匙被 4001 拒绝,手机一直看到 Mac 离线。
- **如何检测**:WebSocket 关闭码 4001 且本机存着机器钥匙 → 下次改用注册钥匙。
- **可删除条件**:不删(恢复路径)。
- **位置**:`LINK/relayLink.ts:308`;`PY/relay.py:1281`。

---

## C. 事件流续传与日志

### C1 续传信封 `type` / `event` 两种拼写 + 410 `min_after`
- **引入**:T6(2026-08-26,iOS 1.27.0 / Mac 1.76.0 / Android alpha.18)。
- **没有它**:历史上各端对「续传游标已过期」的表达不同:SSE 首帧 `{"type":"resume","status":"gap","min_after":N}`,或 HTTP 410 + `min_after`。iOS 都认,并把游标前移到 `min_after`(只前不后)。
- **如何检测**:首帧 `type == "resume"` 或 `event == "resume"`;或 410 的正文。
- **可删除条件**:**两者对现行对端都是死代码**。`event` 拼写:Mac 只发 `type`(`LINK/resumeEnvelope.ts`),Android 同时发 `type` 和 `event`,只认 `type` 就够。410 分支:Mac 与中继都不发 410;Android 早先回 410,但经中继开的流早已回了 200、410 到不了控制端,现在改发流内的 gap 信封(`src/android/app/src/main/java/com/leoyuan/leophoneagent/relay/MinisHarnessRouter.kt` 的注释;同文件另一处文档注释仍写「回 410」,已过时)。确认舰队里没有更早的 Android 构建后即可删 `GatewayError.resumeGap` 的 410 来源与 `T6RelayLogic.minAfter(from:)`(信封来源的 `resumeGap` 保留)。
- **位置**:`GW/T6RelayLogic.swift:21`;`GW/LeoAgentHarness.swift:201`、`:215`;`LINK/resumeEnvelope.ts`;测试 `TEST/T6RelayTests.swift`。

### C2 `seq <= lastSeq` 去重
- **引入**:T6(2026-08-26)。
- **没有它**:`after` 若被某个实现按「包含」处理,重放会把最后一段 `message.delta` 重复拼一遍(正文增量是拼接的)。Mac / Android 现行都是严格大于,这个分支目前不会命中,纯防御。
- **如何检测**:事件 `seq` 不大于已渲染的 `lastSeq`。
- **可删除条件**:不删(成本为零)。
- **位置**:`GW/LeoAgentHarness.swift:811`。

### C3 `journal_status=1` 与 durability 帧
- **引入**:iOS 1.35.0(2026-09-12,当时随旧 leocodebox 的 Mac 1.85.0);现行 Mac 由 `LINK/journal.ts` 发 durability 帧。
- **没有它**:没有这个参数,后端不发日志落盘状态;界面只能显示「日志保存状态未知」。
- **如何检测**:是否收到 `type:"durability"` 帧(Mac 在每条事件前后插入,中继对不带 `seq` 的快照只保留最新一条,`PY/relay.py:1767`)。
- **可删除条件**:所有后端(Mac、Android、鸿蒙)都发 durability 帧后,「未知」状态可删。
- **位置**:`GW/LeoAgentHarness.swift:187`;`GW/T6RelayLogic.swift:46`。

### C4 未知事件保真、`user.message` / `session.note`
- **引入**:`GatewayEvent.unknown` 2026-08-05(网关首版);`user.message` / `session.note` 随新桌面端(Mac 1.2.0,2026-09-25)。
- **没有它**:更新的 Mac 发来旧 iOS 不认识的事件会被静默丢掉,用户只看到任务「卡住」。现在未知事件作为一行提示显示;`user.message`(另一端发的用户输入)渲染成回显并与本机回显去重,`session.note`(Mac 给人看的说明)只显示文字。
- **如何检测**:`GatewayEvent.parse` 落到 `default` 分支。
- **可删除条件**:不删(前向兼容)。
- **位置**:`GW/LeoAgentClient.swift:516`;`GW/LeoAgentHarness.swift:993`、`:1005`。

### C5 引擎(Hermes)路径:无 id 的 SSE → 轮询、本地审批编号
- **引入**:2026-08-05(iOS 1.8.x 网关首版,`ec36fbca`)。
- **没有它**:引擎的 SSE 帧没有 `id:`,断线后事件在服务端丢弃、无法续传,只能轮询 `GET /v1/runs/{id}` 对账;引擎的审批载荷没有 `approval_id`,本机自造 UUID;`choices` 缺省为 `["once","deny"]`(每种 choice 集合里都有这两个,靠它降级是安全的)。
- **如何检测**:主机配置了「引擎地址」(`host.url != nil`),走 `GatewayConsoleView` / `GatewayRunDriver`。
- **可删除条件**:引擎入口(设置 → Mac 控制台 →「…的引擎对话」)移除。
- **位置**:`GW/GatewayRunDriver.swift:229`(文件头注释写明原因);`GW/LeoAgentClient.swift:495`、`:497`。

---

## D. 离线排队、回执与 outbox

### D1 `X-Leo-Queue` / `X-Leo-Request-Id` 离线排队
- **引入**:iOS 1.44.0(2026-09-25)+ 中继 0.2(排队,2026-09-24;死信 / 授权修复 2026-09-26)。
- **没有它**:Mac 不在线时,建任务 / 发消息直接 502,用户的输入丢在手上;中继不认这个头的旧版本会忽略它,表现同上。
- **如何检测**:对离线 Mac 的 `POST /harness/sessions` 或 `/harness/sessions/{id}/send` 回 202 `{"queued":true}`(队列满回 429);旧中继回 502。只有这两类请求可排队(`PY/relay.py:1703`)。
- **可删除条件**:所有中继 ≥ 0.2(这个头对新中继无害,删的只是「旧中继没有排队」的假设)。
- **位置**:`GW/LeoAgentHarness.swift:132`;`PY/relay.py:1929`。

### D2 中继排队结果查询
- **引入**:iOS 1.44.0 第三轮审计(2026-09-26,提交 `01472c47`)。
- **没有它**:中继只在 Mac 上线、真正投递时才知道 Mac 的回答。不查,手机只看到「已排队」,而 Mac 若拒绝(全自动认不出发送方、任务已结束)输入就凭空消失。
- **如何检测**:`GET /relay/api/queue/{requestId}` → `queued` / `delivered`(带 Mac 的状态)/ `failed` / `expired`;中继忘记了回 404(结果留 24 小时)。
- **可删除条件**:同 D1。
- **位置**:`GW/LeoAgentClient.swift:316`;`GW/HarnessOutbox.swift:30`;`PY/relay.py:1238`。

### D3 `/operations/<id>` 回执 + `hostKeepsReceipts`
- **引入**:Mac 1.3.4 + iOS 1.49.0(2026-09-28);`hostKeepsReceipts` iOS 1.49.2(2026-10-01)。
- **没有它**:Mac 1.3.4 之前不按请求编号留回执。**会留回执的 Mac 回 404 = 它从没收到过这条**(可以明确告诉用户没送到、把原文还给输入框);**不留回执的旧 Mac 回 404 什么也说明不了**,只能保持「未确认」。所以必须先问 Mac 有没有这个能力。
- **如何检测**:`device.capabilities` 里有 `operation-receipts`(直连还要 `scopes` 含 `harness`)。
- **可删除条件**:所有 Mac ≥ 1.3.4。之后 404 一律表示「没收到」,可删 `hostKeepsReceipts`,并让 D4 的「放弃」分支只处理真正查不到的情况。
- **位置**:`GW/LeoAgentHarness.swift:570`、`:618`;`GW/LeoAgentClient.swift:326`;`GW/HarnessOutbox.swift:38`;`GW/LeoAgentRouting.swift:26`;Mac `LINK/bridge.ts:223`、`LINK/operationReceipts.ts`。

### D4 回执轮询上限(无回执的旧 Mac)
- **引入**:iOS 1.49.2(2026-10-01)。
- **没有它**:旧 Mac 无回执接口时,「正在查询 Mac 回执」会永远转圈。每条未确认输入最多查 20 轮(15 秒一轮 ≈ 5 分钟),之后把原文还给用户并写明「可能已执行」。
- **如何检测**:同一编号的回执查询连续不出结论。
- **可删除条件**:同 D3(上限仍可保留,防「Mac 一直不在线」)。
- **位置**:`GW/LeoAgentHarness.swift:566`。

### D5 outbox 归属的 `legacy:` 种子
- **引入**:iOS 1.49.1(2026-09-30 审计修复,提交 `ffe2b20d`)。
- **没有它**:此前保存的主机没有 `outboxIdentity`;升级后若凭空造一个随机归属,崩溃前写下的未确认输入就找不到主人。`legacy:` 种子由主机 id + 端点确定性算出,崩溃重启后仍能对上。
- **如何检测**:主机的 `outboxIdentity == nil`。
- **可删除条件**:所有持久化主机都已有 `outboxIdentity`(回填已落盘),再保留一个版本后删种子。
- **位置**:`GW/HarnessOutbox.swift:163`;回填 `GW/GatewayHostStore.swift:340`(同 H2)。

### D6 直连发出后中继失败 → 结果未确认
- **引入**:iOS 1.49.2(2026-10-01)。
- **没有它**:直连的 POST 可能已经到了 Mac;随后中继回落若因本地原因失败,把它报成「没送到」会让用户重发 → 重复执行。现在抛 `uncertainAfterDirectAttempt`,按「结果未知」处理,走回执核对。
- **如何检测**:`routedData` 里 `directAttempted && mutating` 且中继 / 直连都失败。
- **可删除条件**:不删(`LeoLinkProblem` 把它归为 `deliveryUnconfirmed`:不可盲重试、不暂停重连)。
- **位置**:`GW/LeoAgentRouting.swift:118`、`:126`;`GW/GatewayError.swift`。

---

## E. 直连(Tailscale)与中继回落

### E1 直连 → 中继回落及其节奏
- **引入**:iOS 1.49.0 + Mac 1.3.4(2026-09-28)。
- **没有它**:直连一断(Tailscale 没开、Mac 睡了),任务就断;现在直连失败回落到原中继地址,4xx / 业务错误视为权威答案不回落,502/503/504 才算「路由失败」。探测每 120 秒一次、失败冷却 30 秒;直连专用主机(`directOnly`)不回落,失败即抛 `cannotConnectToHost`。
- **如何检测**:直连响应 502/503/504 或连接异常。
- **可删除条件**:不删(长期设计,不是版本垫片;CHANGELOG:「保留原中继回退」)。
- **位置**:`GW/LeoAgentRouting.swift:95`、`:130`、`:50`、`:78`。

### E2 老 Mac 没有直连:授权只问不重试
- **引入**:iOS 1.49.0 + Mac 1.3.4(2026-09-28)。
- **没有它**:没开直连(或版本 < 1.3.4)的 Mac 对 `POST /direct-grants` 回 403 / 404 / 503;若每个请求前都问一遍,等于给每个请求加一次必败的往返。现在只对 `server == leophoneagent` 的主机问,失败后 300 秒内不再问,且问的是 `POST`,**发现阶段不重试任何写操作**。
- **如何检测**:`/direct-grants` 的状态码;`device.endpoints` 是否含 `kind == "direct"`。
- **可删除条件**:所有 Mac ≥ 1.3.4 后,问不通就是真实错误而不是「旧版」,可删静默吞错。
- **位置**:`GW/LeoAgentRouting.swift:56`;`GW/GatewayHostStore.swift:349`;Mac `LINK/bridge.ts:210`。

### E3 直连路径白名单与能力门控
- **引入**:iOS 1.49.0 + Mac 1.3.4(2026-09-28)。
- **没有它**:把任意请求(含只该走中继的藏宝阁、管理接口)发到直连端点;或对没有对应能力 / 作用域的 Mac 发 `/sync/v1/*`、带副作用的 POST,得到 403。
- **如何检测**:路径前缀(`/harness/`、`/operations/`、`/sync/v1/`、`/v1/capabilities`)+ `device.capabilities`(`operation-receipts`、`sync-replica-v1`)+ 授权 `scopes`。Mac 桥自己也只放行手机协议那几条(`LINK/linkPolicy.ts:15` 的 `isLinkPath`,外加 `/operations/*` 与 `/direct-grants`),其余一律 404「这个接口不对手机开放」。
- **可删除条件**:不删。
- **位置**:`GW/LeoAgentRouting.swift:19`、`:23`;`GW/DirectDeviceRoute.swift:48`。

### E4 `relayServices` 缺失时从 harnessURL 推导
- **引入**:iOS 1.49.0(2026-09-28)。
- **没有它**:此前保存的中继主机没有 `relayServices`(中继事件 / 藏宝阁入口),升级后补拉、推送登记、藏宝阁同步全部静默失效。现在缺失时从 `…/m/<机器名>` 反推中继根。
- **如何检测**:`host.relayServices == nil`,且 `harnessURL` 含 `/m/`。
- **可删除条件**:所有持久化主机都已有 `relayServices`(新增 / 发现路径总会写入)。
- **位置**:`GW/GatewayHostStore.swift:336`;`GW/LeoAgentClient.swift:193`;`GW/DirectDeviceRoute.swift:84`(注释:老 URL 解析只用于迁移)。

### E5 Mac→中继的 `*.ts.net` DNS 回退
- **引入**:Mac 1.2.1(2026-09-25)。
- **没有它**:本机开着代理(Clash TUN)时,系统解析给出代理的假 IP,Mac 与中继的常驻连接被绕到代理节点,每个来回 2~3 秒;`*.ts.net` 改用 Tailscale 自己的 DNS(100.100.100.100)解析,解析不到(没开 Tailscale / 不是 tailnet 域名)退回系统解析。
- **如何检测**:主机名以 `.ts.net` 结尾。
- **可删除条件**:不删(网络层回退,与协议版本无关)。
- **位置**:`LINK/relayLink.ts:52`。iOS 侧对应的是 `LeoLinkProblem.isTailnetHost`(认出 tailnet 地址,失败时提示打开 Tailscale)。

---

## F. 主机类型与功能版本

### F1 `server == leophoneagent` 分流
- **引入**:iOS 1.41.0(2026-09-25)/ Mac 1.2.0。
- **没有它**:原版 leoagent 的 Mac 只有 Claude Code / Codex / Grok;升级到 LeoPhoneAgent 的 Mac 多出自己的 `zcode` 任务且支持直连。不分流,要么少一个选项,要么对原版 Mac 发 `zcode` 被拒。
- **如何检测**:中继 `/machines` 的 `server`(`leophoneagent` / `leocodebox` / `minis`)。
- **可删除条件**:不删(原版 leoagent 与桌面端并存期间)。
- **位置**:`GW/GatewayHostStore.swift:51`;`GV:1484`。

### F2 `isAndroidBody` 判定写了两份
- **引入**:iOS 1.24.1(2026-08-19)。
- **没有它**:Android 身体(`platform == "android"` 或 `server == "minis"`)被当成 Mac,出现 `claude` / `codex` 选项,建任务必败。
- **如何检测**:同上。
- **可删除条件**:不删。**两份判定(`RelayDiscoveredMachine` 与 `GatewayHost`)应收口到同一处**,见文末「收口建议」。
- **位置**:`GW/RelayMachinesClient.swift:11`、`GW/GatewayHostStore.swift:48`。

### F3 Mac 桥把本机 leoagent 的 harness 并进能力列表
- **引入**:Mac 1.2.0(2026-09-25)。
- **没有它**:新桌面端自己只实现 `zcode`;Claude Code / Codex / Grok 仍跑在本机 leoagent 里。能力列表若不并入,手机选不到它们;创建时非 `zcode` 的请求也要转发给 leoagent。
- **如何检测**:本机 leoagent `/v1/capabilities` 的 `harnesses`(没配 leoagent → 503,列表里只剩 `zcode`)。
- **可删除条件**:CLI 全部由桌面端自己实现(无计划)。
- **位置**:`LINK/bridge.ts:447`、`:489`。

### F4 `archive` 路由 + 本机隐藏、`available` 状态
- **引入**:Mac 1.3.1(桌面桥,2026-09-26)/ 1.3.2(本机 leoagent,2026-09-27)+ iOS 1.46.1。
- **没有它**:手机「清理」一条任务时,旧 Mac 不认 `POST /harness/sessions/{id}/archive`(404),任务在列表里清不掉;现在先在本机藏起来,再请 Mac 拿掉,旧 Mac 就只在这台设备上藏着(之后有新动静 / 要审批会重新出现)。Mac 1.3.1 起跑完半小时没动的任务报 `available`,不算「进行中」。
- **如何检测**:`archive` 回 404;任务状态 `available`。
- **可删除条件**:所有 Mac ≥ 1.3.2。之后可删本机 `dismissed` 记录与 `liveStatuses` 对 `available` 的特殊处理。
- **位置**:`GW/LeoAgentHarness.swift:160`;`GW/MacLiveSessionsStore.swift:52`、`:167`;Mac `LINK/bridge.ts:656`、`PY/server.py:460`。

### F5 `ssh_host_keys` 可缺省
- **引入**:iOS 1.49.2 + Mac 1.3.5(2026-10-01)。
- **没有它**:旧 Mac 的 `/v1/capabilities` 没有 `ssh_host_keys`,若当必有字段会解码失败或误报「没有公钥」。现在缺省为空数组,界面不提供「一键固定」。
- **如何检测**:能力响应里有没有 `ssh_host_keys`。
- **可删除条件**:所有 Mac ≥ 1.3.5。
- **位置**:`GW/LeoAgentClient.swift:357`;Mac `LINK/bridge.ts:434`。

### F6 引擎端口(8645)与编码会话端口(8647)并存
- **引入**:2026-08-05(iOS 1.8.x 网关首版);编码会话地址与引擎地址分开保存 2026-08-06(1.8.3)。
- **没有它**:引擎和编码会话服务是两个进程、两个端口,一个地址无法同时服务;把编码流量指到引擎端口曾经 404,甚至被读成「没装 CLI」。现在引擎地址可留空(只控编码 CLI 的主机),缺编码会话地址时报具名的设置错误,空 CLI 列表提示检查端口。
- **如何检测**:`GatewayError.harnessNotConfigured`;`/v1/capabilities` 没有 `harnesses` 字段(引擎)。
- **可删除条件**:引擎入口移除(同 C5)。
- **位置**:`GW/GatewayHostStore.swift:335`;`GW/GatewayError.swift:16`;`GV:1180`。

---

## G. 补拉与推送

### G1 补拉:游标修复、无 seq 指纹、`approval_id ‖ request_id`
- **引入**:补拉 2026-08-10(`85d783b3`);游标夹紧与数量上限 iOS 1.61.0(2026-10-10)。
- **没有它**:旧版本可能把补拉游标推到未来,此后永远补不到新事件;不带 `seq` 的事件若按 seq 去重会被误吞;ACP 方言的审批事件用 `request_id` 而不是 `approval_id`。
- **如何检测**:`lastSeenAt > now + 60`;事件无 `seq`;事件只有 `request_id`。
- **可删除条件**:`repairedCursor`——没有 < iOS 1.61 的游标遗留数据(单机自用,升级一次后即可删);其余两项不删。
- **位置**:`GW/RelayCatchUpPolicy.swift:47`、`:12`、`:21`;`GW/RelayEventCatchUp.swift:77`。

### G2 APNs `environment` 缺省 `development`
- **引入**:iOS 1.13.0(2026-08-10)。
- **没有它**:开发证书签的 token 只能走沙盒 APNs 网关,用错网关直接 400;`environment` 只有构建时才知道,必须由客户端带上。中继缺省 `development`,侧载包也是 development 证书。
- **如何检测**:`embedded.mobileprovision` 里的 `aps-environment`。
- **可删除条件**:不删。
- **位置**:`GW/PushRegistrar.swift:130`、`:123`;`PY/relay.py:1635`。

### G3 通知回调:无 session_id 时反查
- **引入**:iOS 1.13.0(2026-08-10);「全机只有一个 waiting 才按它寻址」2026-08-20(PR #5 审计)。
- **没有它**:APNs 推送里往往只有 machine + approval_id;锁屏点「允许一次」时进程是被系统冷起来的,内存里的会话列表是空的——只查内存会静默返回,批准丢失。所以现场向该主机拉一次 `/harness/sessions` 把 approvalId 反查成 sessionId;中继只报「有一条在等」时,全机只有一个 waiting 会话才按它寻址,多于一个宁可不猜。
- **如何检测**:通知 `userInfo` 里没有 `harnessSessionId`(中继现行会带,见 `PY/relay.py:1413`)。
- **可删除条件**:不删(冷启动的内存状态问题是结构性的)。
- **位置**:`GW/HarnessApprovalNotifier.swift:157`、`:162`。

---

## H. 本机存档

### H1 `GatewayHost` 新增字段全部可选
- **引入**:`harnessURL` iOS 1.8.3(2026-08-06);`platform/server/device/directOnly/relayServices/outboxIdentity` 之后各版本。
- **没有它**:`JSONDecoder` 解不出旧版保存的主机 → `try?` 失败 → `hosts = []`,**所有已连接的机器静默消失**。
- **如何检测**:读取 `leo.gatewayHosts.v1` 时缺字段。
- **可删除条件**:不删。给 `GatewayHost` 加字段时必须保持可选(或给默认值)。
- **位置**:`GW/GatewayHostStore.swift:34`、`:63`。

### H2 `outboxIdentity` 回填
- **引入**:iOS 1.49.1(2026-09-30)。
- **没有它**:见 D5;`client(for:)` 在 `body` 里被调用,所以回填放到下一个 runloop 发布,避免在视图更新中改 `@Published`。
- **可删除条件**:同 D5。
- **位置**:`GW/GatewayHostStore.swift:340`。

### H3 `/health` 的 401/403 算「可达」
- **引入**:iOS 1.8.3(2026-08-06)。
- **没有它**:中继的机器路径要钥匙,不带钥匙探测一律 401;若把它当失败,所有中继机器都显示「连不上」。可达性问的是「那头有没有人」,不是「钥匙对不对」。
- **注意**:这也意味着 `/health` 对中继机器**只证明中继在线**,Mac 睡着了照样「可达」。设置页现在改用中继的在线列表判断 Mac 是否在线(列表拉成功但机器不在其中 = `macOffline`),`/health` 只用来兜底(`GV:308`)。
- **可删除条件**:不删。
- **位置**:`GW/GatewayHostStore.swift:462`。

---

## I. 藏宝阁(Treasury)中继同步

### I1 中继 `/collections` 整库快照适配器
- **引入**:整库镜像 `/collections` 2026-08(中继 0.1);适配器 2026-08-31(提交 `c6f7f9e0`,藏宝阁游标同步)。
- **没有它**:藏宝阁 Phase 4 之前的 iOS 整库镜像(PUT 全量快照)在旧中继里按 500 条截断、并整体替换另一台设备的数据;适配器让仍发整库快照的老客户端继续工作,但把每条旧条目转成幂等的元数据变更,同设备缺失的 id 转墓碑,并一次性导入旧 `collections.json`。
- **如何检测**:`PUT /relay/api/collections`。**当前 iOS 不再调用它**(只走 `relayServices.treasuryURL` = `…/treasury/`)。
- **可删除条件**:没有 < iOS 1.31 的客户端(单机自用:所有设备都已升级后即可删)。
- **位置**:`PY/relay.py:1443`、`:1502`、`:369`。

### I2 藏宝阁游标 410 → 重建快照
- **引入**:iOS 1.31.0(2026-08-31)。
- **没有它**:游标早于中继保留的最小游标时,增量拉取永远失败;中继回 410 + `min_cursor`,iOS 改为分页拉全量快照并重置游标。
- **可删除条件**:不删(游标过期是正常情形)。
- **位置**:`GW/RelayEventCatchUp.swift:544`;`PY/relay.py:1570`。

---

## K. 本次新增的依赖:`LeoLinkProblem` 的状态码与文案契约

`LeoLinkProblem`(`GW/LeoLinkProblem.swift`)把失败翻译成「谁的问题 + 一个主按钮」。它**依赖服务端的状态码,以及少数几句服务端文案**。改动这些文案 / 状态码时必须同步改映射与 `TEST/LeoLinkProblemTests.swift`,否则会误判:

| 依赖 | 来源 | 映射 |
|---|---|---|
| 401(`relay_auth_failed`) | `PY/relay.py:1016` | `relayAuthFailed`,暂停重连,主按钮「重新扫码」 |
| 403 带原因(「设备授权已撤销」「认不出是哪台设备」「请先通过中继或本机配对授权」) | `LINK/bridge.ts:208`、`:647` | `macPairingRevoked`,暂停重连,主按钮「去 Mac 重新配对」 |
| 403 不带原因 | 直连端点 `{"error":"harness_scope_required"}` 等字符串形 `error`(解析不出 message) | `relayAuthFailed` |
| 404 +「这个接口不对手机开放」 | `LINK/bridge.ts:226` | `protocolMismatch`(其余会话内 404 是业务错误,不暂停) |
| 409 `join token expired or unknown` / 429 `尝试太频繁` | `PY/relay.py:1089` | 配对中:`notPaired`(重新扫码)/ `relayBusy` |
| 502 +「这台 Mac 当前不在线」「转发到这台 Mac 失败」(或无正文) | `PY/relay.py:1730` | `macOffline`,可重试,不暂停 |
| 504 +「这台 Mac 没有按时响应」 | `PY/relay.py:1762` | `timeout`(归属 Mac) |
| `202 {"status":"pending"}`(`kind=iphone` 配对码) | `PY/relay.py:1103` | iOS 读不到 `accessKey` → `malformed` → `notPaired`(见 B2) |

---

## 收口建议(`LeoLinkCompat`,本次未做)

iOS 侧的能力 / 版本判断散落在这些地方,每处都只是一两个字符串字面量,**收口不能删掉任何垫片**,所以本次只写文档、不改行为:

| 判断 | 出现位置 |
|---|---|
| 「Mac 留回执」= `device.capabilities` 含 `operation-receipts` | `GW/LeoAgentHarness.swift:572`、`GW/LeoAgentRouting.swift:26` |
| 「Mac 有同步副本」= `sync-replica-v1` | `GW/LeoAgentRouting.swift:23`、`:193` |
| 「是 Android 身体」= `platform == android ‖ server == minis` | `GW/RelayMachinesClient.swift:11`、`GW/GatewayHostStore.swift:48` |
| 「是新桌面端」= `server == leophoneagent` | `GW/GatewayHostStore.swift:51` |
| 全自动被拒 = 403 ‖ (400 且非 zcode) | 已收口在 `HarnessFullAuto.isRefusal`,四处调用(A2) |

若以后要做:`LeoLinkCompat` 只放「判断函数 + 能力名常量」,并在其中给每个判断加上「删除条件」注释,让本台账成为它的文档;读取中继在线列表里的 `version`(`RelayDiscoveredMachine.version`)后,「Mac ≥ x.y.z」类的垫片才能在运行时自动关闭,而不是靠人工删。

## 更新规则

- 新增任何「为旧版本 / 旧部署兜底」的代码,同一次提交里在本文加一条(引入版本、没有它会怎样、如何检测、可删除条件、位置)。
- 删垫片:先按「怎么知道舰队现在是什么版本」核对,删掉代码与对应测试,再删本文条目并在 CHANGELOG 写明「不再兼容 < x.y.z」。
- 行号会漂移;以 `grep` 的符号名为准。
