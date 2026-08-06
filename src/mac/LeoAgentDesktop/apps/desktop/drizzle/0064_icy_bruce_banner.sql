-- interrupted-turn-resume:sessions 表加 active_turn_started_at / active_turn_pid
-- 两列(turn 在飞持久化标记,app 异常退出后由启动扫尾判定中断并补中断标记行)。
--
-- 幂等:SQLite ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS 语义,直接 ADD 重放会撞
-- duplicate column。真正的加列逻辑放在 scripts/0064_icy_bruce_banner.ts 里做
-- PRAGMA 守卫式幂等执行(见 0038 / 0048 / 0060 / 0061 先例)。
SELECT 1;
