-- 计划模式独立成一级开关(issue #475):历史上以 permission_mode='plan' 表达的计划
-- 模式会话,转换为 plan_mode_enabled=1 + permission_mode='ask'(底层权限档回到保守
-- 默认,与新建会话默认一致)。
--
-- 幂等:SQLite ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS 语义,直接 ADD 重放会撞
-- duplicate column。真正的加列与回填逻辑放在 scripts/0060_orange_penance.ts
-- 里做 PRAGMA 守卫式幂等执行(见 0038 / 0048 先例)。
SELECT 1;
