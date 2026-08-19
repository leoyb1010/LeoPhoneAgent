# HarmonyOS 7 交付计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 HarmonyOS 7（API 26）上交付一个能装到真机、首启弹出「本次更新」、能指挥现有 Mac/Android 身体的 LeoPhoneAgent，并在 1.0 把本机对话做成可用的 Standard Agent；不承诺 Alpine 沙箱和 Power 跨应用操控。

**Architecture:** 鸿蒙是新工程，不是 Android flavor。协议层先用 Node 可测的 TypeScript 写死，再搬进 ArkTS。UI 只走 ArkUI Stage 模型。远程指挥复用现有中继（`/machines` + `/m/{name}` harness + 出站 WS），不新开遥控协议。本机 Agent 是第二船，身体注册是第三船。QEMU/HiSH、Shizuku、无障碍同构、小艺 Skill 商店全部排除在 1.0 外。

**Tech Stack:** HarmonyOS SDK 26.0.0+ / DevEco Studio 26 / ArkTS + ArkUI / `@ohos.net.http` + `@ohos.net.webSocket` / Push Kit / ArkWeb / hdc 本机安装。协议对标 `src/ios/Agent/Gateway/RelayMachinesClient.swift`、`src/android/.../RelayPairCodec.kt`、`MinisHarnessRouter.kt`、`RelayOutboundCodec.kt`。

## Global Constraints

- 目标系统：HarmonyOS 7，开发者 API **26.0.0**（Beta2 起；正式版跟 Mate90 秋季）。HarmonyOS 5/6 真机可作兼容回退，但验收机必须是 7。
- 包名：`com.leoyuan.leophoneagent.harmony`（与 Android `com.leoyuan.leophoneagent` 分开，避免签名/商店冲突）。
- 工程根：`src/harmony/`。禁止把 Kotlin/Java/APK 放进这个目录。
- 默认中继根：`https://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/api`
- 配对前缀：`leoagent-body:v1|`；码里只有 `apiRoot` + `machine`；钥匙永不进码。
- 钥匙：≥16 字符，`Authorization: Bearer <key>`；复制残渣（尾部 `%` / 换行）必须剥掉。
- HTTPS only。扫码加入时，QR 里的 `apiRoot` 必须等于本机已存中继根（大小写与尾斜杠不敏感），否则拒绝，避免把钥匙打到陌生 HTTPS。
- 机器名拒绝 `/` `\` `?` `#` `%` `..`。
- 用语必须与 `docs/COPY-TABLE-2026-08-19.md` 一致：新任务 / 本机 Agent / 远程机器 / 进行中 / 审批。
- 发版铁律：每一次真机覆盖安装必须 bump `versionName` + `versionCode`，并在 `ReleaseNotes.ets` **最前面**加本版条目；首启弹出的必须是这一版，不是上一版。漏写即发版失败。
- 1.0 范围锁死：瘦控制面 + 本机对话（模型/记忆/设置/应用内浏览）+ 可选身体注册。**不做** Alpine/PRoot/HiSH、Shizuku、无障碍跨应用、小艺 Skill 上架、GGUF、额度/托盘、把 iPhone 收成节点。
- 分发：1.0 只走 `hdc install` 个人机。AppGallery 是 1.0 之后的独立闸门，不挡个人交付。
- 本仓库这台 Mac 没有 DevEco 时，只允许合协议层与文档；HAP 构建必须在有 DevEco + 鸿蒙真机的机器上做，并留下 hdc / 版本号证据。
- 不得改 Android 期望签名指纹，不得提交密钥。

---

## 交付定义（什么叫「交付」）

三艘船，每艘都能单独装机。1.0 = 三艘都绿。

