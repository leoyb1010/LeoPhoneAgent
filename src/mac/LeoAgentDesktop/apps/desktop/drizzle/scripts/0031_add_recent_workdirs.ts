/**
 * 0031 backfill — 从现有 sessions 表回填 recent_workdirs。
 *
 * 背景: 此前 NewMakerDraft 的"项目"下拉是从 active sessions 反推 workingDir,
 * 一旦某目录下所有 session 被归档,目录就从下拉里消失。0031 引入独立的
 * recent_workdirs 表,生命周期与 session 解耦。
 *
 * 回填规则:
 *  - 取 source='desktop' 且 status != 'deleted' 的 sessions(归档的也算)
 *  - workspace_kind='project' 的才回填 —— dialogue 是 app-managed 临时 cwd
 *    (userData/dialogues/YYYY-MM-DD/<uuid>),不应该出现在"最近工作目录"里
 *  - workingDir IS NOT NULL AND TRIM(workingDir) != ''
 *  - normalize path (`\` → `/`, 去尾 `/`,保留盘符根 `D:/`):Windows 同一目录
 *    可能因分隔符差异在 sessions 里写成不同字符串,不归一会出现"同一目录两条"。
 *  - 同 canonical path 取 MAX(COALESCE(userSendAt, updatedAt, createdAt))
 *  - 主键冲突走 INSERT OR REPLACE 兜底(理论上 JS 端 dedupe 已经唯一,防御)。
 *  - 只保留按 lastUsedAt 最近的 MAX_RECENT_WORKDIRS=10 条;老用户历史项目多时
 *    UI 不被淹没,与运行时 upsertRecentWorkdir 的 LRU 驱逐口径一致。
 */

/** 跟 ipc/recentWorkdirs.ts:MAX_RECENT_WORKDIRS 保持一致。修一处改两处。 */
const MAX_RECENT_WORKDIRS = 10;

import type Database from 'better-sqlite3';

function canonicalize(raw: string): string {
  let s = raw.trim().replace(/\\/g, '/');
  while (s.length > 1 && s.endsWith('/')) {
    if (/^[A-Za-z]:\/$/.test(s)) break; // 盘符根 `D:/`
    s = s.slice(0, -1);
  }
  return s;
}

function run(db: Database.Database): void {
  // SELECT 一票符合条件的 sessions,JS 端按 canonical path 归并。
  // COALESCE 层级与 projectGrouping.sortTime 一致:userSendAt > updatedAt > createdAt。
  const rows = db
    .prepare(
      `SELECT working_dir AS path,
              COALESCE(user_send_at, updated_at, created_at) AS ts
       FROM sessions
       WHERE source = 'desktop'
         AND status != 'deleted'
         AND workspace_kind = 'project'
         AND working_dir IS NOT NULL
         AND TRIM(working_dir) != ''`,
    )
    .all() as Array<{ path: string; ts: number }>;

  if (rows.length === 0) return;

  const merged = new Map<string, number>();
  for (const row of rows) {
    const c = canonicalize(row.path);
    if (!c) continue;
    const ts = typeof row.ts === 'number' && row.ts > 0 ? row.ts : Date.now();
    const prev = merged.get(c);
    if (prev === undefined || ts > prev) {
      merged.set(c, ts);
    }
  }

  // 按 lastUsedAt 排序,只回填最近 MAX_RECENT_WORKDIRS 条。
  const sorted = Array.from(merged.entries()).sort((a, b) => b[1] - a[1]);
  const insert = db.prepare(
    `INSERT OR REPLACE INTO recent_workdirs (path, last_used_at) VALUES (?, ?)`,
  );
  for (const [path, ts] of sorted.slice(0, MAX_RECENT_WORKDIRS)) {
    insert.run(path, ts);
  }
}

module.exports = { run };
