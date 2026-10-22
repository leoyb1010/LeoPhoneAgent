# Leo Link 远控扩展：模型 / 推理强度 / 会话操作 / 关注（契约 v1，2026-10-22）

手机（iOS / iPad / Watch）经 Leo Link 远控 Mac 上的 Agent 会话。本文是 Mac 与 iOS 两端共同遵守的契约；
字段都是可选新增，旧版 iPhone / 旧版 Mac 互相兼容（看不到新字段就按旧行为）。

## 能力开关

`GET /v1/capabilities` 的 `features` 新增（为 true 才显示对应控件）：
`models`、`model_switch`、`effort`、`compact`、`rename`、`attachments`、`ask_user_question`、`follow`。

## 模型与推理强度

- `GET /harness/models` →
  `{"models":[{"provider":"<providerId>","provider_name":"<显示名>","model":"<modelId>","name":"<显示名>","efforts":["low","medium","high",...],"default_effort":"<值或 null>"}],"default":{"provider","model","effort"}|null}`
  - 只列 LeoBot 会话可用的模型（与桌面模型选择器同源：IModelSelectionService）；`efforts` 来自 `optionSpecs.reasoningLevel.values`，没有就是 `[]`。
- 会话摘要（`GET /harness/sessions` 每行）新增 `"model": {"provider","model","name","effort"} | null`。
- `POST /harness/sessions/:id/model`：`{"provider","model","effort"?}` 换模型（可同时给强度）；或只给 `{"effort":"high"}` 只改强度。
  成功 `200 {"model":{...}}`；不认识的模型 / 强度 400；任务不在本机 404。对运行中的回合，从下一回合起生效。
- 事件：`{"event":"model","model":{...}}`（换了就发，手机据此刷新）。
- 新建 `POST /harness/sessions` 可带 `"model":{"provider","model"}`、`"effort":"<值>"`；旧字段 `thinking` 视作 `effort`。都不带 = 现在的自动选择。

## 会话操作

- `POST /harness/sessions/:id/compact` → `202 {"ok":true}`（走内核 compact，不是把 "/compact" 当文字发给模型）。
- `POST /harness/sessions/:id/rename` `{"title":"..."}` → `200 {"title":"..."}`（真正改任务标题，桌面也看到）。
- 发送附件：`POST /harness/sessions/:id/send` 可带 `"attachments":[{"name":"x.jpg","mime":"image/jpeg","data_base64":"..."}]`；
  仅图片（jpeg/png/heic/webp），每张 ≤ 5 MB、最多 4 张，超了 413。
- 回答模型的提问（AskUserQuestion）：手机发起的回合遇到提问，事件 `{"event":"question.request","question_id":"...","questions":[{"question","header"?,"options":[{"label","description"?}],"multi_select":bool}]}`；
  回答 `POST /harness/sessions/:id/answer` `{"question_id","answers":[{"question":"...","selected":["label",...],"text"?:"自由输入"}]}`，或 `{"question_id","decline":true}`。
  无人值守仍按现状直接结束并写明原因。答完发 `{"event":"question.responded","question_id"}`。
- 计划审批卡：`approval.request` 里 `tool=="ExitPlanMode"` 时带 `plan`（≤4000 字）与 `choices:["once","deny"]`；手机按 `choices` 只显示给出的按钮。

## 关注（省电）

- 每个会话有持久化的 `following`（存 sessions.json，Mac 重启不丢）；会话摘要带 `following` 与 `source`（`phone`/`desktop`/`automation`/`takeover`）。
- 手机新建 / 接管 / 发消息 ⇒ 自动 `following=true`；只是打开看看桌面任务 ⇒ 不变（默认 false）。
- `POST /harness/sessions/:id/follow` `{"following":bool}` → `200 {"following":bool}`，并发事件 `{"event":"follow","following":bool}`。
- **推送只发给关注的会话**：`approval.request`、`run.*` 只有 `following==true` 才 push 到中继（中继才会发 APNs / 实时活动）。不关注的会话事件照常记日志、手机打开时照常看得到，只是不推送。
- 定时任务新增 `notify` 布尔：手机建的默认 true，桌面建的默认 false，PATCH 可改；`automation.run.completed` 与无人值守审批只有 `notify==true`（或目标会话被关注）才推送。无人值守 30 分钟自动拒绝不受影响。
- iOS：「进行中」只列关注的会话（其余只显示数量）；有关注的任务在跑才每 20 s 刷新，否则 60 s；只给关注的会话申请实时活动推送令牌；不关注的会话不发审批本地通知；补拉用与中继相同的通知 id 去重。

