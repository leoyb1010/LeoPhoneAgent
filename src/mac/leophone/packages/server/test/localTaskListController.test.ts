import assert from "node:assert/strict";
import test from "node:test";
import { Emitter } from "@zcode/rpc";
import type { IZCodeTaskService, ZCodeTaskListQuery, WindowHostControllerFrame } from "@zcode/services";
import { CONTROLLER_TASKS_INDEX_TOPIC } from "@zcode/shared/zcode-protocol-v4";
import { createLocalTaskListController } from "../src/localTaskListController.js";
import { createWindowHostControllerRuntime as desktopFactory } from "../../desktop/src/host/windowHostControllerService.js";
import { createWindowHostControllerRuntime as sharedFactory } from "@zcode/services/window-controller-runtime";

const query: ZCodeTaskListQuery = { kind: "active", sortBy: "updated", workspaceScopes: [{ workspacePath: "/synthetic/project" }] };
function fixture(identity?: string) {
  const events = new Emitter<unknown>();
  let fail = false, reads = 0, writes = 0, listeners = 0;
  let barrier: Promise<void> = Promise.resolve();
  let title = "Failed synthetic task";
  const task = () => ({ taskId: "audit", workspacePath: "/synthetic/project", status: "error", unreadAt: 8, createdAt: 1, updatedAt: 4, title });
  const read = async () => { reads += 1; await barrier; if (fail) throw new Error("synthetic unavailable"); };
  const service = {
    async listTasks() { await read(); return [task()]; },
    async listPinnedTasks() { await read(); return []; },
    async listArchivedTasks() { await read(); return []; },
    async listTaskList() { await read(); return { items: [task()], total: 1, hasMore: false }; },
    onDynamicWorkspaceEvent() { return (callback: (event: unknown) => void) => {
      listeners += 1; const disposable = events.event(callback);
      return { dispose() { listeners -= 1; disposable.dispose(); } };
    }; },
    async deleteTask() { writes += 1; },
    async setTaskUnread() { writes += 1; },
  } as unknown as IZCodeTaskService;
  const controller = createLocalTaskListController({ workspaces: [{ path: "/synthetic/project", ...(identity ? { workspaceIdentity: identity } : {}) }], taskService: service });
  return { controller, service, events, reads: () => reads, writes: () => writes, listeners: () => listeners,
    fail: (value: boolean) => { fail = value; }, barrier: (value: Promise<void>) => { barrier = value; }, title: (value: string) => { title = value; } };
}

