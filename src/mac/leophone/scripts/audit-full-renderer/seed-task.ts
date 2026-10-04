import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { createSettingService } from "../../packages/services/src/setting/settingService.js";
import { ZCODE_AGENT_PROVIDER } from "../../packages/shared/src/index.js";
import { setDataBaseDir, getTasksIndexDatabasePath } from "../../packages/services/src/paths.js";
import { TaskIndexRepo } from "../../packages/services/src/session/taskIndexRepo.js";
import { seedCliSession, readCliSession } from "./seed-cli-session.js";

const [homeArgument, workspaceArgument] = process.argv.slice(2);
assert.ok(homeArgument && workspaceArgument, "Explicit synthetic HOME and workspace required");
const home = resolve(homeArgument), workspace = resolve(workspaceArgument);
assert.ok(home.includes("audit-full-renderer-results/isolated-"));
assert.ok(workspace.startsWith(dirname(home) + "/"));
setDataBaseDir(home);
const now = Date.now();
const meta = {
  taskId: "audit-failed-task", traceId: "audit-synthetic-trace", workspacePath: workspace,
  title: "Synthetic failed task", mode: "build" as const, provider: ZCODE_AGENT_PROVIDER,
  createdAt: now - 60000, updatedAt: now,
  status: "error" as const,
  lastError: { code: "AUDIT_SYNTHETIC", message: "Synthetic failure, no provider was contacted." },
};
const repo = new TaskIndexRepo();
try {
  if (process.argv.includes("--read")) {
    const stored = await repo.getTaskMeta({ workspacePath: workspace, taskId: meta.taskId });
    assert.ok(stored);
    const matching = (await repo.listTaskMetas({ workspacePath: workspace })).filter(task => task.title === meta.title);
    console.log(JSON.stringify({ taskId: stored.taskId, status: stored.status, unreadAt: stored.unreadAt, title: stored.title, matchingCount: matching.length, ...(await readCliSession(home, meta.taskId)) }));
  } else {
    if (process.argv.includes("--desktop")) {
      await createSettingService().update({
        lastWorkspaceSession: [{ kind: "local", workspacePath: workspace, workspacePurpose: "project" }],
        lastActiveTabIndex: 0, recentProjects: [workspace],
        locale: "en-US", localePreference: "en-US",
        settingsSyncFirstRunPromptHandled: true,
      });
    }
    // The current V4 runtime restores from its own production SQLite store;
    // legacy JSON is only an import backup and cannot establish a live session.
    await seedCliSession(home, workspace, meta);
  await repo.syncTaskMetaAtGroupedTop({ meta });
  const stored = await repo.updateTaskState({ workspacePath: workspace, taskId: meta.taskId,
    patch: { unreadAt: now, status: "error", lastError: meta.lastError } });
  assert.equal(stored.status, "error");
  assert.ok(stored.unreadAt);
  console.log(JSON.stringify({ taskId: meta.taskId, status: stored.status, unreadAt: stored.unreadAt,
    database: getTasksIndexDatabasePath(), ...(await readCliSession(home, meta.taskId)),
    scope: "Synthetic persisted error/unread task via production TaskIndexRepo and SqliteSessionStore; no model execution." }));
  }
} finally { repo.close(); }
