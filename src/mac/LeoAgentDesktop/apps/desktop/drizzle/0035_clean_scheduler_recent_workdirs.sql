-- Data-only cleanup: 0031 backfill 把所有 workspace_kind='project' 的 session workingDir
-- 拉进了 recent_workdirs,包括 scheduler ephemeral worktree (`.xdt-worktrees/sched-*`)。
-- 真实逻辑在同名 TS 脚本,这里 SELECT 1; 占位让 migration runner 识别。
SELECT 1;
