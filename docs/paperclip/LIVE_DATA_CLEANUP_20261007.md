# 线上数据清理程序（LEO 组织，2026-10-07）

适用：Paperclip 中文发行层 1.1.8 部署到 Mini **之后**执行。本文只给程序，不含连接串、口令或主机名；所有 SQL 在服务用户的 `psql` 会话内对本项目库执行，先 `BEGIN`，核对计数后再 `COMMIT`。

执行顺序：**先 1.1（排队消息）再部署/重启 1.1.8** 也可以，但 1.1.8 的服务端只在"任务被取消的那一刻"收尾排队消息；线上 LEO-11 是历史遗留，必须手动处理。1.1.8 的前端已不再在已取消/已完成任务上显示恢复横幅与恢复卡片，所以 UI 的"消失"不能作为数据已清理的证据，必须按 §1.4 核对。

表与状态值（来自 `packages/db/src/schema`、`packages/shared/src/constants.ts`）：

| 表 | 关键列 | 本次用到的状态值 |
|---|---|---|
| `issues` | `id, company_id, identifier, status, cancelled_at, hidden_at, assignee_agent_id, execution_run_id` | `cancelled`（终态） |
| `agent_wakeup_requests` | `id, company_id, agent_id, status, payload(jsonb: issueId, _paperclipWakeContext.wakeCommentIds, executionWait), finished_at, error` | `deferred_issue_execution` → `cancelled` |
| `issue_recovery_actions` | `id, company_id, source_issue_id, status, cause, evidence(jsonb), outcome, resolution_note, resolved_at` | `active/escalated` → `resolved`，`outcome='cancelled'` |
| `heartbeat_runs` | `id, status, finished_at, error_code, context_snapshot(jsonb: issueId)` | 只读核对 |
| `projects` | `id, status, archived_at` | `archived_at` 置值即归档 |
| `agents` | `id, status` | `terminated` 即"已归档"（上游没有 archived_at） |

## 1. LEO-11 / LEO-1：遗留恢复状态

### 1.1 干跑：列出涉及的行（只读）

```sql
-- 目标任务
select i.id, i.identifier, i.status, i.cancelled_at, i.assignee_agent_id, i.execution_run_id
from issues i join companies c on c.id = i.company_id
where c.issue_prefix = 'LEO' and i.identifier in ('LEO-11', 'LEO-1');

-- (a) 仍在"等待恢复处理"的已保存消息（唤醒请求）
select w.id, w.status, w.agent_id, w.requested_at, w.payload->>'issueId' as issue_id,
       w.payload->'_paperclipWakeContext'->'wakeCommentIds' as wake_comment_ids,
       w.payload->'executionWait'->>'message' as execution_wait
from agent_wakeup_requests w
where w.status = 'deferred_issue_execution'
  and w.payload->>'issueId' in (select i.id::text from issues i join companies c on c.id = i.company_id
                                where c.issue_prefix = 'LEO' and i.identifier in ('LEO-11', 'LEO-1'));

-- (b) 仍挡住执行/显示"Board decision required"的恢复记录
select r.id, i.identifier, r.status, r.cause, r.outcome, r.resolved_at,
       r.evidence->'automaticRecovery'->>'replay' as replay_hold,
       r.evidence->>'runId' as run_id
from issue_recovery_actions r join issues i on i.id = r.source_issue_id join companies c on c.id = i.company_id
where c.issue_prefix = 'LEO' and i.identifier in ('LEO-11', 'LEO-1')
  and (r.status in ('active', 'escalated') or r.evidence->'automaticRecovery'->>'replay' = 'blocked');

-- (c) 这两个任务仍未结束的运行（预期 0 行；若有，先在 UI"检查运行 → 取消"）
select h.id, i.identifier, h.status, h.started_at, h.error_code
from heartbeat_runs h join issues i on i.id = (h.context_snapshot->>'issueId')::uuid join companies c on c.id = i.company_id
where c.issue_prefix = 'LEO' and i.identifier in ('LEO-11', 'LEO-1')
  and h.status in ('queued', 'scheduled_retry', 'running');

-- (d) 其他任务是否被这两个任务阻塞（只读；预期 0 行）。阻塞关系在 issue_relations（type='blocks'：
--     issue_id 是阻塞方，related_issue_id 是被阻塞方）；流水线用例另有 pipeline_case_blockers。
select r.id, r.issue_id as blocker, r.related_issue_id as blocked
from issue_relations r
where r.type = 'blocks'
  and r.issue_id in (select i.id from issues i join companies c on c.id = i.company_id
                     where c.issue_prefix = 'LEO' and i.identifier in ('LEO-11', 'LEO-1'));
```

