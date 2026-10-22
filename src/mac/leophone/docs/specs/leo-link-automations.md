# Leo Link：手机管理 Mac 上的定时任务（P3「Mac 当执行者」）

场景：iOS 后台执行不可靠。iPhone 上建的周期 / 定时任务交给常开的 Mac（默认 Mac Studio）去跑：
手机只是遥控器，计划、触发、执行、运行记录都在 Mac 的「自动化」里；跑完把结果推回手机。

实现：`packages/desktop/src/host/leo/link/automationPayload.ts`（计划换算、视图、请求校验、全自动规则，纯函数）、
`automations.ts`（转调自动化服务、错误映射、回执检查点、模板）、
`automationResults.ts`（运行结果摘要：取最终回复、去 markdown、截断、按运行记下）、
`bridge.ts`（路由、回执、推送、无人值守的审批）、`session.ts`（审批卡与自动拒绝计时）、
`automationEvents.ts`（运行开跑 / 结束的进程内广播、失败改判）、
`packages/desktop/src/host/index.ts` 的 `dispatchCronRun` / `trackCronRunOutcome`（发布开跑与结束、取走改判再回写）、
`packages/shared/src/leoAutomationTemplates.ts`（自带模板，Mac 自动化页与手机共用）。
字段蛇形命名，和 `/harness` 路由同风格、同鉴权（中继 / 直连已配对设备）。

## 状态所有者

- **Mac 的自动化服务是唯一所有者**：定义、启停、下次时间、运行记录都在 `tasks-index.sqlite`，
  只经 `IZCodeAgentService` 的 `listAllAutomations / listAutomationRuns / createAutomation / updateAutomation /
  setAutomationEnabled / deleteAutomation / runAutomationNow` 读写（和桌面「自动化」设置页同一条路径）。
  Leo Link 不直接写它的存储，也不另存一份。
- **手机不存副本**：列表每次 `GET /automations` 现拉；推送事件只是通知，以 `GET` 为准。
- Leo Link 自己只落三样东西：操作回执（`journals/operations/`，幂等用）、推送 outbox（中继断线时攒着），
  和运行结果摘要缓存（`journals/automation-results.json`，运行 id → 摘要，最近 200 次）。摘要是派生值，
  不是运行记录的一部分：运行结束时会话还活着，读最终回复很便宜；事后再读要冷恢复会话，所以算一次记下来。

## 接口

计划时间一律按 **Mac 本机时区**解释（调度器在 Mac 上跑）。Mac 的 IANA 时区（如 `"Asia/Shanghai"`）在
`/v1/capabilities` 顶层和每个自动化对象里都给 `time_zone`（每次现取，改了系统时区不用重启），手机和自己的不同时提示。时间戳一律是 Unix **秒**（浮点，同 `/harness/sessions`）。

### 计划（schedule）的写法

请求里 `schedule` 可以是：

| 写法 | 例子 | 换成的 cron | recurring |
| --- | --- | --- | --- |
| cron 字符串（5 段） | `"0 9 * * 1-5"` | 原样 | true |
| `{"cron": …}` | `{"cron":"*/30 * * * *"}` | 原样 | true |
| `{"kind":"hourly","minute":15}` | 每小时第 15 分（也可给 `"time":"HH:MM"`，只取分钟） | `15 * * * *` | true |
| `{"kind":"daily","time":"09:00"}` | 每天 09:00 | `0 9 * * *` | true |
| `{"kind":"weekly","time":"09:00","weekday":1}` | 每周一 09:00；`weekday` 0=周日…6=周六，或 `"weekdays":[1,3,5]` | `0 9 * * 1` | true |
| `{"kind":"once","at":"2026-10-23T09:00:00+08:00"}` | 一次性；`at` 是 ISO 8601（不带时区就按 Mac 本地），或 `{"kind":"once","date":"2026-10-23","time":"09:00"}` | `0 9 23 10 *` | false（只跑一次） |

- `time` 是 24 小时制 `HH:MM`。`once` 精确到分钟（秒截掉），必须晚于现在且在 365 天内，否则 400。
- cron 只做形状预检（5 段、字符集），合法性由自动化服务判定（`InvalidCronExprError` → 400）。
- 修改计划时不接受 `once`（已有运行次数的任务改成一次性会被领域层直接判为已完成）：要一次性就新建。

