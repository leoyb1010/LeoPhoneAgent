-- 0076: schedule_runs 增加逐 run 费用快照与归因状态。
-- SQLite 的 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS，无法安全重放；
-- 实际加列在配套脚本 scripts/0076_melted_post.ts 中用 PRAGMA table_info 守卫完成。
SELECT 1;
