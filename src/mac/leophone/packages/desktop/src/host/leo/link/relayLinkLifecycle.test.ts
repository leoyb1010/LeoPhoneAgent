import assert from "node:assert/strict";
import test from "node:test";

import { WebSocketServer } from "ws";

import type { LinkBridge } from "./bridge.js";
import { networkSignature, RelayLink, systemChangeDetector, type MachineKeyStore } from "./relayLink.js";

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

test("reconnectNow() drops the live connection and reconnects without waiting for backoff", async () => {
  let connections = 0;
  const { server, wsUrl } = await relayServer((ws) => {
    connections++;
    ws.on("message", () => ws.send(JSON.stringify({ type: "registered", version: "0.2" })));
  });
  const keys: MachineKeyStore = { async get() { return null; }, async set() {} };
  const link = new RelayLink({ wsUrl, name: "M", registerKey: "k".repeat(20) }, bridge, keys, silent, "t");
  link.start();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(connections, 1);
  link.reconnectNow("wake");
  // 退避清零：远小于 1 秒就该连上第二条。
  await new Promise((resolve) => setTimeout(resolve, 300));
  link.stop();
  server.close();
  assert.equal(connections, 2);
});

test("system change detector: clock gap means wake, address change means network", () => {
  let now = 0;
  let network = "en0/192.168.1.2";
  const check = systemChangeDetector(() => ({ now, network }), 20_000);
  now += 5_000;
  assert.equal(check(), null);
  now += 60_000;
  assert.equal(check(), "wake");
  now += 5_000;
  network = "en0/10.0.0.8";
  assert.equal(check(), "network");
  now += 5_000;
  assert.equal(check(), null);
});

test("network signature ignores loopback and interface order", () => {
  type Interfaces = Parameters<typeof networkSignature>[0];
  const en0 = [{ address: "192.168.1.2", internal: false }];
  const utun4 = [{ address: "100.64.0.9", internal: false }];
  const a = { lo0: [{ address: "127.0.0.1", internal: true }], en0, utun4 } as unknown as Interfaces;
  const b = { utun4, en0 } as unknown as Interfaces;
  assert.equal(networkSignature(a), networkSignature(b));
  assert.equal(networkSignature(a), "en0/192.168.1.2,utun4/100.64.0.9");
});