响应里的 `schedule`：
`{"kind":"daily|weekly|hourly|once|cron|custom","cron":"0 9 * * *","human":"每天 09:00","recurring":true,"time"?:"09:00","weekdays"?:[1],"minute"?:15}`
（`custom` = 桌面上用「自定义重复」建的，按 `scheduleRule` 描述；`cron` = 认不出的 cron，`human` 带原式。）

### 自动化视图（automation）

```json
{
  "id": "automation-…", "name": "日报", "prompt": "汇总昨天的提交",
  "schedule": { "kind": "daily", "cron": "0 9 * * *", "human": "每天 09:00", "recurring": true, "time": "09:00" },
  "time_zone": "Asia/Shanghai",   // Mac 本机 IANA 时区，计划按它解释
  "enabled": true,
  "state": "active",              // active | paused | completed | failed（领域 lifecycleStatus）
  "workspace": "/Users/me/app",
  "mode": "build",                // plan | guarded | build | yolo；桌面建的可能为 null（跟随工作区默认）
  "target_task_id": null,         // 会话里建的自动化绑定的任务（每次投递回该任务）
  "run_count": 3,
  "last_run": { "status": "succeeded", "at": 1761181200.0, "task_id": "task-…", "session_id": "task-…",
                "trigger": "schedule", "error": null, "summary": "今天要做 修登录 bug …" },
  "next_run_at": 1761267600.0,    // null = 不会再跑（暂停 / 已完成）
  "created_at": 1761000000.0, "updated_at": 1761000000.0
}
```

`last_run.status`：`running | succeeded | failed | stopped`（任务结果），`dispatch_failed`（没能派发，如没配模型），
`skipped`（错过窗口），`pending`（已认领待派发）。从未跑过为 `null`。

`last_run.session_id` 与 `task_id` 同值，可直接打开 `/harness/sessions/<session_id>/events`（桥接按需接管该任务）。
`last_run.summary`（见「运行结果摘要」）：这台 Mac 上 Leo Link 记下的摘要优先；没记下的（别的窗口跑的、升级前跑的）
失败 / 停止按运行记录现算，成功的为 `null`（不为它冷恢复会话），未结束为 `null`。

### 端点

- `GET /automations` → `200 {"automations":[automation…]}`（这台 Mac 上全部工作区的，按创建时间新→旧）。
- `GET /automations/<id>` → `200 {"automation":{…}}`。
- `POST /automations`（**必须带操作编号**：中继帧 `request_id` / 直连 `X-Request-Id`；缺了 400）
  `{"name"?:"日报","prompt":"…","schedule":…,"workspace"?:"/Users/me/app","harness"?:"zcode","mode"?:"build","full_auto"?:false,"template_id"?:"leo-daily-brief"}`
  → `201 {"automation":{…}}`
  - `prompt` 必填（≤20000 字）；`name` 缺省取 prompt 前 30 字（≤100 字）。
  - `workspace`（也认 `cwd`）缺省或 `"~"`：和手机开任务同一规则（手机最近在这台 Mac 用过的项目，没有就主目录）；
    必须是 Mac 上存在的目录，否则 400。
  - agent / 模型：`harness` 缺省 `zcode` → 与手机开 LeoBot 任务同一个模型（用户默认或第一个非 acp 模型；一个都没配 409）；
    给外部 agent（`claude` / `codex`…，`/v1/capabilities` 里可用的）→ 用该 ACP agent；不可用 400。
  - 权限：`mode` 缺省 `build`（逐项确认）；`full_auto:true` 等价 `yolo`；显式 `mode` 优先。
    带 `template_id`（`GET /automations/templates` 里的 `id`）且没给 `mode` / `full_auto` 时，用该模板建议的模式
    （早报、回顾 `plan`，跑测试 `guarded`）；认不出的 `template_id` 按没给处理（不报错）。Mac 自动化页「从模板开始」
    同样把模板的 `mode` 预填进新建页（`materializeScheduledTemplateDraft`）。
  - 自动化总数到上限（20）→ 409 `{"error":{"code":"automation_limit",…}}`。