| 船 | 版本 | 用户能做什么 | 卡死条件 |
|---|---|---|---|
| Ship 1 瘦控制面 | `0.1.0-alpha.1` / `100001` | 填钥匙、列出 `/machines`、对一台 Mac 或 Android 身体开聊、断线按 `?after=N` 续上、审批一条命令、首启弹 0.1.0 更新卡 | iPhone 已能指挥的那台机器，鸿蒙也能指挥 |
| Ship 2 本机 Agent | `0.2.0-alpha.1` / `100002` | 不连中继也能对话；至少一个 OpenAI 兼容供应商；会话落盘；应用内 ArkWeb 打开链接 | 飞行模式仍能看到历史会话 |
| Ship 3 身体 | `0.3.0-alpha.1` / `100003` | 鸿蒙出站注册，`platform=harmony` / `server=minis`；iPhone 列表出现这台机并对其发一句 | iPhone 发的那句在鸿蒙会话里真跑 |
| 1.0 个人可用 | `1.0.0` / `200000` | 上三船稳定；冷启动；杀进程后推送审批（若 Push Kit 已接通，否则设置页写明「杀进程后审批不可用」）；README / CHANGELOG / 更新卡三处一致 | 你的鸿蒙真机冷启动两次都弹出 1.0.0 卡 |

D 闸门（1.0 之后才开，本计划不排期）：Linux 沙箱、跨应用 GUI、应用市场上架。

工期按 1 个会 ArkTS 的人、手上有 Beta/正式鸿蒙机估算：Ship 1 = 4–6 周；Ship 2 = 6–8 周；Ship 3 = 2–3 周；缓冲 2 周。合计约 **14–19 周** 到 1.0。没有真机就停在 Task 3，不准假装交付。

---

## 文件地图（先锁，后写）

```text
src/harmony/
  protocol/                         # Node 单测，不依赖 DevEco
    relayMachines.ts
    relayPair.ts
    relayOutbound.ts
    harnessTypes.ts
    protocol.test.mjs
  app/                              # DevEco Stage 工程
    AppScope/app.json5
    entry/src/main/module.json5
    entry/src/main/ets/
      entryability/EntryAbility.ets
      pages/HomePage.ets
      pages/FleetPage.ets
      pages/RemoteChatPage.ets
      pages/LocalChatPage.ets
      pages/SettingsPage.ets
      pages/ReleaseNotesPage.ets
      net/MachinesClient.ets
      net/HarnessClient.ets
      net/OutboundClient.ets
      store/GatewayStore.ets
      store/SessionStore.ets
      store/ReleaseNotesStore.ets
      push/PushRegistrar.ets
      release/ReleaseCatalog.ets
      local/OpenAICompatClient.ets
  scripts/
    verify_harmony_release_notes.sh
docs/COPY-TABLE-2026-08-19.md       # 加 HarmonyOS 列
README.md                           # 加鸿蒙工程路径
CHANGELOG.md                        # 每船一条
```

共享类型（后续任务必须用这些名字，禁止另起一套）：

```ts
export type RelayDiscoveredMachine = {
  name: string
  online: boolean
  platform: string | null
  server: string | null
  version: string | null
}

export type PairPayload = {
  apiRoot: string
  machine: string
}

export type HarnessKind = { key: string; name: string }

export type HarnessSessionSummary = {
  id: string
  harness: string
  name: string
  cwd: string
  status: string
  seq: number
  waitingForApproval: boolean
  pendingApprovalId: string | null
  pendingApprovalCommand: string | null
}

export type EngineChunk =
  | { kind: "delta"; text: string }
  | { kind: "completed"; output: string }
  | { kind: "failed"; message: string }
```

中继路径（禁止改拼写）：

- `GET {apiRoot}/machines`
- harness 根：`{apiRoot}/m/{machine}`
- `GET /health`
- `GET /v1/capabilities`
- `GET /harness/sessions`
- `POST /harness/sessions` body `{ harness, cwd, prompt?, thinking? }` → `{ session_id, harness, status }`
- `GET /harness/sessions/{id}/events?after=N`  SSE
- `POST /harness/sessions/{id}/send` body `{ text, thinking? }`
- `POST /harness/sessions/{id}/stop`
- `POST /harness/sessions/{id}/approval` body `{ choice, approval_id? }`
- 出站 WS：把 `.../relay/api` 换成 `.../relay/agent`，`https`→`wss`
- 注册帧：`{ type:"register", name, key, info:{ platform:"harmony", server:"minis", version } }`

