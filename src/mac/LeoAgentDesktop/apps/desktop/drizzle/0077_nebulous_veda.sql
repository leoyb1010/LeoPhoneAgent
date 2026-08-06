-- session-agent-switch: messages.agent_kind(text, nullable)——逐行 denormalize
-- 产出该消息的 agent 引擎('cc' / 'codex'),NULL = 切换功能上线前的老消息(按
-- session.agent_kind 解析,向后兼容)。
--
-- 幂等:真正的加列逻辑放在 scripts/0077_nebulous_veda.ts 里做 PRAGMA 守卫式
-- 幂等添加(沿用 0038 模式)——migration replay 的部分 fixture DB 没有 messages 表
-- (如 v39 Orca fixture),裸 ALTER 会直接炸;列已存在时同样 no-op。
SELECT 1;
