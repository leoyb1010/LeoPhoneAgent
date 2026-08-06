-- 桥接旧 XDMaker 分支曾发布的 0047/0060/0062/0063/0064 migration lineage。
-- 精确识别、幂等补 schema / 数据、收敛 migration_history 的逻辑在同名 TS 脚本中；
-- SQL 保持无副作用占位，未知或部分匹配的 lineage 绝不自动改写。
SELECT 1;
