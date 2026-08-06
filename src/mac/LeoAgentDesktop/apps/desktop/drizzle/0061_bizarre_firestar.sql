-- 定时任务前置检查脚本(Pre-run Hook):schedules 表加 pre_run_hook_command /
-- pre_run_hook_timeout_ms / skip_log_session_id 三列。
--
-- 幂等:SQLite ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS 语义,直接 ADD 重放会撞
-- duplicate column。真正的加列逻辑放在 scripts/0061_bizarre_firestar.ts 里做
-- PRAGMA 守卫式幂等执行(见 0038 / 0048 / 0060 先例)。
SELECT 1;
