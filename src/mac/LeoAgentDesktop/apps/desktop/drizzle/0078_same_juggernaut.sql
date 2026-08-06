-- 0078: Worker 创建 reservation 与 team 内 label 唯一约束。
-- 存量库可能已有同名 Worker，直接建 UNIQUE INDEX 会让 migration 在修复数据前失败；
-- 实际 DDL、确定性 label 归一化和去重由同名 companion TS 在一个事务内完成。
SELECT 1;
