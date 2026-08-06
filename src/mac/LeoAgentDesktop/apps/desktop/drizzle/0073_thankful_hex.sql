-- 0073: schedules 增加 script-only 自动化执行配置。
-- SQLite 的 ALTER TABLE ADD COLUMN 无 IF NOT EXISTS 语义，无法安全重放；
-- 实际加列在配套脚本 scripts/0073_thankful_hex.ts 里用 PRAGMA table_info 守卫完成（模式同 0069/0071）。
SELECT 1;