test("Desktop re-export and server public entry use the exact same implementation", () => {
  assert.equal(desktopFactory, sharedFactory);
});
test("declared absolute normalization returns actual status; unknown path/identity/remote never reaches service", async () => {
  const f = fixture(" local-one "); const connection = f.controller.createConnection();
  const scoped = { ...query, workspaceScopes: [{ workspacePath: "/synthetic/unused/../project/", workspaceIdentity: " local-one " }] };
  try {
    const result = await connection.service.listTaskList(scoped);
    assert.equal(result.items[0]?.status, "error"); assert.equal(result.items[0]?.liveStatus, "error");
    assert.equal(result.items[0]?.workspacePath, "/synthetic/project");
    assert.equal(result.items[0]?.workspaceIdentity, "local-one");
    const before = f.reads();
    for (const scope of [
      { workspacePath: "/synthetic/other", workspaceIdentity: "local-one" },
      { workspacePath: "/synthetic/project", workspaceIdentity: "other" },
      { workspacePath: "/synthetic/project" },
      { workspacePath: "project", workspaceIdentity: "local-one" },
      { workspacePath: "/synthetic/project", workspaceIdentity: "local-one", remoteSessionId: "remote" },
    ]) await assert.rejects(connection.service.listTaskList({ ...query, workspaceScopes: [scope] }), /declared|local workspaces/);
    assert.equal(f.reads(), before);
  } finally { connection.dispose(); f.controller.dispose(); }
});
test("failed first read is explicit, retry recovers, and later read failure never claims empty success", async () => {
  const f = fixture(); const connection = f.controller.createConnection();
  try {
    f.fail(true); await assert.rejects(connection.service.listTaskList(query), /synthetic unavailable/);
    f.fail(false); const before = await connection.service.listTaskList(query); assert.equal(before.items.length, 1);
    f.fail(true); await assert.rejects(connection.service.listTaskList(query), /synthetic unavailable/);
    f.fail(false); f.title("Recovered original task");
    const after = await connection.service.listTaskList(query); assert.equal(after.items[0]?.taskId, "audit");
    assert.equal(after.items[0]?.title, "Recovered original task");
    assert.equal(after.total, 1); assert.equal(after.items[0]?.status, "error");
  } finally { connection.dispose(); f.controller.dispose(); }
});
test("new read projection cannot mutate/delete, while existing service remains untouched", async () => {
  const f = fixture(); const connection = f.controller.createConnection();
  try {
    const address = { taskId: "audit", workspacePath: "/synthetic/project" };
    await assert.rejects(connection.service.mutateTask({ address, mutation: { kind: "mark-read" } }), /read-only/);
    await assert.rejects(connection.service.deleteArchivedTask({ address }), /read-only/);
    await assert.rejects(connection.service.deleteArchivedTasks({ address, taskIds: ["audit"] }), /read-only/);
    assert.equal(f.writes(), 0);
    await f.service.setTaskUnread({ ...address, unread: false }); assert.equal(f.writes(), 1);
  } finally { connection.dispose(); f.controller.dispose(); }
});
test("subscription IDs belong to one connection and release on close", async () => {
  const f = fixture(); const first = f.controller.createConnection(), second = f.controller.createConnection();
  const frames: WindowHostControllerFrame[] = [];
  const observer = first.service.onDynamicControllerFrame()(frame => frames.push(frame));
  try {
    const subscription = await first.service.subscribeControllerV4({ topic: CONTROLLER_TASKS_INDEX_TOPIC });
    const id = subscription.ack.subscriptionId;
    await assert.rejects(second.service.resyncControllerV4({ subscriptionId: id, base: null }), /does not belong/);
    await assert.rejects(second.service.unsubscribeControllerV4({ subscriptionId: id }), /does not belong/);
    await first.service.listTaskList(query);
    assert.ok(frames.some(frame => frame.subscriptionId === id));
    await first.service.resyncControllerV4({ subscriptionId: id, base: null });
    first.dispose(); const count = frames.length;
    await assert.rejects(first.service.listTaskList(query), /closed/);
    await second.service.listTaskList(query); assert.equal(frames.length, count);
    first.dispose(); second.dispose(); f.controller.dispose();
    assert.equal(f.listeners(), 0);
    assert.throws(() => f.controller.createConnection(), /closed/);
  } finally { observer.dispose(); first.dispose(); second.dispose(); f.controller.dispose(); }
});
test("a closed connection cannot accept an in-flight list reply", async () => {
  const f = fixture(); const connection = f.controller.createConnection();
  let release!: () => void; f.barrier(new Promise<void>(resolve => { release = resolve; }));
  const pending = connection.service.listTaskList(query);
  const denied = assert.rejects(pending, /closed/);
  connection.dispose(); release(); await denied;
  f.controller.dispose(); assert.equal(f.listeners(), 0);
});

test("concurrent subscriptions are bounded per connection and released slots can be reused", async () => {
  const f = fixture(); const connection = f.controller.createConnection();
  try {
    const pending = Array.from({ length: 33 }, () => connection.service.subscribeControllerV4({ topic: CONTROLLER_TASKS_INDEX_TOPIC }));
    const results = await Promise.allSettled(pending);
    assert.equal(results.filter(value => value.status === "fulfilled").length, 32);
    assert.equal(results.filter(value => value.status === "rejected").length, 1);
    const first = results.find(value => value.status === "fulfilled");
    assert.ok(first && first.status === "fulfilled");
    await connection.service.unsubscribeControllerV4({ subscriptionId: first.value.ack.subscriptionId });
    assert.ok((await connection.service.subscribeControllerV4({ topic: CONTROLLER_TASKS_INDEX_TOPIC })).ack.subscriptionId);
  } finally { connection.dispose(); f.controller.dispose(); }
});
