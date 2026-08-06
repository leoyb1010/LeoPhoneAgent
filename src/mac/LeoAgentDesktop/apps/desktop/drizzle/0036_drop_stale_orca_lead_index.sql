-- F-COLLAB 修复:删除残留的全表 unique 索引 `uniq_orca_workflows_lead_session_id`。
-- migration 0030 本应把它换成 partial 索引 (`uniq_orca_workflows_active_lead_session_id`,
-- WHERE status='active'),但在多 worktree 共用同一用户 DB 的 dev 环境里,旧分支的
-- schemaDriftRepair(只增不删)会把这个旧索引补建回来。残留后,只要某个 lead session
-- 有过历史 workflow(completed/cancelled/failed),再开协同时 createActiveWorkflow 的
-- INSERT 就会撞上全表 unique → "开启协同失败"。
-- 幂等 DROP:有残留就删,干净 DB 上是 no-op。
DROP INDEX IF EXISTS `uniq_orca_workflows_lead_session_id`;
