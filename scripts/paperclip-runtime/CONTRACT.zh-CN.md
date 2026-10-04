# 本次真实 HTTP 烟测的固定契约核对

唯一上游：`994d6edcdd4e15d5f9cc5cf8c135ac599104b86a`。范围仅是 `smoke.mjs` 使用的请求；此表是源码交叉核对，不能代替 CI 实际通过。

| 检查 | 请求与断言 | 固定源码依据 |
|---|---|---|
| 健康 | `/api/health` 的 `status=ok`、`deploymentMode=authenticated`、固定 commit；匿名响应不要求 `authReady` | `ui/src/api/health.ts` 将 authReady 声明为可选；首轮真实 CI 的 health.json 已确认省略；`server/src/routes/health.ts` |
| 人类登录 | Better Auth `sign-up/email` 的 name/email/password，`sign-in/email` 的 email/password；Cookie 由响应保存且不记录 | `ui/src/api/auth.ts` 的 signUpEmail/signInEmail，与 `server/src/auth/better-auth.ts` emailAndPassword |
| 人类会话/退出 | `GET /api/auth/get-session` 返回 user；匿名或旧Cookie注销后 **401** | `server/src/routes/auth.ts` 的 board/userId guard、`server/src/__tests__/auth-routes.test.ts`；不误用 Better Auth 裸 get-session 的 null 约定 |
| 首管理员 | authenticated + private 测试实例 `POST /api/bootstrap/claim {}`；必须已是 source=session 的人类用户 | `server/src/routes/access.ts:2742` 的部署模式和会话守卫 |
| 组织 | `POST /api/companies {name,description}` 创建返回组织；owner membership自动建立；读取 `?scope=accessible`；PATCH requireBoardApprovalForNewAgents | `server/src/routes/companies.ts:1193`；`packages/shared/src/validators/company.ts`；`ui/src/api/companies.ts` |
| 创建任务 | title/description/backlog/idempotencyKey；同请求同键返回同ID；随后GET校验companyId | `packages/shared/src/validators/issue.ts` createIssueSchema；`server/src/services/issues.ts:9845` 的事务锁和去重记录（保留7天） |
| 回复 | body + UUID clientRequestId；两次返回同ID，GET comments数组只有一条该请求记录 | `validators/issue.ts:1055`；`services/issues.ts:12245` 按issue/authorUserId/clientRequestId查重；`routes/issues.ts:15279` 返回数组 |
| 状态/文档 | PATCH blocked；PUT documents/output 的 format=markdown、body、title；GET文档断言body | `routes/issues.ts` 状态更新及 `:10139` 文档PUT；`validators/issue.ts:2187`；GET文档直接返回doc |
| 审批 | type=approve_ceo_strategy、payload对象、issueIds数组；按任务读取关联审批；approve返回approved | `validators/approval.ts`；`routes/approvals.ts:222,286`；`services/approvals.ts` 仅hire_agent分支创建新执行体，策略审批不需要真实模型 |
| 确定性执行器 | role=ceo、adapterType=process、Node命令+args+timeoutSec；没有模型密钥 | `validators/agent.ts:87`；`routes/agents.ts:2195` 支持已注册process，`:2218` native provider检查只适用于paperclip_runner；`adapters/process/execute.ts` |
| 任务唤醒 | PATCH分配assigneeAgentId并设todo；等待任务历史中的runId，而非把HTTP成功当运行完成 | `routes/issues.ts` 的assignment wakeup；`routes/activity.ts:350`、`services/activity.ts:391` 明确历史字段为runId/agentId/status |
| 运行/日志 | GET heartbeat-runs/:id的companyId、终态succeeded；log返回content包含确定性中文输出 | `ui/src/api/heartbeats.ts` 与 `routes/agents.ts`；process适配器按exitCode记录结果 |
| 取消 | 更新同一process执行器为等待命令；heartbeat/invoke返回真实run.id，等待running，POST cancel再GET等待cancelled | `routes/agents.ts:6211,6326,7020`；取消API明确写operator取消归因 |

所有远端身份/资源ID都取自同一临时实例的真实响应，不硬编码真实账号或环境。测试公司没有真实模型提供商。公开匿名健康响应、board会话、agent run JWT是不同边界；烟测没有拿agent密钥充当人类身份。
