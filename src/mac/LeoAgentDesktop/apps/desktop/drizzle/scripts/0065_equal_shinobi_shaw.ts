import type Database from 'better-sqlite3';

/**
 * 0065 — 幂等添加 interrupted-turn-resume 简化版的收尾时间戳列:
 *   - sessions.last_turn_ended_at : unix ms,最近一次 turn 正常收尾(done /
 *     terminal error / close / stop / 用户忽略中断提示)的时刻。与
 *     active_turn_started_at 配对做「疑似中断」纯读判定(startedAt > endedAt),
 *     见 src/main/localDb/sessionActiveTurn.ts 文件头。
 *
 * SQLite 的 ALTER TABLE ADD COLUMN 不能安全重放,SQL 文件只保留占位语句,
 * 这里用 PRAGMA table_info 守卫加列(0060 / 0061 / 0064 同款模式)。
 * ⚠️ 本文件必须是 CommonJS(function + module.exports),生产 Electron 以 raw
 * require() 加载,禁止顶层 ESM export / value import(见 AGENTS.md 规则 17)。
 */
function tableColumnNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

function run(db: Database.Database): void {
  const sessionColumns = new Set(tableColumnNames(db, 'sessions'));
  if (!sessionColumns.has('last_turn_ended_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN last_turn_ended_at integer');
  }
}

module.exports = { run };
