import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ZCODE_AGENT_PROVIDER } from "../../packages/shared/src/index.js";
import { setDataBaseDir, getLegacyTaskSessionSnapshotPath, getTasksIndexDatabasePath } from "../../packages/services/src/paths.js";
import { TaskIndexRepo } from "../../packages/services/src/session/taskIndexRepo.js";
import { parseLegacyTaskSessionFile } from "../../packages/services/src/session/legacyTaskSessionFile.js";

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
  migrationSource: "claudeCode" as const, createdAt: now - 60000, updatedAt: now,
  status: "error" as const,
  lastError: { code: "AUDIT_SYNTHETIC", message: "Synthetic failure, no provider was contacted." },
};
const repo = new TaskIndexRepo();
try {
  if (process.argv.includes("--read")) {
    const stored = await repo.getTaskMeta({ workspacePath: workspace, taskId: meta.taskId });
    assert.ok(stored);
    const matching = (await repo.listTaskMetas({ workspacePath: workspace })).filter(task => task.title === meta.title);
    console.log(JSON.stringify({ taskId: stored.taskId, status: stored.status, unreadAt: stored.unreadAt, title: stored.title, matchingCount: matching.length }));
  } else {
// A real production task index plus legacy snapshot. The server and renderer
// perform their usual list/resume/read lifecycle; no renderer store is patched.
const snapshot = parseLegacyTaskSessionFile({ meta, messages: [
  { id: "audit-user", role: "user", content: "Synthetic audit request", timestamp: now - 50000 },
  { id: "audit-answer", role: "assistant", content: "Synthetic preserved history", timestamp: now - 40000 },
], toolCalls: [] });
const path = getLegacyTaskSessionSnapshotPath(workspace, meta.taskId);
await mkdir(dirname(path), { recursive: true });
await writeFile(path, JSON.stringify(snapshot));
  await repo.syncTaskMetaAtGroupedTop({ meta });
  const stored = await repo.updateTaskState({ workspacePath: workspace, taskId: meta.taskId,
    patch: { unreadAt: now, status: "error", lastError: meta.lastError } });
  assert.equal(stored.status, "error");
  assert.ok(stored.unreadAt);
  console.log(JSON.stringify({ taskId: meta.taskId, status: stored.status, unreadAt: stored.unreadAt,
    database: getTasksIndexDatabasePath(), snapshot: path,
    scope: "Synthetic persisted error/unread task via production TaskIndexRepo; no model execution." }));
  }
} finally { repo.close(); }
