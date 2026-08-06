-- 0069: custom_providers 加 auth 列（自定义供应商 OAuth 形态的鉴权配置 JSON，可空）。
-- SQLite 的 ALTER TABLE ADD COLUMN 无 IF NOT EXISTS 语义，无法安全重放；
-- 实际加列在配套脚本 scripts/0069_unusual_loki.ts 里用 PRAGMA table_info 守卫完成（模式同 0060/0068）。
SELECT 1;
