import type Database from 'better-sqlite3';

/**
 * 0077 — 幂等添加 messages.agent_kind(text, nullable)。
 *
 * session-agent-switch:同一会话可在 Claude Code / Codex 间切换后,
 * sessions.agent_kind 只代表"当前活跃 agent";历史消息行的 agent_meta JSON 形态
 * 必须按写入时的引擎解析,故新消息落库时逐行 denormalize 引擎标识。
 * NULL = 切换功能上线前的老消息,读取方回落 session.agent_kind(向后兼容)。
 *
 * PRAGMA 守卫(沿用 0038 模式):
 *  - messages 表不存在(migration replay 的部分 fixture DB,如 v39 Orca fixture)→ no-op;
 *  - 列已存在(fixture 从 HEAD schema 建库后再回放)→ no-op。
 */

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
  return row !== undefined;
}

function tableColumnNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

function run(db: Database.Database): void {
  if (!tableExists(db, 'messages')) return;
  const messageColumns = new Set(tableColumnNames(db, 'messages'));
  if (!messageColumns.has('agent_kind')) {
    db.exec('ALTER TABLE messages ADD COLUMN agent_kind text');
  }
}

module.exports = { run };
