-- sidebar-card-mode: sessions.summary 任务现状一句话摘要(可空, null = 未生成),
-- 由 main/sessionTaskSummary.ts 在置顶会话 turn 结束时经 maker.oneShot 生成,
-- 供置顶卡片与折叠 rail flyout 展示。
--
-- 幂等:本仓库自定义 migrator 按整数 schema_version 高水位线应用。部分开发者 DB
-- 因并行迁移血缘(早期 sidebar-card 分支曾以更低 seq 加过该列)已经有了 summary 列,
-- 直接 `ALTER TABLE ADD` 在那些 DB 上会撞 duplicate column 致启动失败回滚,所以真正的
-- 加列逻辑放在 scripts/0048_add_session_summary.ts 里做 PRAGMA 守卫式幂等添加
-- (见 0024 / 0038 先例)。
SELECT 1;
