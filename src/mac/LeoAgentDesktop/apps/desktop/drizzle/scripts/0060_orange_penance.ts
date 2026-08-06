import type Database from 'better-sqlite3';

/**
 * 0060 — 幂等添加 sessions.plan_mode_enabled 并迁移历史 permission_mode='plan'。
 *
 * SQLite 的 ALTER TABLE ADD COLUMN 不能安全重放,所以 SQL 文件只保留占位语句,
 * 这里用 PRAGMA table_info 守卫加列。回填本身按 permission_mode='plan' 过滤,
 * 首次执行后会被改成 ask,再次执行自然 no-op。
 */
function tableColumnNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

function run(db: Database.Database): void {
  const sessionColumns = new Set(tableColumnNames(db, 'sessions'));
  if (!sessionColumns.has('plan_mode_enabled')) {
    db.exec('ALTER TABLE sessions ADD COLUMN plan_mode_enabled integer DEFAULT false NOT NULL');
  }

  db.prepare(
    `UPDATE sessions
     SET plan_mode_enabled = 1, permission_mode = 'ask'
     WHERE permission_mode = 'plan'`,
  ).run();
}

module.exports = { run };