- `PATCH /automations/<id>` `{"name"?,"prompt"?,"schedule"?,"enabled"?,"mode"?}`（至少一项）→ `200 {"automation":{…}}`
  - `enabled` 走 `setAutomationEnabled`，其余走 `updateAutomation`（作用域 = 该自动化自己的工作区）。改计划会同时清掉桌面的自定义规则。
- `DELETE /automations/<id>` → `200 {"ok":true,"deleted":true}`；不存在 404（重试的 DELETE 把 404 当成功）。
- `POST /automations/<id>/run`（立即运行，不改原计划）→ `202 {"ok":true,"status":"queued"}`；
  已有一次手动运行在跑 → `409 {"error":{"code":"automation_run_in_flight",…}}`。带操作编号时重试拿到同一个回执。
- `GET /automations/templates` → `200 {"templates":[{"id","name","description","prompt","schedule","mode"}…]}`：
  Mac 自带模板（和 Mac 自动化页「从模板开始」同一份 `LEO_AUTOMATION_TEMPLATES`，中文）。`schedule` 与自动化视图同形，
  整份原样放回 `POST /automations` 的 `schedule` 也认（按其中的 `cron`）；`mode` 是建议的权限模式（见下文「模式」）。
  iOS 依赖 `id` / `name` / `prompt` / `schedule` 四个字段，用模板建 = `POST /automations` 带该模板的 `prompt` + `schedule`（+ `name`，
  并带 `mode` 或 `template_id`，否则按 `build` 建）；
  `description` / `mode` 是附加字段，旧手机忽略。其它方法 405。目前三条：`leo-daily-brief` 每日早报（`0 9 * * *`，`plan`）、`leo-repo-health` 下班前跑一遍测试
  （`0 18 * * 1-5`，`guarded`）、`leo-weekly-review` 每周回顾（`0 20 * * 0`，`plan`）。
- 不存在的 id 一律 404；id 只允许 `[A-Za-z0-9_.:-]{1,200}`；畸形的 `%` 转义（`decodeURIComponent` 抛 URIError）400。
- `capabilities.features.automations: true`（旧 Mac 没有 → 手机隐藏入口；旧 Mac 上这些路径 404）；
  `capabilities.features.automation_templates: true`（旧 Mac 上 `/automations/templates` 会被当成 id，404）。

### 每日早报模板

提示词要求：先 `brain_brief`，再 `brain_search` 查今天 / 昨天的日报页和最近 3 天新增的知识卡，需要时 `brain_read`
（`leo-brain` MCP 每台配好钥匙的 Mac 都注册，见 `leo-brain-mcp.md`；不可用就跳过并说明）；再看本项目昨天的提交和任务；
最后列 3–5 条能直接动手的「今天要做」。只读：不改文件、不调 `brain_save_card` / `brain_upload`。
**不读日历**：经 `osascript` 读日历 App 会触发 macOS 的自动化 / 日历授权弹窗（TCC），无人值守时没人点，所以跳过。

## 调用方规则

复用会话的那套（`linkPolicy.ts`）：

- 读（`GET`）：任何已配对通道。
- 会让 **全自动（yolo）** 跑起来的写操作必须 `mayUseFullAuto(caller)`（认得出设备），否则 403 `device_not_recognized`：
  建 yolo 自动化；`PATCH` 后模式是 yolo 且改了 `prompt` / `schedule` / `mode` 或 `enabled:true`；立即运行 yolo 自动化。
  只改名、停用、删除不受限（只会让它更安全）。
- 其它写操作和开普通任务同级。

## 幂等

- `POST /automations` 与 `POST /automations/<id>/run` 走现有操作回执（`OperationReceipts`）：同一 `(调用方, 操作编号)`
  重放返回第一次的响应，不重复建 / 不重复跑；同编号不同内容 409 `request_id_conflict`；查询 `GET /operations/<id>`。
- 建成后先写检查点 `{"stage":"automation_created","automationId"}` 再落回执：Mac 恰在两步之间崩溃，重试按检查点回那条自动化，不再建。
  检查点之前崩溃 → 409 `operation_uncertain`，手机应先 `GET /automations` 核对。
