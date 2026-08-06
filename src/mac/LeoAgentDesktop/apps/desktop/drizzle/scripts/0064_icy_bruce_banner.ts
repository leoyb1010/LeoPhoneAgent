import type Database from 'better-sqlite3';

/**
 * 0064 — 幂等添加 interrupted-turn-resume 的会话级「turn 在飞」标记两列:
 *   - sessions.active_turn_started_at : unix ms,NULL = 无在飞 turn;app 异常
 *     退出会留下残值,启动扫尾据此补 role='error' + reason='app-exit-interrupted'
 *     中断标记行(见 src/main/localDb/sessionActiveTurn.ts)
 *   - sessions.active_turn_pid       : 写入标记的进程 pid,dev/release 双开共库
 *     时扫尾前探活防误判
 *
 * SQLite 的 ALTER TABLE ADD COLUMN 不能安全重放,SQL 文件只保留占位语句,
 * 这里用 PRAGMA table_info 守卫加列(0060 / 0061 同款模式)。
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
  if (!sessionColumns.has('active_turn_started_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN active_turn_started_at integer');
  }
  if (!sessionColumns.has('active_turn_pid')) {
    db.exec('ALTER TABLE sessions ADD COLUMN active_turn_pid integer');
  }
}

module.exports = { run };
