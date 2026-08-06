import type Database from 'better-sqlite3';

/**
 * 0076 — 幂等增加 schedule_runs 的逐 run 费用快照列。
 *
 * 存量 run 默认标为 legacy，因为迁移前只有 session/message 总费用，无法可靠拆分到
 * 每一次执行；迁移后新建 run 会由 mapper 明确写入 exact。
 *
 * 本脚本必须保持 CommonJS（function + module.exports），生产 Electron 会直接 require。
 */
function tableColumnNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

function run(db: Database.Database): void {
  const columns = new Set(tableColumnNames(db, 'schedule_runs'));
  if (!columns.has('cost_usd')) {
    db.exec('ALTER TABLE schedule_runs ADD COLUMN cost_usd real DEFAULT 0 NOT NULL');
  }
  if (!columns.has('estimated_value_usd')) {
    db.exec('ALTER TABLE schedule_runs ADD COLUMN estimated_value_usd real DEFAULT 0 NOT NULL');
  }
  if (!columns.has('cost_attribution')) {
    db.exec("ALTER TABLE schedule_runs ADD COLUMN cost_attribution text DEFAULT 'legacy' NOT NULL");
  }
}

module.exports = { run };
