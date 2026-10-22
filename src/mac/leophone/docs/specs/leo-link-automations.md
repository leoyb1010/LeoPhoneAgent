# Leo Link：手机管理 Mac 上的定时任务（P3「Mac 当执行者」）

场景：iOS 后台执行不可靠。iPhone 上建的周期 / 定时任务交给常开的 Mac（默认 Mac Studio）去跑：
手机只是遥控器，计划、触发、执行、运行记录都在 Mac 的「自动化」里；跑完把结果推回手机。

实现：`packages/desktop/src/host/leo/link/automationPayload.ts`（计划换算、视图、请求校验、全自动规则，纯函数）、
`automations.ts`（转调自动化服务、错误映射、回执检查点）、
`bridge.ts`（路由、回执、推送）、`automationEvents.ts`（运行结束的进程内广播）、
`packages/desktop/src/host/index.ts` 的 `trackCronRunOutcome`（发布运行结束）。
字段蛇形命名，和 `/harness` 路由同风格、同鉴权（中继 / 直连已配对设备）。

## 状态所有者

- **Mac 的自动化服务是唯一所有者**：定义、启停、下次时间、运行记录都在 `tasks-index.sqlite`，
  只经 `IZCodeAgentService` 的 `listAllAutomations / listAutomationRuns / createAutomation / updateAutomation /
  setAutomationEnabled / deleteAutomation / runAutomationNow` 读写（和桌面「自动化」设置页同一条路径）。
  Leo Link 不直接写它的存储，也不另存一份。
- **手机不存副本**：列表每次 `GET /automations` 现拉；推送事件只是通知，以 `GET` 为准。
- Leo Link 自己只落两样传输层东西：操作回执（`journals/operations/`，幂等用）和推送 outbox（中继断线时攒着）。

## 接口

