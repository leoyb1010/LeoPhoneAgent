-- 0066: messages_fts 瘦身——tool_result / tool_use / thinking 不再进全文索引。
-- 真实重建逻辑在配套脚本 drizzle/scripts/0066_slim_messages_fts.ts(需要
-- "messages 表存在"守卫, 纯 SQL 表达不了——最小 fixture 库可能没有 messages 表),
-- SQL 文件只保留占位语句(0060 / 0061 / 0064 / 0065 同款模式)。
SELECT 1;
