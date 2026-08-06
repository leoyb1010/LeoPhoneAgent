import type Database from 'better-sqlite3';

/**
 * 0075 — 幂等添加 schedule_runs.pre_run_hook_result。
 *
 * SQLite 的 ALTER TABLE ADD COLUMN 不能安全重放（无 IF NOT EXISTS 语义），所以 SQL 文件
 * 只保留占位查询，这里用 PRAGMA table_info 守卫加列（模式同 0069/0071/0073）。
 *
 * ⚠ 本脚本必须保持 CommonJS（function + module.exports），禁止顶层 ESM export /
 * value import——生产 Electron 以 raw 形式 require() 加载。
 */
function tableColumnNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

function run(db: Database.Database): void {
  const columns = new Set(tableColumnNames(db, 'schedule_runs'));
  if (!columns.has('pre_run_hook_result')) {
    db.exec('ALTER TABLE schedule_runs ADD COLUMN pre_run_hook_result text');
  }
}

module.exports = { run };
