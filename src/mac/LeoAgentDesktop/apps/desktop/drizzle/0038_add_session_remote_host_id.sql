-- Codex 远端 session: sessions.remote_host_id 持久化目标机器 alias(字段可空,
-- null = 本地 session)。原本在 codex 远端 MR(!175)里以 0036 生成,但合并回 main 时
-- 主干已推进到 0037 → 撞号。重排为 0038。
--
-- 幂等:本仓库自定义 migrator 按整数 schema_version 高水位线应用,且因撞号导致部分
-- 开发者 DB 已经通过旧的 0036_add_session_remote_host_id 拿到了这列。直接 `ALTER TABLE
-- ADD` 在那些 DB 上会撞 duplicate column 致启动失败回滚,所以真正的加列逻辑放在
-- scripts/0038_add_session_remote_host_id.ts 里做 PRAGMA 守卫式幂等添加(见 0024 先例)。
SELECT 1;