### 1.2 处理（状态更新，不删除审计行）

优先用 API（已登录的实例管理员浏览器会话，`Origin` 必须是站点自身）：

- 已保存消息：`DELETE /api/issues/LEO-11/queued-comments/<commentId>`（`commentId` 取 §1.1(a) 的 `wake_comment_ids`）。该路由只允许 board 用户，内部走 `discardQueuedComment`，效果等同下面的 SQL。
- 恢复记录：`POST /api/issues/LEO-11/recovery-actions/resolve` 只对 `active/escalated` 的记录有效（LEO-1 可用，body `{"outcome":"cancelled","resolutionNote":"task cancelled; manual cleanup 2026-10-07"}`）；LEO-11 的记录已是 `resolved` 但带 `replay='blocked'`，该路由返回 404，只能用 SQL。

SQL（一次事务）：

```sql
begin;
-- (a) 已保存消息：标记取消（1.1.8 在取消任务时做同样的事）
update agent_wakeup_requests w
set status = 'cancelled', finished_at = now(), error = 'issue_cancelled_manual_cleanup_20261007'
where w.status = 'deferred_issue_execution'
  and w.payload->>'issueId' in (select i.id::text from issues i join companies c on c.id = i.company_id
                                where c.issue_prefix = 'LEO' and i.identifier in ('LEO-11', 'LEO-1'));

-- (b1) 仍活跃的恢复记录（LEO-1 的 "Board decision required"）：解决为 cancelled
update issue_recovery_actions r
set status = 'resolved', outcome = 'cancelled', resolved_at = now(),
    resolution_note = coalesce(resolution_note || ' | ', '') || 'manual cleanup 2026-10-07: source issue cancelled'
from issues i join companies c on c.id = i.company_id
where r.source_issue_id = i.id and c.issue_prefix = 'LEO' and i.identifier in ('LEO-11', 'LEO-1')
  and r.status in ('active', 'escalated');

-- (b2) 已解决但仍带 replay='blocked' 保留的记录：去掉保留标记（保留其余证据）
update issue_recovery_actions r
set evidence = jsonb_set(r.evidence, '{automaticRecovery,replay}', '"released_manual_cleanup_20261007"'::jsonb)
from issues i join companies c on c.id = i.company_id
where r.source_issue_id = i.id and c.issue_prefix = 'LEO' and i.identifier in ('LEO-11', 'LEO-1')
  and r.evidence->'automaticRecovery'->>'replay' = 'blocked';
-- 这里核对 §1.3 的行数后再提交
commit;
```

### 1.3 预期行数（已按 2026-10-07 只读干跑核对）

- (a) 更新 **1** 行（LEO-11 的一条已保存消息）；LEO-1 为 0。
- (b1) 更新 **0** 行：LEO-1 唯一的恢复记录已是 `status=cancelled/outcome=cancelled`（cause `stranded_assigned_issue`），没有 active/escalated 记录。
- (b2) 更新 **1** 行（LEO-11 的 `replay='blocked'` 保留）。若实际行数不同，以干跑为准，不要扩大范围。
- (c)(d) 预期 0 行；非 0 时停止，先处理运行/阻塞再继续。

### 1.3.1 LEO-1 页面上的 "Automatic recovery blocked / Board decision required"

这不是恢复卡片，而是上游在搁浅时写入任务线程的**系统评论**（`server/src/services/recovery/stranded-notice.ts`：标题 "Automatic recovery blocked"，元数据行 "Recovery action <uuid>"、"Recovery owner: Board decision required"、"Next action …"）。它随恢复记录取消而不会更新或删除；1.1.8 只对已完成/已取消任务隐藏由 `executionBlocker` / `activeRecoveryAction` 驱动的横幅与卡片（后者对 cancelled 记录本就为 null），**不会隐藏线程里的历史评论**。如需去掉：以 board 身份 `DELETE /api/issues/LEO-1/comments/<commentId>`（`commentId` 用 `select id, created_at from issue_comments where issue_id = <LEO-1 id> and body like '%Automatic recovery blocked%'` 取得），或保留作为历史。该评论的中文化由设计侧（server-copy 补丁）处理，只影响新写入的评论。

### 1.4 UI 核对

