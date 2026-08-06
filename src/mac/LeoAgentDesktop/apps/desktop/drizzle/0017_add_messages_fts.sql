-- Maker Memory: messages 表挂 FTS5 影子表 + 三个同步触发器 + 一次性回填。
-- 给 lizi_memory MCP 的 session_search tool 提供历史对话全文检索 (Hermes 风格)。
--
-- standalone FTS5 (而非 external content): messages.id 是 text uuid 不是 INTEGER PK,
-- 不满足 external content 的 content_rowid 要求, 改用 standalone + 触发器同步 row 数据。
-- 多份冗余空间换实现简单 + snippet() 高亮可用。
--
-- rewind_at IS NOT NULL 的软删 row 不进 FTS (跟 messages list IPC 过滤策略一致)。

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  message_id UNINDEXED,
  session_id UNINDEXED,
  role UNINDEXED,
  content,
  tokenize='porter unicode61'
);
--> statement-breakpoint

INSERT INTO messages_fts(message_id, session_id, role, content)
  SELECT id, session_id, role, content
  FROM messages
  WHERE rewind_at IS NULL;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS messages_fts_insert
AFTER INSERT ON messages
WHEN new.rewind_at IS NULL
BEGIN
  INSERT INTO messages_fts(message_id, session_id, role, content)
    VALUES (new.id, new.session_id, new.role, new.content);
END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS messages_fts_delete
AFTER DELETE ON messages
BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS messages_fts_update
AFTER UPDATE ON messages
BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
  INSERT INTO messages_fts(message_id, session_id, role, content)
    SELECT new.id, new.session_id, new.role, new.content
    WHERE new.rewind_at IS NULL;
END;
