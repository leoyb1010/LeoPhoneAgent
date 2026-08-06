-- interrupted-turn-resume:sessions.last_turn_ended_at 由配套脚本
-- drizzle/scripts/0065_equal_shinobi_shaw.ts 以 PRAGMA table_info 守卫幂等添加
-- (SQLite 的 ALTER TABLE ADD COLUMN 不能安全重放,0060/0061/0064 同款模式)。
SELECT 1;
