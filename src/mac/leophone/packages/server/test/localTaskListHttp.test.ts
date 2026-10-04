import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Emitter } from "@zcode/rpc";
import { connectViaWebSocket } from "@zcode/client";
import { ServiceCollection, IZCodeTaskService, type IZCodeTaskService as TaskService } from "@zcode/services";
import { CONTROLLER_TASKS_INDEX_TOPIC } from "@zcode/shared/zcode-protocol-v4";
import { createHttpServer } from "../src/http.js";

test("ordinary authenticated replayable Web socket exposes bounded read status and disposes listeners", { timeout: 10000 }, async () => {
  const changes = new Emitter<unknown>(); let listeners = 0; let fail = false;
  const task = { taskId: "synthetic", workspacePath: "/synthetic/http", title: "Synthetic task", status: "error", unreadAt: 8, createdAt: 1, updatedAt: 2 };
  const taskService = {
    async listTasks() { if (fail) throw new Error("synthetic read rejected"); return [task]; },
    async listPinnedTasks() { return []; }, async listArchivedTasks() { return []; },
    onDynamicWorkspaceEvent() { return (listener: (value: unknown) => void) => {
      listeners += 1; const handle = changes.event(listener);
      return { dispose() { listeners -= 1; handle.dispose(); } };
    }; },
  } as unknown as TaskService;
  const services = new ServiceCollection().register(IZCodeTaskService, taskService);
  // Synthetic protocol value only. No real credentials or existing server are used.
  const token = "synthetic-http-test-token";
  const server = createHttpServer(services, 0, { host: "127.0.0.1", authToken: token, workspaces: [{ path: "/synthetic/http" }] });
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  let socket: WebSocket | undefined;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/server-info`)).status, 401);
    const info = await fetch(`http://127.0.0.1:${port}/api/server-info?token=${token}`);
    assert.equal(info.status, 200); assert.equal((await info.json()).workspaces[0].path, "/synthetic/http");
    const accessor = await connectViaWebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, { onOpenSocket: value => { socket = value; } });
    const controller = accessor.windowControllerService!;
    const query = { kind: "active" as const, sortBy: "updated" as const, workspaceScopes: [{ workspacePath: "/synthetic/http" }] };
    const result = await controller.listTaskList(query); assert.equal(result.items[0]?.status, "error");
    await assert.rejects(controller.listTaskList({ ...query, workspaceScopes: [{ workspacePath: "/undeclared" }] }), /not declared/);
    await assert.rejects(controller.mutateTask({ address: { taskId: "synthetic", workspacePath: "/synthetic/http" }, mutation: { kind: "mark-read" } }), /read-only/);
    fail = true; await assert.rejects(controller.listTaskList(query), /synthetic read rejected/);
    fail = false; assert.equal((await controller.listTaskList(query)).items[0]?.taskId, "synthetic");
    const subscription = await controller.subscribeControllerV4({ topic: CONTROLLER_TASKS_INDEX_TOPIC });
    await controller.unsubscribeControllerV4({ subscriptionId: subscription.ack.subscriptionId });
    const closed = new Promise<void>(resolve => socket!.addEventListener("close", () => resolve(), { once: true }));
    socket!.close(); await closed;
  } finally {
    socket?.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(listeners, 0); changes.dispose();
  }
});
