-- 0075: schedule_runs 增加前置检查结构化结果。
-- SQLite 的 ALTER TABLE ADD COLUMN 无 IF NOT EXISTS 语义，无法安全重放；
-- 实际加列在配套脚本 scripts/0075_complex_strong_guy.ts 里用 PRAGMA table_info 守卫完成。
SELECT 1;