---

### Task 1: 协议层 — 机器列表与配对码

**Files:**
- Create: `src/harmony/protocol/relayMachines.ts`
- Create: `src/harmony/protocol/relayPair.ts`
- Create: `src/harmony/protocol/protocol.test.mjs`
- Modify: `docs/COPY-TABLE-2026-08-19.md`（加 HarmonyOS 列，五词与 iOS 相同）

**Interfaces:**
- Consumes: 无
- Produces: `parseMachines(json: unknown): RelayDiscoveredMachine[]`；`harnessURL(apiRoot, machine)`；`normalizeApiRoot`；`sameApiRoot`；`apiRootFromHarnessURL`；`isAndroidBody` / `isHarmonyBody`；`encodePair` / `decodePair`

- [ ] **Step 1: 写失败单测**

```js
// src/harmony/protocol/protocol.test.mjs
import assert from "node:assert/strict";
import { parseMachines, harnessURL, sameApiRoot, apiRootFromHarnessURL } from "./relayMachines.ts";
import { encodePair, decodePair } from "./relayPair.ts";

const ROOT = "https://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/api";

{
  const rows = parseMachines({
    machines: [
      { name: "LeodeMac-mini-2", online: true, server: "leocodebox" },
      { name: "LeoFold8", online: true, platform: "android", server: "minis", version: "1.0.0-alpha.6" },
      { name: "LeoMate", online: true, platform: "harmony", server: "minis", version: "0.1.0-alpha.1" },
    ],
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[1].platform, "android");
  assert.equal(rows[2].platform, "harmony");
  assert.equal(harnessURL(ROOT + "/", "LeoFold8"), ROOT + "/m/LeoFold8");
  assert.equal(sameApiRoot(ROOT + "/", ROOT), true);
  assert.equal(apiRootFromHarnessURL(ROOT + "/m/LeoFold8"), ROOT);
}

{
  const code = encodePair(ROOT + "/", "LeoMate");
  assert.ok(code.startsWith("leoagent-body:v1|"));
  assert.deepEqual(decodePair(code), { apiRoot: ROOT, machine: "LeoMate" });
  assert.equal(decodePair(code.replace(ROOT, "https://evil.example/relay/api")), decodePair(code) && null || decodePair("leoagent-body:v1|{\"apiRoot\":\"https://evil.example/relay/api\",\"machine\":\"LeoMate\"}").apiRoot === ROOT ? "fail" : "ok");
  assert.equal(decodePair("leoagent-body:v1|{\"apiRoot\":\"http://x\",\"machine\":\"a\"}"), null);
  assert.equal(decodePair("leoagent-body:v1|{\"apiRoot\":\"" + ROOT + "\",\"machine\":\"a/b\"}"), null);
  assert.ok(!code.includes("key"));
}

console.log("PROTOCOL_MACHINES_OK");
```

`decodePair` 本身**不**校验「是否等于已存根」——那是 UI 层 `GatewayStore.scanPairCode` 的职责。本测试只断言：非 https、空名、名字含 `/` 一律 `null`；编码不含钥匙。把上面那段 `evil` 三元删掉，改成：

```js
assert.equal(decodePair("not-a-code"), null);
assert.equal(decodePair("leoagent-body:v1|{\"apiRoot\":\"http://insecure\",\"machine\":\"x\"}"), null);
```

- [ ] **Step 2: 跑测，确认失败**

```bash
node --experimental-strip-types src/harmony/protocol/protocol.test.mjs
```

