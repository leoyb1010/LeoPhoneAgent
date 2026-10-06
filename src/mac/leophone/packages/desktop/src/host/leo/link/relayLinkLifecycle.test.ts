import assert from "node:assert/strict";
import test from "node:test";

import { WebSocketServer } from "ws";

import type { LinkBridge } from "./bridge.js";
import { RelayLink, type MachineKeyStore } from "./relayLink.js";

const silent = { info() {}, warn() {} };
const bridge = { async revokeCallers() {} } as unknown as LinkBridge;

async function relayServer(onConnection: (ws: import("ws").WebSocket) => void) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  server.on("connection", onConnection);
  const port = (server.address() as { port: number }).port;
  return { server, wsUrl: `ws://127.0.0.1:${port}/relay/agent` };
}

test("stop() while the machine key is being read never opens a stray connection", async () => {
  let connections = 0;
  const { server, wsUrl } = await relayServer(() => connections++);
  let release!: (key: string | null) => void;
  const keys: MachineKeyStore = {
    get: () => new Promise((resolve) => (release = resolve)),
    async set() {},
  };
  const link = new RelayLink({ wsUrl, name: "M", registerKey: "k".repeat(20) }, bridge, keys, silent, "t");
  link.start();
  link.stop();
  release(null);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(connections, 0);
  server.close();
});

test("a successful registration resets the reconnect backoff", async () => {
  let connections = 0;
  const { server, wsUrl } = await relayServer((ws) => {
    connections++;
    ws.on("message", () => {
      ws.send(JSON.stringify({ type: "registered", version: "0.2" }));
      setTimeout(() => ws.close(4000, "replaced"), 20);
    });
  });
  const keys: MachineKeyStore = { async get() { return null; }, async set() {} };
  const link = new RelayLink({ wsUrl, name: "M", registerKey: "k".repeat(20) }, bridge, keys, silent, "t");
  link.start();
  // 每次都连上过:退避应停在 1 秒。旧实现 1→2→4 秒,3.6 秒内只够连 2 次。
  await new Promise((resolve) => setTimeout(resolve, 3600));
  link.stop();
  server.close();
  assert.ok(connections >= 3, `expected >=3 connections, got ${connections}`);
});
