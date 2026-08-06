import type Database from 'better-sqlite3';

/**
 * sidebar-card-mode: 幂等添加 sessions.summary 列。
 *
 * 配套 0048_add_session_summary.sql(占位 SELECT 1)。自定义 migrator 按整数
 * schema_version 高水位线应用,部分开发者 DB 因并行迁移血缘已经有了 summary 列,
 * 直接 ALTER ADD 会撞 duplicate column 致启动失败回滚。PRAGMA 守卫后再加,确保
 * 在"已有该列"与"全新库"两种情形都安全(见 0024 / 0038 先例)。
 */
function tableColumnNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

function run(db: Database.Database): void {
  const sessionColumns = new Set(tableColumnNames(db, 'sessions'));
  if (!sessionColumns.has('summary')) {
    db.exec('ALTER TABLE sessions ADD COLUMN summary text');
  }
}

module.exports = { run };