Expected: `ERR_MODULE_NOT_FOUND` for `./relayMachines.ts`

- [ ] **Step 3: 实现 codec**

`relayMachines.ts` 必须：

- `parseMachines` 只收 `machines` 数组；无名行丢弃；`online` 缺省 `true`
- `normalizeApiRoot` 去空白、去尾 `/`
- `harnessURL` = `normalizeApiRoot(apiRoot) + "/m/" + machine`
- `sameApiRoot` 规范化后小写比较
- `apiRootFromHarnessURL` 从最后一次 `/m/` 切开
- `isAndroidBody(m)` = `m.platform === "android" || m.server === "minis"` 且 platform 不是 `harmony`
- `isHarmonyBody(m)` = `m.platform === "harmony"`

`relayPair.ts` 必须：

- `PREFIX = "leoagent-body:v1|"`
- `encodePair` 输出 `PREFIX + JSON.stringify({ apiRoot: normalizeApiRoot(apiRoot), machine: machine.trim() })`
- `decodePair` 接受 `PREFIX` 或裸 JSON；`apiRoot` 必须以 `https://` 开头；machine 含 `/ \ ? # % ..` 则 `null`

- [ ] **Step 4: 再跑测**

```bash
node --experimental-strip-types src/harmony/protocol/protocol.test.mjs
```

Expected: `PROTOCOL_MACHINES_OK`

- [ ] **Step 5: COPY-TABLE 加第四列**

`docs/COPY-TABLE-2026-08-19.md` 五词 HarmonyOS 列与 iOS 完全相同：新任务 / 本机 Agent / 远程机器 / 进行中 / 审批。

- [ ] **Step 6: 提交**

```bash
git add src/harmony/protocol/relayMachines.ts src/harmony/protocol/relayPair.ts src/harmony/protocol/protocol.test.mjs docs/COPY-TABLE-2026-08-19.md
git commit -m "$(cat <<'EOF'
feat(harmony): 锁定中继列表与配对码协议

EOF
)"
```

---

### Task 2: 协议层 — harness 与出站帧

**Files:**
- Create: `src/harmony/protocol/harnessTypes.ts`
- Create: `src/harmony/protocol/relayOutbound.ts`
- Modify: `src/harmony/protocol/protocol.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `normalizeApiRoot`
- Produces: `agentWsUrl(apiBase: string): string`；`registerFrame(name, key, version)`；`parseSseData(line)`；`capabilitiesFromJson`；`sessionSummaryFromJson`

- [ ] **Step 1: 把这些断言加进 `protocol.test.mjs`**

```js
import { agentWsUrl, registerFrame, parseSseData } from "./relayOutbound.ts";

assert.equal(
  agentWsUrl("https://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/api"),
  "wss://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/agent",
);
const frame = registerFrame("LeoMate", "k".repeat(16), "0.1.0-alpha.1");
assert.equal(frame.type, "register");
assert.equal(frame.info.platform, "harmony");
assert.equal(frame.info.server, "minis");
assert.equal(parseSseData("data: {\"seq\":1}"), "{\"seq\":1}");
assert.equal(parseSseData("keep-alive"), null);
```

- [ ] **Step 2: 跑测，确认失败**

Expected: `ERR_MODULE_NOT_FOUND` for `./relayOutbound.ts`

- [ ] **Step 3: 实现 `relayOutbound.ts`**

规则与 `RelayOutboundCodec.kt` 相同，只改 platform：

- `https://` → `wss://`，`http://` → `ws://`
- 把末尾 `/relay/api` 换成 `/relay/agent`
- 若结果仍不以 `/relay/agent` 结尾：以 `/relay` 结尾则补 `/agent`，否则补 `/relay/agent`
- `registerFrame.info.platform` 固定 `"harmony"`，`server` 固定 `"minis"`
- `parseSseData`：行 trim 后必须以 `data:` 开头，去掉前缀再 trim，空则 `null`

