import type Database from 'better-sqlite3';

/**
 * 0066 — messages_fts 瘦身: tool_result / tool_use / thinking 不再进全文索引。
 *
 * 背景(2026-07 用户现场): exec 工具输出(tool_result)占 messages.content 的绝对
 * 大头(线上实测 6GB 里 ~5.7GB), 而 standalone FTS5(0017)会把 content 再存一份,
 * 这些大文本等于双倍占盘。UI 会话搜索(conversationSearch SEARCH_ROLES)与语义嵌入
 * (chat-history-embedder EMBED_ROLES)本来就只覆盖 user / assistant / ask_user /
 * plan_review 四类 role, FTS 对齐同一白名单: 搜索体验不变, 索引体积砍掉最大头。
 *
 * 做法: 直接重建(DROP + CREATE + 按白名单回填)。白名单内容量小(远小于全量),
 * 重建远快于在 FTS5 上做大规模 DELETE(线性扫描 + tombstone)。drop + recreate
 * 天然幂等, 可安全重放。重建释放的页留在 db 文件内复用, 文件不缩小(缩小需
 * VACUUM, 不在迁移里做)。
 *
 * 用 TS 脚本而非纯 SQL: 回填与触发器都引用 messages 表, 最小化 fixture 库
 * (如 0040 回放测试的 v39 库)可能没有这张表, 需要存在性守卫; 纯 SQL 无法
 * 条件引用不存在的表。
 *
 * ⚠️ 本文件必须是 CommonJS(function + module.exports), 生产 Electron 以 raw
 * require() 加载, 禁止顶层 ESM export / value import(见 AGENTS.md 规则 17)。
 */

const FTS_ROLE_WHITELIST = "('user', 'assistant', 'ask_user', 'plan_review')";

function tableExists(db: Database.Database, name: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name);
}

function run(db: Database.Database): void {
  db.exec('DROP TRIGGER IF EXISTS messages_fts_insert;');
  db.exec('DROP TRIGGER IF EXISTS messages_fts_delete;');
  db.exec('DROP TRIGGER IF EXISTS messages_fts_update;');
  db.exec('DROP TABLE IF EXISTS messages_fts;');

  // messages 表不存在(最小 fixture 库) → 触发器与回填都无从建起, 整段跳过;
  // 真实用户库 messages 恒存在(0017 之前的基础迁移创建)。
  if (!tableExists(db, 'messages')) return;

  db.exec(`
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      message_id UNINDEXED,
      session_id UNINDEXED,
      role UNINDEXED,
      content,
      tokenize='porter unicode61'
    );
  `);

  db.exec(`
    INSERT INTO messages_fts(message_id, session_id, role, content)
      SELECT id, session_id, role, content
      FROM messages
      WHERE rewind_at IS NULL
        AND role IN ${FTS_ROLE_WHITELIST};
  `);

  db.exec(`
    CREATE TRIGGER messages_fts_insert
    AFTER INSERT ON messages
    WHEN new.rewind_at IS NULL AND new.role IN ${FTS_ROLE_WHITELIST}
    BEGIN
      INSERT INTO messages_fts(message_id, session_id, role, content)
        VALUES (new.id, new.session_id, new.role, new.content);
    END;
  `);

  db.exec(`
    CREATE TRIGGER messages_fts_delete
    AFTER DELETE ON messages
    BEGIN
      DELETE FROM messages_fts WHERE message_id = old.id;
    END;
  `);

  db.exec(`
    CREATE TRIGGER messages_fts_update
    AFTER UPDATE ON messages
    BEGIN
      DELETE FROM messages_fts WHERE message_id = old.id;
      INSERT INTO messages_fts(message_id, session_id, role, content)
        SELECT new.id, new.session_id, new.role, new.content
        WHERE new.rewind_at IS NULL AND new.role IN ${FTS_ROLE_WHITELIST};
    END;
  `);
}

module.exports = { run };