- 校验错误、服务错误都作为正常响应落进回执（同编号重试拿到同一个错误，不会卡在 uncertain）。
- `PATCH` 是覆盖语义、`DELETE` 是删到没有，天然幂等，不进回执。
- 立即运行另有领域层 single-flight（同一自动化同时只认领一次手动运行）。

## 运行结束推送

自动化跑出来的是普通桌面任务（不是手机那一轮），会话里的 `run.completed` 不会推给手机。所以单独发一条：

```json
{
  "event": "automation.run.completed",
  "automation_id": "automation-…", "name": "日报",
  "status": "succeeded",                 // succeeded | failed | stopped
  "summary": "今天要做 修登录 bug …",     // 见「运行结果摘要」（≤280 字）
  "task_id": "task-…", "session_id": "task-…",   // 同一个值；手机可直接打开 /harness/sessions/<id>/events
  "run_id": "automation-…:1761181200000", "trigger": "schedule",   // schedule | manual
  "workspace": "/Users/me/app",
  "timestamp": 1761181260.0
}
```

```
调度器(main utilityProcess) ──CronRun──► Window Host: dispatchCronRun ──► 普通任务(task-…) 开跑
手机 POST /automations/<id>/run ──► bridge ──► runAutomationNow ──► dispatchManualAutomationRun ──┘
                                                                     │
任务终态 onDynamicTaskTerminalOutcome ──► trackCronRunOutcome ──► settleCronRunTerminalOutcome（回写运行记录，所有者）
                                                     └──► publishAutomationRunCompleted（进程内）
                                                              │
                         LinkBridge 订阅（有自动化服务时）──► automationRunCompleted ──► 记下 task 以便手机接管
                                                              └──► deps.push ──► RelayLink.pushEvent ──event 帧──► 中继
中继：写 recent_events（手机回前台 /relay/api/events 补拉）+ APNs「⏰ <机器> 定时任务完成 / 没跑成」（App 被杀也能收到；需部署新中继）
```

- 先回写运行记录再推送：手机收到通知后 `GET /automations` 看到的 `last_run` 已是终态。
- 摘要先记下再推送：`last_run.summary` 与推送里的 `summary` 是同一句。
- 每条 `automation.run.completed` 都带 `run_id`：iOS 用 `relay-automation-<run_id>` 作通知 id 去重。
- 只推真正开跑了的运行；派发失败（没模型、Host 未就绪，调度器会重试）不推，看 `last_run.status = dispatch_failed`。
- 推送的任务记进桥接的「可接管任务」（≤50 条，进程内）：手机点通知打开 `task_id`，即使该工作区不在 Mac 最近项目里也能接管查看。
- 中继断线时进 `RelayLink` outbox（超限丢最旧），重连补发；直连（Tailscale）没有推送通道，靠 `GET /automations`。

## 运行结果摘要

`summary`（推送与 `last_run.summary` 同一规则，`automationResults.ts`）：

- `succeeded`：这次运行的**最终助手回复**。运行结束时经 `getTaskSnapshot({messageLimit: 6})` 读该任务最后一条消息：
  必须是助手消息（最后是用户消息 = 还没回复）；取它最后一次工具调用之后的正文段（思考、工具调用及其输出一律不取），
  那段为空就取最后一段正文，没有分段信息用整条 `content`。去 markdown 标记（标题 / 列表 / 引用 / 粗斜体 / 行内代码 /
  链接只留文字 / 代码围栏 / 表格竖线 / HTML 标签）、压空白，超过 280 字截到 279 字加「…」（按字符，不劈 emoji）。
  读不到或为空 → `已在 Mac 上跑完`。
- `failed`：错误原因同样压空白、≤280 字；空则 `运行失败`。
- `stopped`：`运行被停止`。

## 无人值守的审批

自动化跑出来的是桌面任务，没人在 Mac 前时审批会一直挂着。现在：