- [ ] **Step 4: 再跑测，确认通过**
- [ ] **Step 5: 提交**

```bash
git add src/harmony/protocol/harnessTypes.ts src/harmony/protocol/relayOutbound.ts src/harmony/protocol/protocol.test.mjs
git commit -m "$(cat <<'EOF'
feat(harmony): 锁定 harness 与出站注册帧

EOF
)"
```

---

### Task 3: DevEco 工程骨架 + 发版闸门

**Files:**
- Create: `src/harmony/app/AppScope/app.json5`
- Create: `src/harmony/app/entry/src/main/module.json5`
- Create: `src/harmony/app/entry/src/main/ets/release/ReleaseCatalog.ets`
- Create: `src/harmony/scripts/verify_harmony_release_notes.sh`
- Create: `src/harmony/app/entry/src/main/ets/pages/HomePage.ets`
- Create: `src/harmony/app/entry/src/main/ets/entryability/EntryAbility.ets`

**Interfaces:**
- Consumes: 无
- Produces: `ReleaseCatalog.all[0].version === app.json5 versionName`；`verify_harmony_release_notes.sh` 退出码 0 才能宣称可装机

`app.json5` 必须含：

```json5
{
  "app": {
    "bundleName": "com.leoyuan.leophoneagent.harmony",
    "vendor": "leoyuan",
    "versionCode": 100001,
    "versionName": "0.1.0-alpha.1",
    "minAPIVersion": 12,
    "targetAPIVersion": 26
  }
}
```

`ReleaseCatalog.ets` 首条必须是：

```ts
{
  version: "0.1.0-alpha.1",
  date: "YYYY-MM-DD",   // 装机当天
  title: "鸿蒙瘦控制面",
  highlights: [
    "填中继钥匙后读取 /machines，不再写死三台 Mac。",
    "可对在线 Mac 或 Android 身体开新任务，断线按序号续上。",
    "审批用词与 iPhone / Android 对齐。"
  ]
}
```

闸门脚本必须同时检查：`versionName`、`versionCode`、`ReleaseCatalog.all[0].version` 三者相等，且 `versionName` 出现在 `CHANGELOG.md` 某一行。失败时打印缺哪一项，退出 1。

- [ ] **Step 1: 在有 DevEco 的机器上用 API 26 模板建 Stage 工程到 `src/harmony/app/`，包名如上**
- [ ] **Step 2: 写入 `ReleaseCatalog` 与闸门脚本**
- [ ] **Step 3: 跑闸门**

```bash
bash src/harmony/scripts/verify_harmony_release_notes.sh
```

Expected: `HARMONY_NOTES_OK 0.1.0-alpha.1 100001`

- [ ] **Step 4: `hdc install` 到真机，冷启动必须出现「本次更新」且标题是「鸿蒙瘦控制面」**
- [ ] **Step 5: 提交（含 CHANGELOG 的 HarmonyOS 0.1.0-alpha.1 小节，验证栏写真机型号与 API 版本）**

没有真机：停在这一步，把工程骨架合进 main，但 README 必须写「尚未真机装机，不算交付」。

---

### Task 4: 钥匙、中继根、机器列表

**Files:**
- Create: `src/harmony/app/entry/src/main/ets/store/GatewayStore.ets`
- Create: `src/harmony/app/entry/src/main/ets/net/MachinesClient.ets`
- Create: `src/harmony/app/entry/src/main/ets/pages/SettingsPage.ets`
- Create: `src/harmony/app/entry/src/main/ets/pages/FleetPage.ets`

**Interfaces:**
- Consumes: Task 1 的 `parseMachines` / `sameApiRoot` / `decodePair` / `harnessURL`
- Produces: `GatewayStore.load()` / `save({ apiRoot, key })` / `refresh()` / `scanPairCode(raw)`；`MachinesClient.list(apiRoot, key)`

行为锁：

