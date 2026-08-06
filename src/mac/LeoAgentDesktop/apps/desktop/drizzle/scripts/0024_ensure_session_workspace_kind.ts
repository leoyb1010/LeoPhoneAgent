import type Database from 'better-sqlite3';

function tableColumnNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

function tableIndexNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA index_list('${tableName}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

function run(db: Database.Database): void {
  const sessionColumns = new Set(tableColumnNames(db, 'sessions'));
  if (!sessionColumns.has('workspace_kind')) {
    db.exec("ALTER TABLE sessions ADD COLUMN workspace_kind text DEFAULT 'project' NOT NULL");
  }

  const sessionIndexes = new Set(tableIndexNames(db, 'sessions'));
  if (!sessionIndexes.has('idx_sessions_workspace_kind')) {
    db.exec('CREATE INDEX idx_sessions_workspace_kind ON sessions (workspace_kind)');
  }
}

module.exports = { run };
