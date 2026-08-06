-- 定时任务 in-flight 心跳租约:schedule_runs 表加 heartbeat_at 列。执行实例周期
-- 续期,僵尸清理只回收心跳过期的 'running' 行,不再误标共库另一活实例正在跑的 run。
--
-- 幂等:SQLite ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS 语义,直接 ADD 重放会撞
-- duplicate column。真正的加列逻辑放在 scripts/0062_flaky_mimic.ts 里做
-- PRAGMA 守卫式幂等执行(见 0060 / 0061 先例)。
SELECT 1;
