import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ISettingService,
  IWindowControllerService,
  IZCodeTaskService,
  ServiceCollection,
} from "@zcode/services";

import {
  createLeoQuickEntry,
  QuickDispatchError,
  resolveQuickWorkspaces,
  summarizeQuickTasks,
  validateQuickDispatch,
  type QuickSourceItem,
} from "./quickEntry.js";

const item = (taskId: string, updatedAt: number, extra: Partial<QuickSourceItem> = {}): QuickSourceItem => ({
  taskId,
  title: `任务 ${taskId}`,
  workspacePath: "/w/a",
  updatedAt,
  ...extra,
});

test("summary groups by the live controller status, newest first", () => {
  const summary = summarizeQuickTasks(
    [
      item("old-run", 1, { liveStatus: "running" }),
      item("wait", 5, { liveStatus: "waiting" }),
      item("new-run", 9, { liveStatus: "running" }),
      item("done-unread", 7, { liveStatus: "completed", unreadAt: 7 }),
      item("done-read", 8, { liveStatus: "completed" }),
      item("failed", 6, { liveStatus: "error", unreadAt: 6 }),
    ],
    ["/w/a"],
  );
  assert.deepEqual(summary.waiting.map((row) => row.taskId), ["wait"]);
  assert.deepEqual(summary.running.map((row) => row.taskId), ["new-run", "old-run"]);
  assert.deepEqual(summary.recent.map((row) => row.taskId), ["new-run", "done-read", "done-unread"]);
  assert.equal(summary.recent[1]?.state, "idle");
  assert.equal(summary.recent[2]?.state, "done");
  assert.deepEqual(summary.workspaces, ["/w/a"]);
});

test("summary without a live projection falls back to the persisted status and never invents approvals", () => {
  const summary = summarizeQuickTasks(
    [item("a", 2, { status: "running" }), item("b", 1, { status: "error", unreadAt: 1 }), item("c", 0, { title: "  " })],
    [],
  );
  assert.deepEqual(summary.running.map((row) => row.taskId), ["a"]);
  assert.equal(summary.waiting.length, 0);
  assert.equal(summary.recent[1]?.state, "error");
  assert.equal(summary.recent[2]?.title, "未命名任务");
});

test("running list is capped at 5", () => {
  const items = Array.from({ length: 8 }, (_, index) => item(`r${index}`, index, { liveStatus: "running" }));
  assert.equal(summarizeQuickTasks(items, []).running.length, 5);
});

test("workspaces: open local tabs first, then recent projects; deduped, existing dirs only, at most 5", async () => {
  const existing = new Set(["/p/open", "/p/one", "/p/two", "/p/three", "/p/four", "/p/five"]);
  const workspaces = await resolveQuickWorkspaces(
    {
      lastWorkspaceSession: [
        { kind: "local", workspacePath: "/p/open" },
        { kind: "remote", workspacePath: "/remote/x" } as never,
      ],
      recentProjects: ["/p/open", "/p/gone", "relative/path", "/p/one", "/p/two", "/p/three", "/p/four", "/p/five"],
    } as never,
    async (path) => existing.has(path),
  );
  assert.deepEqual(workspaces, ["/p/open", "/p/one", "/p/two", "/p/three", "/p/four"]);
  assert.deepEqual(await resolveQuickWorkspaces(undefined, async () => true), []);
});

test("dispatch validation: non-empty prompt, only listed workspaces, default to the first one", () => {
  assert.deepEqual(validateQuickDispatch({ prompt: "  修一下测试  " }, ["/p/a", "/p/b"]), {
    workspacePath: "/p/a",
    prompt: "修一下测试",
  });
  assert.equal(validateQuickDispatch({ prompt: "x", workspacePath: "/p/b" }, ["/p/a", "/p/b"]).workspacePath, "/p/b");
  const status = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return error instanceof QuickDispatchError ? error.status : -1;
    }
    return 0;
  };
  assert.equal(status(() => validateQuickDispatch({ prompt: "   " }, ["/p/a"])), 400);
  assert.equal(status(() => validateQuickDispatch({ prompt: "x", workspacePath: "/etc" }, ["/p/a"])), 400);
  assert.equal(status(() => validateQuickDispatch({ prompt: "x" }, [])), 409);
  assert.equal(status(() => validateQuickDispatch({ prompt: "x".repeat(20_001) }, ["/p/a"])), 413);
});

