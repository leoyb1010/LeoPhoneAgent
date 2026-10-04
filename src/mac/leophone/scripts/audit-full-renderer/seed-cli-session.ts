import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { SqliteSessionStore, getDefaultSessionDbPath } from "../../apps/zcode-cli/packages/adapters/src/storage/index.js";
import { projectIdFromDirectory } from "../../apps/zcode-cli/packages/bootstrap/src/app/paths.js";
import { createMessageId, createPartId, type SessionId, type TraceId } from "../../apps/zcode-cli/packages/contracts/src/index.js";

function openSyntheticStore(home: string): SqliteSessionStore {
  const dbPath = getDefaultSessionDbPath();
  assert.ok(resolve(dbPath).startsWith(resolve(home) + sep), "CLI store must remain inside the explicit synthetic HOME");
  return new SqliteSessionStore({ dbPath });
}

export async function seedCliSession(home: string, workspace: string, task: {
  taskId: string; traceId: string; title: string; createdAt: number;
}): Promise<void> {
  const store = openSyntheticStore(home);
  const sessionID = task.taskId as SessionId;
  const userID = createMessageId("audit-user"), assistantID = createMessageId("audit-answer");
  const version = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")).version;
  try {
    await store.createSession({ id: sessionID, projectID: projectIdFromDirectory(workspace),
      traceID: task.traceId as TraceId, slug: "synthetic-audit", directory: workspace,
      title: task.title, titleSource: "custom", version, time: { created: task.createdAt } });
    await store.saveMessage({ id: userID, sessionID, role: "user", agent: "default",
      time: { created: task.createdAt + 1000 } });
    await store.savePart({ id: createPartId("audit-user-text"), sessionID, messageID: userID,
      type: "text", text: "Synthetic audit request" });
    await store.saveMessage({ id: assistantID, sessionID, role: "assistant", parentID: userID,
      agent: "default", mode: "build", path: { cwd: workspace, root: workspace },
      time: { created: task.createdAt + 2000, completed: task.createdAt + 3000 },
      error: { name: "AuditSyntheticError", data: { message: "Synthetic failure, no provider was contacted." } },
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
    await store.savePart({ id: createPartId("audit-answer-text"), sessionID, messageID: assistantID,
      type: "text", text: "Synthetic preserved history" });
    assert.equal((await store.messages({ sessionID })).length, 2);
  } finally { store.close(); }
}

export async function readCliSession(home: string, taskId: string) {
  const store = openSyntheticStore(home);
  try {
    const session = await store.getSession(taskId as SessionId);
    const messages = await store.messages({ sessionID: taskId as SessionId });
    return { cliSessionId: session?.id, cliMessageCount: messages.length,
      cliHistory: messages.flatMap(message => message.parts.flatMap(part => part.type === "text" ? [part.text] : [])) };
  } finally { store.close(); }
}