1. **推给手机**：运行一交给内核（`sendPrompt` ACK 后），Host 发 `publishAutomationRunStarted`；桥接盯住该任务的流。
   没出审批的运行不接管（不进手机任务列表、不写会话日志）；出了第一条审批才把任务接管成会话（和手机点开桌面任务同一条
   `adopt` 路径），从此审批卡与手机自己开的任务**完全一样**：`approval.request` 事件（`session_id` / `approval_id` /
   `run_id` / `command` / `tool` / `description` / `choices`，另加 `automation_id`）先落会话日志再经 `deps.push` →
   中继（APNs、`recent_events`）→ 手机 / 手表；手机用 `POST /harness/sessions/<session_id>/approval` 照常答。
   手机已接管的任务（会话内建的自动化投递回原会话）直接进入无人值守。
   以前：只有手机发起的一轮才推审批，自动化任务的审批从不到手机。
   **提问也接管**（`elicitation_request`，见下文「计划审批与提问」）：计划审批（`ExitPlanMode`）**立刻 `decline`、不推卡、
   不改判**——计划模式下内核提醒强制每轮以 `ExitPlanMode` 收尾，早报这类只读运行的产出此时已有，`decline` 后内核
   `plan_exit_denied` 结束这一轮，运行记成功（以前推卡等 30 分钟，没人批就记成「计划未获批准」，`plan` 模板几乎每次都失败）；
   `AskUserQuestion` 没人能答，立刻 `decline` + `stopGeneration`，运行改判
   `"需要人工回答问题，无人值守已跳过"`。以前提问不接管，运行永远挂着，手动运行的占位（manual claim）也一直不放。
2. **30 分钟自动拒绝**：每条推出去的审批起一个内存计时（`UNATTENDED_APPROVAL_MS`）。到点没人答（手机、手表、Mac 上答都算）：
   记下改判 `failAutomationRun(runId, "审批 30 分钟无人处理,已自动拒绝")`，回内核 `deny`，送到了再 `stopGeneration` 停掉这一轮。**拒绝没送进内核就撤销改判**（`takeAutomationRunFailure`）
   并重新计时：之后有人批了、运行跑成功，不会被记成审批超时（以前先改判后送，没送到也留着改判）。改判在送出之前记下，
   是因为拒绝可能让这一轮立刻结束，Host 收终态时改判必须已经在。
   内核随后报的终态是 `stopped`，Host 的 `trackCronRunOutcome` 取走改判，按 `failed` + 该原因回写运行记录并发
   `automation.run.completed`（`status:"failed"`，`summary` 即该原因）。运行记录仍只有 Host 一个写入方。
3. **计时清除**：审批被答（手机 / Mac）、这一轮结束（`run.completed / failed / cancelled`）、`automation.run.completed`、
   会话或桥接关闭时清掉。答复没送到内核（卡片还在）时重新计时。不持久化：Mac 重启后挂着的审批不再自动拒绝。
4. **计划不推卡**：无人值守运行里的 `ExitPlanMode` 直接 `decline`（见 1），手机收不到计划卡，也就没有「手机拒绝计划」。
   只有接管前就已推给手机的计划卡（极少见）还走计时 / 手机答复，拒绝或超时记 `"计划未获批准"`。

```
dispatchCronRun ─sendPrompt ACK─► publishAutomationRunStarted ─► LinkBridge 盯任务流
                                                                    │ permission_request / elicitation_request
                                                                    ▼
                                         adopt → LinkSession(unattended) ─approval.request─► journal ─► push ─► 中继 ─► 手机/手表
           手机 POST …/approval ───────────────► respondPermission / respondElicitation（计时清掉）
           30 分钟无人答 ──► failAutomationRun ─► deny / decline ─送到─► stopGeneration（没送到 → 撤销改判、重新计时）
           AskUserQuestion ─► failAutomationRun ─► decline ─► stopGeneration
           ExitPlanMode ─► decline（不改判）─► 内核 plan_exit_denied 结束这一轮 ─► 成功
内核终态(stopped) ─► trackCronRunOutcome: takeAutomationRunFailure → failed + 原因 ─► settle（回写） ─► publishAutomationRunCompleted ─► 推送
```

### 模式（`mode`）对无人值守的含义

以 CLI 权限服务（`apps/zcode-cli/packages/core/src/permission/service.ts`）为准：