## Mac 实现细节（[remote-ctl-mac]，契约之外的补充与取舍）

以下是 Mac 端按上面契约实现时定下的细节，iOS 需要知道的都在这里；上面的字段一个没改。

- **模型清单**：`name` 目前就是 `modelId`（注册表没有单独的模型显示名）；`provider_name` 无名时回落 `providerId`。
  排除 acp 供应商和 `enabled:false` 的模型。`default_effort` = 该模型档位的最后一项（与自动选择同一规则），没有档位为 `null`。
  这台 Mac 没有模型服务时 `GET /harness/models` 为 404，capabilities 的 `models` / `model_switch` / `effort` 为 false。
- **换模型**：外部 agent（claude / codex …）的会话 400；只给 `effort` 但任务还没模型 409；只给 provider 不给 model 400。
  换模型不带 `effort` 时内核用目标模型的默认档位，返回的 `model.effort` 以内核读回为准。
  Mac 桌面上换模型 / 档位也会发 `model` 事件（来自内核的模型状态更新）。外部 agent 会话的 `model` 为 `null`。
- **新建**：`model` 格式不对 / 不认识、`effort` 不在档位里 → 400；旧字段 `thinking` 只是尽力而为：不认识的值静默忽略（旧 iPhone 的取值不受本契约约束）。
- **压缩**：任务在跑（running / waiting_for_approval）时 409。结果以会话提示告诉手机：
  `{"event":"session.note","kind":"compacted"}` 或 `{"event":"session.note","kind":"compact_failed","text":"…"}`。
- **改名**：`title` 去首尾空白、压空白，空 400，超过 200 字 400。
- **附件**：类型不对 415（`image/jpg` 认作 jpeg，`image/heif` 认作 heic），base64 不合法 400；HEIC 在 Mac 上用 `sips` 转成 JPEG 再交给内核（内核不认 HEIC）。
  有图时 `text` 可以为空。日志里的 `user.message` 带 `attachments:[{"name","mime"}]`（不含图片数据）。
  **传输上限比 5 MB 小得多**：中继（relay.py，aiohttp 默认 `client_max_size`）整个请求正文 ≤ 1 MB，超了中继把正文丢成空（Mac 回 400 text is required）；
  直连正文 ≤ 2 MB；经中继端到端加密的信封密文 ≤ 4 MB。iOS 发图前要压缩 / 缩放，让整个 JSON 正文（base64 后）落在所走链路的上限内；
  Mac 端的 5 MB / 4 张只是最后一道校验。
- **提问**：
  - 同时发一条 `{"event":"session.note","kind":"question_pending","text":"…问题原文…"}` 给旧版手机看；新版手机可按 `kind` 隐藏。
  - 旧版手机答不了，直接发消息即可：`send` 时还挂着的提问先替它跳过（decline），消息照常送进去。
  - `selected` 填选项的 `label`（也认内核的 value）；某题没答就不提交（与桌面一致，agent 按最佳判断继续）。
  - `question.responded` 可能带 `"declined":true`（手机跳过）或 `"expired":true`（这一轮结束了还没答）；Mac 上答掉的不带。
  - 没有这个待答提问（已答 / 已过期）409。`question.request` 不交给中继推送（不在推送事件里），只在事件流里。
- **关注**：手机自动关注（新建 / 接管 / 发消息）时也发 `follow` 事件。关注的会话里 Mac 桌面上发起的一轮也会推送
  （推送只看 `following`，不再看是谁发起的这一轮）。`POST …/follow` 对还没接过来的桌面任务先接管（和发消息一样）；这台 Mac 上没有 404。
  升级前的任务表行没有这几项：`following=false`（手机再发消息就会关注），`source` 有终端会话 id 记 `takeover`，否则记 `phone`。
  桌面任务行：`"following":false,"source":"desktop","model":null`。
- **notify**：`POST /automations` 也接受可选 `notify`（默认 true）；`PATCH` 可只改 `notify`；GET / 列表每条带 `notify`。
  notify 存在 Link 自己的 `journals/automation-notify.json`（自动化服务没有这个字段）。没有记录的 = false（桌面建的）。
  升级前手机建的定时任务没有记录：第一次读时从操作回执（手机经 Link 建定时任务必带操作编号，回执里有 201 响应的 automation.id）认出来记成 true，
  保持它们升级前「跑完就推」的体验；只迁移一次。