- 钥匙用 `@ohos.security.cryptoFramework` 或 Preferences 加密存储，禁止明文日志。
- `refresh()` 的 `apiRoot` 必须来自已存 harness/中继根，禁止写死字符串覆盖用户改过的根。
- `scanPairCode`：`decodePair` 失败 → 提示「不是身体码」；`sameApiRoot(payload.apiRoot, savedApiRoot)` 为假 → 提示「中继根与已保存的不一致」并**不**发请求。
- 列表空态文案：「还没有在线的远程机器」。
- 发现到的主机只更新 `harness` / `platform` / `online`，保留用户改过的显示名和 `isEnabled`（对标 iOS `GatewayHostStore.upsertDiscovered`）。

- [ ] **Step 1: ArkTS 单测或 Node 对照测：错误码、根不一致拒绝、upsert 合并**
- [ ] **Step 2: 真机填钥匙，列表出现至少一台已在中继注册的 Mac**
- [ ] **Step 3: 提交**

---

### Task 5: 远程开聊、续传、转向、停止

**Files:**
- Create: `src/harmony/app/entry/src/main/ets/net/HarnessClient.ets`
- Create: `src/harmony/app/entry/src/main/ets/pages/RemoteChatPage.ets`
- Modify: `src/harmony/app/entry/src/main/ets/pages/FleetPage.ets`

**Interfaces:**
- Consumes: Task 2 路径表；`POST /harness/sessions` 的 `thinking` 字段
- Produces: `HarnessClient.create({ machine, harness, cwd, prompt, thinking })`；`events(sessionId, after)`；`send`；`stop`；`approve`

行为锁：

- 点「新任务」必须先 `create` 再导航；发送在 session_id 返回前排队，不准吞点击（对标 iOS 1.24）。
- SSE 用最后渲染的 `seq` 重连，禁止从头拉。
- `message.delta` 追加；`run.completed` / `run.failed` / `run.cancelled` 结束进行中态。
- Android 身体只允许 `harness=minis`。Mac 列出 `/v1/capabilities.harnesses` 再选。
- 当前推理档随 `create` / `send` 带走，字段名 `thinking`。

验收：

1. 鸿蒙 → 已在线 Mac，发「只回复 pong」，气泡出现 pong。
2. 飞行模式 10 秒再开，不丢已渲染事件。
3. 进行中点停止，状态变取消。

- [ ] **Step 1: 实现 client + 页**
- [ ] **Step 2: 真机三条验收**
- [ ] **Step 3: bump 不必（仍在 0.1.0-alpha.1 开发）；提交功能，不装机则不 bump**

---

### Task 6: 审批

**Files:**
- Modify: `src/harmony/app/entry/src/main/ets/net/HarnessClient.ets`
- Modify: `src/harmony/app/entry/src/main/ets/pages/RemoteChatPage.ets`

**Interfaces:**
- Consumes: `pendingApprovalId`；`POST .../approval` `{ choice, approval_id }`
- Produces: 聊天里「审批」条，按钮「批准 / 拒绝」

- [ ] **Step 1: Mac 会话制造一条待批准命令，鸿蒙能按 `approval_id` 批过**
- [ ] **Step 2: 缺 `approval_id` 时禁止盲发「队首」——没有 id 就禁用按钮并写「缺少审批编号」**
- [ ] **Step 3: 提交**

---

### Task 7: Ship 1 装机

**Files:**
- Modify: `src/harmony/app/AppScope/app.json5`（若此前进过真机，必须 +1 `versionCode` 并改 notes）
- Modify: `src/harmony/app/entry/src/main/ets/release/ReleaseCatalog.ets`
- Modify: `CHANGELOG.md`
- Modify: `README.md`（加鸿蒙下载/安装段：仅 hdc，写清包名与版本）

验收清单（全绿才能写「Ship 1 交付」）：