| mode | 行为 | 无人值守时 |
| --- | --- | --- |
| `plan` | 只读：只读工具与非破坏性 MCP 工具直接放行，写文件 / 执行命令一律**直接拒绝、不问** | 最接近「只读、从不问」。例外：工具自报 `alwaysAsk` 仍会问 → 走上面的推送 / 30 分钟拒绝；提问立刻跳过并记失败；退出计划立刻 `decline`、记成功 |
| `guarded` | 自主：普通调用放行，只有危险命令（`rm`、`git reset --hard` 等）逐次确认 | 偶尔问 |
| `build` | 逐项确认：写文件、执行命令都要批 | 经常问，不适合无人值守 |
| `yolo` | 全自动：不问（要认得出设备才能设） | 不问，也不受只读约束 |

没有「只读且保证从不问」的模式：`plan` 是最接近的，上面的例外不改（不为无人值守另造放行规则）。只读的定时任务
（早报、回顾）建议 `plan`；要跑命令的（测试）建议 `guarded`。

## 计划审批与提问（elicitation）

内核的「退出计划」（`ExitPlanMode`）和「向用户提问」（`AskUserQuestion`）不走权限审批，而是 `elicitation_request`。
手机发起的一轮和无人值守的自动化运行里（Mac 桌面上自己发起的轮次仍留给 Mac 上的人答）：

- **计划审批卡**（`schema.interaction === "plan_approval"`）：发 `approval.request`，`approval_id` = 内核的 `requestId`，
  `tool:"ExitPlanMode"`、`command:"批准计划并开始执行"`、`description` 与 `plan` = 计划正文（`schema.plan`，截到 4000 字），
  `choices:["once","deny"]`（没有「本任务都允许」，手机发 `session` 按 `once`）。和普通审批同一张卡、同一条推送 /
  计时 / 一轮结束收卡逻辑；`pending_approvals[].choices` 同样给 `["once","deny"]`。
  - 批准：`respondElicitation({action:"accept", content:{answer:"approve"}})`（内核 interaction-broker 认的答案）；
    会话报告的模式回到进计划之前的权限模式（多半是 `build`）。
  - 拒绝：`respondElicitation({action:"decline"})`，留在计划模式，内核结束这一轮。
  - Mac 上答了：流里的 `elicitation_response` 让手机收卡（`approval.responded`）。
  - 无人值守运行：不推卡，立刻 `decline`（见上文「无人值守」1），计划正文留在会话记录里当本次产出。
  - 以前：手机那一轮的计划审批被自动 `cancel`，内核记成被拒，这一轮直接结束，计划从没到过手机。
- **其它提问**（`AskUserQuestion`）：手机还答不了。回 `decline`，发 `session.note` 带上问题和选项原文（用户可以直接发消息回答）；
  内核按同一 `requestId` 重发时不再答第二次。手机那一轮不停（agent 按没得到回答继续）；无人值守见上文（改判 + 停）。

**计划模式的上报**：内核的计划模式是 `planEnabled` 开关，设置快照里的 `mode.current` 仍是底下的权限模式（多半是 `build`），
换模型 / 思考档位的设置更新都会带着它来。会话处于 `plan` 时，收到的 `mode_update` 若等于「底下那个模式」（或还不知道底下是什么）
就只记下，不把手机上的模式改成 `build`；换成别的模式才算真切了（内核切到非 plan 模式会关掉 `planEnabled`）。
手机 `POST …/mode` 一律送进内核（不再因为「本地记的已是这个模式」跳过）；发消息时 `full_auto:true` 而任务已是全自动则不再切。

## 链路追踪号

请求带追踪号时（中继帧 `trace_id`；中继若原样转发请求头，也认 `headers` 里的 `X-Leo-Trace-Id`；直连读请求头
`X-Leo-Trace-Id`），`LinkBridge.handle` 为这次请求记一行 info：`[leo/link] request {trace_id, method, path, transport,
status, duration_ms}`（`path` 不含查询串，不记正文；出错记 warn）。`/e2e` 信封和解开后的内层请求各记一行，同一个号。
只认 `[A-Za-z0-9_.:-]{1,128}`，其它当没带；追踪号只是标签，不参与任何判断。中继（0.2.3 起）把手机请求头
`X-Leo-Trace-Id` 截到 64 字放进转发帧的 `trace_id`，慢请求（≥5 秒）和超时各记一行带同一个号，三端日志能对上。

