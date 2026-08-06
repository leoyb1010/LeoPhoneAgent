/**
 * 0035 cleanup — 从 recent_workdirs 删除 scheduler ephemeral worktree 路径。
 *
 * 背景: 0031 backfill 把所有 workspace_kind='project' 的 session workingDir
 * 都拉进了 recent_workdirs。scheduler 走 DesktopSessionStorage.create() 直接 drizzle
 * 入 sessions,workspace_kind 走 schema 默认 'project',workingDir 是
 * `<baseRepo>/.xdt-worktrees/sched-<sessionId 前8>`。回填时被误当作"用户选过的项目目录"
 * 收录,污染 NewMakerDraft 的"项目"下拉。
 *
 * 这里做一次性清理。新建 scheduler session 不会再污染(走 DesktopSessionStorage 直插,
 * 不调 upsertRecentWorkdir);同时 ipc/recentWorkdirs.ts:normalizeRecentWorkdirPath
 * 也加了 worktree 路径拒绝兜底,防止任何新链路误传。
 *
 * 匹配:任意位置出现 `/.xdt-worktrees/` 段。recent_workdirs.path 经
 * normalizeRecentWorkdirPath / 0031 canonicalize 处理,始终是正斜杠形态,
 * 不需要兜底反斜杠。
 */

import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  db.prepare(
    `DELETE FROM recent_workdirs WHERE path LIKE '%/.xdt-worktrees/%'`,
  ).run();
}

module.exports = { run };