- [ ] `bash src/harmony/scripts/verify_harmony_release_notes.sh` 通过
- [ ] 真机覆盖安装后「关于」显示 `0.1.0-alpha.1 (100001)`
- [ ] 冷启动弹出本版四条，不是空卡、不是 Android 文案
- [ ] `/machines` 与 iPhone 同一把钥匙看到同一组在线机
- [ ] 对一台 Mac 完成开聊 + 一条审批
- [ ] 对一台已作身体的 Android 开聊一句（若当时没有 Android 在线，CHANGELOG 写明「Android 身体未在场，仅源码审查」）
- [ ] README / CHANGELOG / 更新卡版本字符串一致

提交信息：`feat(harmony): 0.1.0-alpha.1 瘦控制面可装机`

---

### Task 8: Ship 2 — 本机 OpenAI 兼容对话

**Files:**
- Create: `src/harmony/app/entry/src/main/ets/local/OpenAICompatClient.ets`
- Create: `src/harmony/app/entry/src/main/ets/store/SessionStore.ets`
- Create: `src/harmony/app/entry/src/main/ets/pages/LocalChatPage.ets`
- Modify: `src/harmony/app/entry/src/main/ets/pages/HomePage.ets`
- Modify: `src/harmony/app/entry/src/main/ets/pages/SettingsPage.ets`

**Interfaces:**
- Consumes: 用户在设置里保存的 `{ baseURL, apiKey, model }`
- Produces: `OpenAICompatClient.streamChat(messages): AsyncGenerator<EngineChunk>`；`SessionStore.create / append / list / archive`

行为锁：

- 请求 `POST {baseURL}/chat/completions`，`stream: true`，首包超时 **120s**（对标 Android B5）。
- `jsonLoadFailed` 为真时禁止再保存供应商文件（对标 iOS 1.24）。
- 首页两个入口：「本机 Agent」「远程机器」，禁止合成一个仪表盘。
- 会话 JSON 存在应用沙箱 `el2`；导入只接受带 `messages` 的档案，否则不建空会话。

验收：

- 填一个已有供应商，本机来回一句。
- 杀进程再开，历史还在。
- 飞行模式打开历史，不崩。

版本：`0.2.0-alpha.1` / `100002`，更新卡重写为本机 Agent 四条。闸门 + 真机冷启动。

---

### Task 9: Ship 2 — 应用内浏览与敏感工具闸门

**Files:**
- Create: `src/harmony/app/entry/src/main/ets/local/InAppBrowser.ets`
- Create: `src/harmony/app/entry/src/main/ets/local/SensitiveToolGate.ets`

**Interfaces:**
- Consumes: ArkWeb
- Produces: 本机工具 `open_url` 只开应用内页；`file_write` / 本机「运行命令」默认询问

1.0 的「运行命令」只允许应用沙箱内的只读列举（`list sandbox files`），**禁止** `NativeChildProcess` 跑任意二进制。任意 shell 属于 D 闸门。

版本可留在 `0.2.0-alpha.1` 若尚未装机；一旦 Task 8 已装过真机，这里必须 bump 到 `0.2.0-alpha.2` / `100003` 并改更新卡。

---

### Task 10: Ship 3 — 出站身体

**Files:**
- Create: `src/harmony/app/entry/src/main/ets/net/OutboundClient.ets`
- Create: `src/harmony/app/entry/src/main/ets/local/HarmonyMinisRouter.ets`
- Modify: `src/harmony/app/entry/src/main/ets/entryability/EntryAbility.ets`

**Interfaces:**
- Consumes: Task 2 `agentWsUrl` / `registerFrame`；Android `MinisHarnessRouter` 的路径表
- Produces: 前台 Continuous Task 保活时维持 WS；把 `/harness/*` 转到本机 `SessionStore` 的一轮对话

行为锁：

- `info.platform === "harmony"`，`server === "minis"`。
- 新一轮 `send` 必须先 `stop` 上一轮（对标 Android 审计修复）。
- 进程被杀后应变离线；设置页写「被指挥需要应用在前台或保活通知」。
- 配对码展示用 `encodePair(savedApiRoot, deviceName)`，钥匙不进码。

