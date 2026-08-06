import type Database from 'better-sqlite3';

/**
 * 0062 — 幂等添加定时任务 in-flight 心跳租约列:
 *   - schedule_runs.heartbeat_at : 毫秒时间戳,执行实例周期续期;僵尸清理只回收
 *     心跳过期的 'running' 行,不再误标共库另一活实例正在执行的 run
 *     (见 @lizi/maker-scheduler ScheduleRun.heartbeatAt)。
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
  const runColumns = new Set(tableColumnNames(db, 'schedule_runs'));
  if (!runColumns.has('heartbeat_at')) {
    db.exec('ALTER TABLE schedule_runs ADD COLUMN heartbeat_at integer');
  }
}

module.exports = { run };