## 已知限制

- 计划只支持 Mac 调度器能表达的：5 段 cron（本地时区）+ 一次性固定日期；桌面「自定义重复」（每 N 天 / 月等）手机只读（`kind:"custom"`），
  手机改计划会把它换成普通 cron。
- Mac 必须开着 App 才会触发（调度器在 Electron 里）；关着的时间里错过的触发按调度器的补跑 / 跳过规则处理。
- 多窗口时，定时触发由 main 分给某个 Window Host；Leo Link 只在抢到本地端口的那个 Host 里。触发落到别的 Host 时
  这次运行不推送（运行记录照常，`GET /automations` 看得到）。单窗口（常态）不受影响。
- 手机还不能直接回答 `AskUserQuestion`：手机那一轮里拒绝并把问题告诉手机，无人值守时跳过并让运行失败。
- Mac 桌面上切换计划模式（v4 `switchCollaborationMode` 不发 `state.updated`）手机不一定马上知道；手机自己切、计划获批时准确。
- 「开跑」只在 `dispatchCronRun` 的 `sendPrompt` ACK 后发出：之前就已出现的审批（实际上至少隔一次模型往返）不会被接管；
  多窗口时开跑落到没有 Leo Link 的 Host 上同样不接管。
- 自动拒绝计时只在内存里：Mac / App 重启后挂着的审批不再自动拒绝。
- 运行结果摘要只在本 Host 的运行结束时算一次；绑定原会话的自动化，若结束前用户在该会话里又聊了，读到的「最后一条助手消息」
  可能不是这次运行的。
- 手机「关闭全自动」（`/harness/full-auto`）只管会话，不改 yolo 自动化；要停就 `PATCH enabled:false`。
- iOS 的补拉（`RelayEventCatchUp`）目前只认 `run.completed` / `run.failed` / `approval.request`：要在 App 前台补拉时显示，
  iOS 端需要加 `automation.run.completed` 分支（APNs 由中继直接发，不依赖它）。

## 验收

- `node --import ./scripts/test-isolation/home.mjs --import tsx --test packages/desktop/src/host/leo/link/automations.test.ts`：
  白名单、计划换算（daily / weekly / hourly / once / cron、非法输入）、描述、请求校验、调用方规则、视图、运行结束广播（`automationPayload.ts` / `automationEvents.ts`）。
  另含运行摘要（去 markdown、≤280、按字符截断、最终回复取法、按运行记下并跨重启）、开跑广播与失败改判、模板（早报用 leo-brain、不读日历）。
- `bridge.test.ts` 的 `automations:` 用例：假自动化服务走完整路由（白名单、列表、建（默认工作区 / 模型 / 模式）、
  同编号重试不重复建、缺编号 400、yolo 需认得出设备、改 / 停 / 删 / 立即运行、运行结束推送与可接管）；
  成功运行推最终回复摘要且 `last_run.summary` 一致、`session_id` 可打开事件流；无人值守审批（不出审批不接管、出了审批推
  `approval.request`、手机能答、超时自动拒绝 + 停止 + 改判、运行结束清计时、普通手机任务不计时）；无人值守的计划审批 / 提问
  （计划卡推手机、超时 decline + 停 + 「计划未获批准」、手机拒绝改判 / 批准不改判、提问立刻 decline + 停 + 改判、重发不重答）；
  没送进内核的自动拒绝不改判；手机那一轮的计划审批卡（批准 accept+approve、拒绝 decline、Mac 上答了收卡、4000 字截断）、
  提问 decline + 问题原文；切模式总送内核、过期的设置更新不把 plan 报成 build；模板端点、畸形转义 400；
  追踪号（中继帧 / 请求头取法、带号请求记一行）。
- `directServer.test.ts`：直连 `PATCH` 带正文、`X-Leo-Trace-Id` 往下传。
- `packages/desktop/test/cronHostSessionCreateTelemetry.test.ts`（vitest，装载生产 `dispatchCronRun`）：「已开跑」只在 `sendPrompt` accepted 后发、首发被拒不发。
- `src/mac/leoagent/test_relay_security.py` 的 `RelayAutomationPushTests`：中继对 `automation.run.completed` 发 APNs。
