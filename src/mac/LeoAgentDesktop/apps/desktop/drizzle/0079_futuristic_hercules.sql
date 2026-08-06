-- 0079: 仅给升级前已经存在的自动化任务保留 legacy session fallback。
--
-- migration replay 还要兼容只有部分历史表的 lineage bridge 测试库，因此实际
-- ALTER / backfill 放在同名 companion TS 中按 schedules 是否存在原子执行。
SELECT 1;
