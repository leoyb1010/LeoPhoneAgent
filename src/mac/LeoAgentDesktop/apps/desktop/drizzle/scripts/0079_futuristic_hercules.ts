import type Database from 'better-sqlite3';

interface TableInfoRow {
  name: string;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName) !== undefined
  );
}

function schedulesColumnExists(db: Database.Database, columnName: string): boolean {
  return (db.prepare("PRAGMA table_info('schedules')").all() as TableInfoRow[]).some(
    (row) => row.name === columnName,
  );
}

function sessionsColumnExists(db: Database.Database, columnName: string): boolean {
  return (db.prepare("PRAGMA table_info('sessions')").all() as TableInfoRow[]).some(
    (row) => row.name === columnName,
  );
}

/**
 * 只给仍可能是 legacy session 原始 owner 的存量 schedule 开启兼容匹配。
 * 若同 key session 早于 schedule 创建，说明当前 row 可能已经是删除后的同名重建，
 * 不能让它在升级时重新认领上一代留下的会话。
 */
function run(db: Database.Database): void {
  if (!tableExists(db, 'schedules')) return;
  db.transaction(() => {
    if (schedulesColumnExists(db, 'legacy_session_fallback')) return;
    db.exec(
      'ALTER TABLE schedules ADD COLUMN legacy_session_fallback integer DEFAULT 0 NOT NULL',
    );
    if (!tableExists(db, 'sessions')) return;
    const hasWorkspaceIdentity =
      schedulesColumnExists(db, 'workspace_kind')
      && schedulesColumnExists(db, 'working_dir')
      && sessionsColumnExists(db, 'workspace_kind')
      && sessionsColumnExists(db, 'working_dir');
    const legacyOwnerGuard = hasWorkspaceIdentity
      ? `
          AND sessions.workspace_kind = schedules.workspace_kind
          AND (
            schedules.workspace_kind = 'dialogue'
            OR sessions.working_dir IS schedules.working_dir
          )
        `
      : '';
    db.exec(`
      UPDATE schedules
      SET legacy_session_fallback = 1
      WHERE NOT EXISTS (
        SELECT 1
        FROM sessions
        WHERE sessions.source = 'scheduler'
          AND sessions.title = '[Schedule] ' || schedules.name
          ${legacyOwnerGuard}
          AND sessions.created_at < schedules.created_at
      )
    `);
  })();
}

module.exports = { run };
