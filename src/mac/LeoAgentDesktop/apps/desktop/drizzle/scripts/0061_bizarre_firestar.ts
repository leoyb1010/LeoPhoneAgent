import type Database from 'better-sqlite3';

/**
 * 0061 — 幂等添加定时任务前置检查脚本(Pre-run Hook)相关三列:
 *   - schedules.pre_run_hook_command    : shell 命令,NULL = 未启用
 *   - schedules.pre_run_hook_timeout_ms : 超时毫秒,NULL = runner 默认(10s)
 *   - schedules.skip_log_session_id     : 跳过留痕承载会话 id(runner 管理)
 *
 * SQLite 的 ALTER TABLE ADD COLUMN 不能安全重放,SQL 文件只保留占位语句,
 * 这里用 PRAGMA table_info 守卫加列(0060 同款模式)。
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
  const scheduleColumns = new Set(tableColumnNames(db, 'schedules'));
  if (!scheduleColumns.has('pre_run_hook_command')) {
    db.exec('ALTER TABLE schedules ADD COLUMN pre_run_hook_command text');
  }
  if (!scheduleColumns.has('pre_run_hook_timeout_ms')) {
    db.exec('ALTER TABLE schedules ADD COLUMN pre_run_hook_timeout_ms integer');
  }
  if (!scheduleColumns.has('skip_log_session_id')) {
    // ON DELETE SET NULL 必须与 schema.ts / 0061_snapshot.json 声明一致:app 全程
    // PRAGMA foreign_keys=ON,缺了它迁移库会是 NO ACTION —— 一旦接上 session 硬删,
    // 存量用户删被引用会话直接 FOREIGN KEY constraint failed,而新装库却正常置空。
    db.exec(
      'ALTER TABLE schedules ADD COLUMN skip_log_session_id text REFERENCES sessions(id) ON DELETE SET NULL',
    );
  }
}

module.exports = { run };