验收：

1. 鸿蒙上线后，iPhone `/machines` 出现 `platform=harmony`。
2. iPhone 对它发一句，鸿蒙本机会话跑起来。
3. 划掉鸿蒙 App，iPhone 列表变离线。

版本：`0.3.0-alpha.1` / 下一个未用过的 `versionCode`。

---

### Task 11: Push Kit（能接就接，接不上就声明）

**Files:**
- Create: `src/harmony/app/entry/src/main/ets/push/PushRegistrar.ets`
- Modify: 中继侧仅当已有 APNs 同类入口时登记 Harmony token；**没有现成中继字段就不要改 relay.py 乱加协议**。先在设置页显示 token 是否拿到。

验收二选一，必须写进 CHANGELOG：

- A：杀鸿蒙 App 后，Mac 会话审批能弹出系统通知并点进对应会话。
- B：明确「Ship 3 杀进程后审批不可用」，1.0 仍可交付，但关于页打黄字。

禁止把 B 写成 A。

---

### Task 12: 1.0 交付闸门

版本：`1.0.0` / `200000`。

必须同时为真：

- [ ] Task 7 / 8 / 10 的真机证据还在（型号、API、日期、截图或 log）
- [ ] `verify_harmony_release_notes.sh` 对 1.0.0 通过
- [ ] 冷启动两次都弹 1.0.0 卡，文案是本版，不是 0.3
- [ ] README 徽章、CHANGELOG、更新卡、`app.json5` 四者一致
- [ ] 覆盖安装路径：从上一可用版（0.3.0-alpha.1）升到 1.0.0，数据（钥匙、会话）还在
- [ ] `docs/COPY-TABLE-2026-08-19.md` 含 HarmonyOS 列
- [ ] 设置页写清：无 Linux 沙箱、无跨应用操控、杀进程审批状态（A 或 B）
- [ ] 根 README「开发 Agent 先读」写明鸿蒙工程在 `src/harmony/`，双 flavor 规则仍只适用于 Android

提交：`feat(harmony): 1.0.0 个人可用`

打 tag：`harmony-v1.0.0`。附件若上传 HAP，写 SHA-256；个人调试证书必须声明不能当商店升级链。

---

## D 闸门（1.0 之后，本计划不实施）

只有同时满足才单独立项，不预建目录：

1. HarmonyOS 7 正式版已装到验收机。
2. Agent Framework / GUI 操控有官方 Guide + API Reference，且能在非演示应用里调用。
3. 应用市场对「应用内终端 / 跨应用点击」有书面口径。
4. 有人愿意维护 QEMU/JIT 或官方容器，并且接受商店禁 JIT。

在此之前禁止把 HiSH、Termux、Shizuku、无障碍写进 README 能力列表。

---

## 环境与命令

开发机（有 DevEco）：

```bash
# 协议层随时可在本仓库 Mac 上跑
node --experimental-strip-types src/harmony/protocol/protocol.test.mjs
bash src/harmony/scripts/verify_harmony_release_notes.sh

# 真机
hdc list targets
hdc install entry-default-signed.hap
hdc shell aa start -a EntryAbility -b com.leoyuan.leophoneagent.harmony
```

Beta 机（HDC 2026 名单，仅作参考）：Mate 80 Pro、Pura 90 Pro Max、nova 15 Pro、Mate X7、Mate XTs、Pura X。正式验收优先 Mate90 系 HarmonyOS 7 正式版。

---

## 自检

- 形态锁、三艘船、D 闸门、发版铁律、协议路径都有对应 Task。
- 没有「TBD / 稍后补全 / 类似 Task N」。
- 类型名在 Task 1–2 定义，后续只复用。
- 没有真机时，计划允许把协议合进 main，不允许把 Ship 1 标成已交付。