计划时间一律按 **Mac 本机时区**解释（调度器在 Mac 上跑）。时间戳一律是 Unix **秒**（浮点，同 `/harness/sessions`）。

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
  "enabled": true,
  "state": "active",              // active | paused | completed | failed（领域 lifecycleStatus）
  "workspace": "/Users/me/app",
  "mode": "build",                // plan | guarded | build | yolo；桌面建的可能为 null（跟随工作区默认）
  "target_task_id": null,         // 会话里建的自动化绑定的任务（每次投递回该任务）
  "run_count": 3,
  "last_run": { "status": "succeeded", "at": 1761181200.0, "task_id": "task-…", "trigger": "schedule", "error": null } ,
  "next_run_at": 1761267600.0,    // null = 不会再跑（暂停 / 已完成）
  "created_at": 1761000000.0, "updated_at": 1761000000.0
}
```

`last_run.status`：`running | succeeded | failed | stopped`（任务结果），`dispatch_failed`（没能派发，如没配模型），
`skipped`（错过窗口），`pending`（已认领待派发）。从未跑过为 `null`。

### 端点

- `GET /automations` → `200 {"automations":[automation…]}`（这台 Mac 上全部工作区的，按创建时间新→旧）。
- `GET /automations/<id>` → `200 {"automation":{…}}`。
- `POST /automations`（**必须带操作编号**：中继帧 `request_id` / 直连 `X-Request-Id`；缺了 400）
  `{"name"?:"日报","prompt":"…","schedule":…,"workspace"?:"/Users/me/app","harness"?:"zcode","mode"?:"build","full_auto"?:false}`
  → `201 {"automation":{…}}`
  - `prompt` 必填（≤20000 字）；`name` 缺省取 prompt 前 30 字（≤100 字）。
  - `workspace`（也认 `cwd`）缺省或 `"~"`：和手机开任务同一规则（手机最近在这台 Mac 用过的项目，没有就主目录）；
    必须是 Mac 上存在的目录，否则 400。
  - agent / 模型：`harness` 缺省 `zcode` → 与手机开 LeoBot 任务同一个模型（用户默认或第一个非 acp 模型；一个都没配 409）；
    给外部 agent（`claude` / `codex`…，`/v1/capabilities` 里可用的）→ 用该 ACP agent；不可用 400。
  - 权限：`mode` 缺省 `build`（逐项确认）；`full_auto:true` 等价 `yolo`；显式 `mode` 优先。
  - 自动化总数到上限（20）→ 409 `{"error":{"code":"automation_limit",…}}`。
- `PATCH /automations/<id>` `{"name"?,"prompt"?,"schedule"?,"enabled"?,"mode"?}`（至少一项）→ `200 {"automation":{…}}`
  - `enabled` 走 `setAutomationEnabled`，其余走 `updateAutomation`（作用域 = 该自动化自己的工作区）。改计划会同时清掉桌面的自定义规则。
- `DELETE /automations/<id>` → `200 {"ok":true,"deleted":true}`；不存在 404（重试的 DELETE 把 404 当成功）。
- `POST /automations/<id>/run`（立即运行，不改原计划）→ `202 {"ok":true,"status":"queued"}`；
  已有一次手动运行在跑 → `409 {"error":{"code":"automation_run_in_flight",…}}`。带操作编号时重试拿到同一个回执。
- 不存在的 id 一律 404；id 只允许 `[A-Za-z0-9_.:-]{1,200}`。
- `capabilities.features.automations: true`（旧 Mac 没有 → 手机隐藏入口；旧 Mac 上这些路径 404）。

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
  "summary": "已在 Mac 上跑完",           // 失败时是错误原因（≤200 字）
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
- 只推真正开跑了的运行；派发失败（没模型、Host 未就绪，调度器会重试）不推，看 `last_run.status = dispatch_failed`。
- 推送的任务记进桥接的「可接管任务」（≤50 条，进程内）：手机点通知打开 `task_id`，即使该工作区不在 Mac 最近项目里也能接管查看。
- 中继断线时进 `RelayLink` outbox（超限丢最旧），重连补发；直连（Tailscale）没有推送通道，靠 `GET /automations`。

## 已知限制

- 计划只支持 Mac 调度器能表达的：5 段 cron（本地时区）+ 一次性固定日期；桌面「自定义重复」（每 N 天 / 月等）手机只读（`kind:"custom"`），
  手机改计划会把它换成普通 cron。
- Mac 必须开着 App 才会触发（调度器在 Electron 里）；关着的时间里错过的触发按调度器的补跑 / 跳过规则处理。
- 多窗口时，定时触发由 main 分给某个 Window Host；Leo Link 只在抢到本地端口的那个 Host 里。触发落到别的 Host 时
  这次运行不推送（运行记录照常，`GET /automations` 看得到）。单窗口（常态）不受影响。
- `build` 模式的无人值守运行遇到审批会停在 Mac 上等人（不推审批卡：不是手机那一轮）。接管前就已挂起的审批能否在手机上出现
  尚未验证；无人值守的任务建议用 `guarded`（自主）或在认得出的设备上用 `yolo`。
- 手机「关闭全自动」（`/harness/full-auto`）只管会话，不改 yolo 自动化；要停就 `PATCH enabled:false`。
- iOS 的补拉（`RelayEventCatchUp`）目前只认 `run.completed` / `run.failed` / `approval.request`：要在 App 前台补拉时显示，
  iOS 端需要加 `automation.run.completed` 分支（APNs 由中继直接发，不依赖它）。

## 验收

- `node --import ./scripts/test-isolation/home.mjs --import tsx --test packages/desktop/src/host/leo/link/automations.test.ts`：
  白名单、计划换算（daily / weekly / hourly / once / cron、非法输入）、描述、请求校验、调用方规则、视图、运行结束广播（`automationPayload.ts` / `automationEvents.ts`）。
- `bridge.test.ts` 的 `automations:` 用例：假自动化服务走完整路由（白名单、列表、建（默认工作区 / 模型 / 模式）、
  同编号重试不重复建、缺编号 400、yolo 需认得出设备、改 / 停 / 删 / 立即运行、运行结束推送与可接管）。
- `src/mac/leoagent/test_relay_security.py` 的 `RelayAutomationPushTests`：中继对 `automation.run.completed` 发 APNs。