1. 重新打开 `/LEO/issues/LEO-11`：无"需要恢复处理"横幅、无"N 条消息正在等待恢复处理"、无待处理（pending）排队消息；"更多任务操作"不再提供重试。
2. `/LEO/issues/LEO-1`：无"Automatic recovery blocked / Board decision required"卡片。
3. `GET /api/issues/LEO-11` 返回 `executionBlocker: null`、`activeRecoveryAction: null`（这是数据层证据，1.1.8 前端隐藏不影响该字段）。
4. 服务日志不再出现 `POST /api/issues/LEO-11/recovery-actions/resolve 404` 与 `wakeup 409 (retry_failed_run)`。

## 2. 已删除/停用的智能体（'Leo的小跟班'、'LeoHermers'）

上游表示法：`agents.status = 'terminated'`（`POST /api/agents/:id/terminate`，撤销 API 密钥，智能体页默认隐藏）；硬删除是 `DELETE /api/agents/:id`，会一并删除其运行、评论、唤醒请求，但**不删除** `cost_events`，且 `cost_events.agent_id` 无级联 —— 有费用记录的智能体硬删除会失败。因此"归档"= `terminated`，不要硬删。

- 干跑已确认两名智能体均为 `terminated` 且无活跃 API 密钥：**§2 无需改数据**，只需 1.1.8 的代码侧归档展示。
- 若将来还有需要归档的智能体（`select id, name, status from agents where company_id = (select id from companies where issue_prefix='LEO') and name in ('Leo的小跟班','LeoHermers')`）：对每个执行 `POST /api/agents/<id>/terminate`（或 SQL `update agents set status='terminated', updated_at=now() where id=<id>`，再 `update agent_api_keys set revoked_at=now() where agent_id=<id> and revoked_at is null`）。
- 若已被硬删除：没有可恢复的行；时间线会显示 "Unknown agent"。
- 1.1.8 代码侧：审计时间线的 `actors[].archived` 对 `terminated` 或已不存在的智能体为 `true`，时间线"智能体"计数排除它们，行标签追加"（已归档）"；总览/智能体页本来就不计 `terminated`。词元差异来源不同不会"归零"：时间线按 `heartbeat_runs.usage_json`（只含能关联到任务且落在窗口内的运行），费用页按 `cost_events`（含未关联任务、运行已删除的事件）。

## 3. 已取消任务与项目 "Onboarding" 归档

- 任务：上游没有独立于 `cancelled` 的"归档"状态。LEO-11 已是 `cancelled`（终态，不再执行，1.1.8 不显示恢复横幅）。从列表/收件箱隐藏：`PATCH /api/issues/LEO-11` 与 `PATCH /api/issues/LEO-1` body `{"hiddenAt":"<ISO 时间>"}`（服务端 `updateIssueSchema.hiddenAt`，board 会话 + 站点 Origin），或仅对当前用户 `POST /api/issues/<id>/inbox-archive`。
- `hidden_at` 的作用范围（`server/src/services/issues.ts` 9 处 `hidden_at IS NULL` 过滤与 `issues` 表的部分索引）：任务列表/看板、收件箱（我的/受阻/全部）、侧栏未读与数量徽标、父任务的子任务计数与"仍有阻塞项"判断、依赖就绪计算都不再包含它；直接打开 `/LEO/issues/LEO-11` 仍可查看；审计时间线、运行记录、费用（按 `heartbeat_runs` / `cost_events`）不受影响；没有 UI 控件可取消隐藏，只能再 `PATCH {"hiddenAt": null}`。除此之外没有其它副作用（不改状态、不触发唤醒、不删数据）。
- 项目 Onboarding：`PATCH /api/projects/<projectId>` body `{"archivedAt":"<ISO 时间>","status":"cancelled"}`（UI：项目 → 配置 → 归档项目；状态是手动字段，上游不会在所有任务取消后自动变更）。归档后项目列表隐藏，直接 URL 仍可查看。
- 核对：`/LEO/projects` 不再显示 Onboarding；`GET /api/projects/<id>` 返回 `archivedAt` 非空。

## 4. 回滚

所有更新都是状态列：(a) 可改回 `status='deferred_issue_execution', finished_at=null, error=null`；(b1) 改回 `status='active', outcome=null, resolved_at=null`；(b2) 把 `replay` 改回 `"blocked"`；项目把 `archived_at` 置 `null`；智能体 `status` 改回 `idle`（API 密钥需重新生成）。