test("dispatch creates a real task and sends the first input on the desktop-continuous lane", async () => {
  const calls: unknown[] = [];
  const services = new ServiceCollection();
  services.register(ISettingService, {
    get: async () => ({ recentProjects: [process.cwd()], lastWorkspaceSession: [] }),
  } as never);
  services.register(IZCodeTaskService, {
    createTask: async (params: unknown) => {
      calls.push(["createTask", params]);
      return { taskId: "task-1", traceId: "trace-1" };
    },
    sendPrompt: async (params: unknown) => {
      calls.push(["sendPrompt", params]);
    },
  } as never);
  services.register(IWindowControllerService, {
    listTaskList: async (query: unknown) => {
      calls.push(["listTaskList", query]);
      return { items: [item("task-1", 3, { liveStatus: "running", workspacePath: process.cwd() })], total: 1, hasMore: false };
    },
  } as never);
  const quick = createLeoQuickEntry(services);
  assert.deepEqual(await quick.dispatch({ prompt: "跑一下测试" }), { taskId: "task-1", workspacePath: process.cwd() });
  assert.deepEqual(calls.slice(0, 2), [
    ["createTask", { workspacePath: process.cwd(), deferPersistenceUntilFirstPrompt: true }],
    ["sendPrompt", { taskId: "task-1", traceId: "trace-1", content: "跑一下测试", clientMode: "desktop-continuous" }],
  ]);
  const summary = await quick.summary();
  assert.deepEqual(summary.running.map((row) => row.taskId), ["task-1"]);
  assert.deepEqual(calls[2], [
    "listTaskList",
    { kind: "active", workspaceScopes: [{ workspacePath: process.cwd() }], sortBy: "updated", limit: 40 },
  ]);
});

test("receipt recovery joins concurrent sends, replays after restart and checks an uncertain admission", async (t) => {
  const journal = await mkdtemp(join(tmpdir(), "leo-quick-receipts-"));
  t.after(() => rm(journal, { recursive: true, force: true }));
  const services = new ServiceCollection();
  services.register(ISettingService, { get: async () => ({ recentProjects: [process.cwd()] }) } as never);
  let created = 0;
  let sent = 0;
  let admitted = false;
  services.register(IZCodeTaskService, {
    createTask: async () => ({ taskId: `task-${++created}`, traceId: `input-${created}` }),
    sendPrompt: async () => { sent++; if (sent === 2) throw new Error("lost acknowledgement"); },
    queryOperation: async (query: { taskId: string; operationId: string }) => {
      assert.equal(query.taskId, "task-2");
      assert.equal(query.operationId, "input-2");
      return admitted ? { status: "accepted" } : null;
    },
  } as never);
  const request = { prompt: "hello", workspacePath: process.cwd(), requestId: "8d3607f8-6367-4006-b9b0-c8d2850aadc3" };
  const quick = createLeoQuickEntry(services, journal);
  const results = await Promise.all(Array.from({ length: 20 }, () => quick.dispatch(request)));
  assert.ok(results.every((result) => result.taskId === "task-1"));
  const restarted = createLeoQuickEntry(services, journal);
  assert.equal((await restarted.dispatch(request)).taskId, "task-1");
  await assert.rejects(restarted.dispatch({ ...request, prompt: "changed" }), /同一操作编号/);
  assert.equal(sent, 1);
  const next = { ...request, requestId: "26953ea3-979e-4248-9cb2-f72697625917" };
  await assert.rejects(quick.dispatch(next), /核对任务/);
  await assert.rejects(restarted.dispatch(next), /核对任务/);
  admitted = true;
  assert.equal((await restarted.dispatch(next)).taskId, "task-2");
  assert.equal(created, 2);
  assert.equal(sent, 2);
});
