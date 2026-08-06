import type Database from 'better-sqlite3';

/**
 * 0038 — 幂等添加 sessions.remote_host_id(text, nullable)。
 *
 * 背景:该列原在 codex 远端 MR(!175)以 0036 生成,合并回 main 时主干已到 0037 → 撞号。
 * 自定义 migrator 按整数 schema_version 高水位线应用迁移,撞号期间产生两拨状态分裂的 DB:
 *   - 本地 DB 曾 ≤35 跑过合并后 main 的开发者:一次 batch 里把旧 0036_add(字母序在前)
 *     一并应用了 → 已有 remote_host_id。
 *   - 合并前已在 36/37 的开发者:旧 0036_add(seq 36 ≤ 当前版本)被跳过 → 没有该列。
 * 重排为 0038 后,这里做 PRAGMA 守卫:列已存在则 no-op,缺失则补,三类 DB(含全新用户)
 * 收敛到同一 schema。沿用 0024_ensure_session_workspace_kind 的幂等模式。
 */

function tableColumnNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

function run(db: Database.Database): void {
  const sessionColumns = new Set(tableColumnNames(db, 'sessions'));
  if (!sessionColumns.has('remote_host_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN remote_host_id text');
  }
}

module.exports = { run };
