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
