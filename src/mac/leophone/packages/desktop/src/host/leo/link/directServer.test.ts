import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LeoDeviceDescriptor } from "@zcode/shared/leo-device";
import { LinkBridge, type LinkBridgeDeps, type LinkRequest } from "./bridge.js";
import { DirectGrants } from "./directGrants.js";
import { startDirectServer } from "./directServer.js";
import { RelayLink } from "./relayLink.js";

test("direct listener validates local grant and target, ignores spoofed caller, denies management paths, requires mutation id", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-direct-"));
  const grants = new DirectGrants(path.join(dir, "grants.json"), "target");
  await grants.restore();
  const grant = await grants.issue({ kind: "iphone", deviceId: "phone" });
  const seen: LinkRequest[] = [];
  const bridge = {
    handle: async (req: LinkRequest) => {
      seen.push(req);
      return { status: 200, body: { ok: true } };
    },
  } as unknown as LinkBridge;
  const device = {
    schemaVersion: 1,
    deviceId: "target",
    name: "Mac",
    platform: "macos",
    endpoints: [],
    capabilities: [],
  } satisfies LeoDeviceDescriptor;
  const server = await startDirectServer({ bridge, grants, device, port: 0 });
  const url = `http://127.0.0.1:${server.port}`;
  const headers = {
    Authorization: `Bearer ${grant.token}`,
    "X-Leo-Device-ID": "target",
    "X-Leo-Caller": "master",
  };
  try {
    assert.equal((await fetch(`${url}/health`)).status, 401);
    assert.equal((await fetch(`${url}/sync/v1/changes`, { headers })).status, 403);
    assert.equal((await fetch(`${url}/treasury/v1/tools`, { headers })).status, 403);
    assert.equal(
      (await fetch(`${url}/health`, { headers: { ...headers, "X-Leo-Device-ID": "wrong" } }))
        .status,
      401,
    );
    assert.equal(
      (await fetch(`${url}/health`, { headers: { ...headers, Origin: "https://evil.example" } }))
        .status,
      403,
    );
    assert.equal(
      (await fetch(`${url}/api/leo/link/pair`, { method: "POST", headers })).status,
      404,
    );
    assert.equal((await fetch(`${url}/v1/grok/token`, { headers })).status, 404);
    assert.equal((await fetch(`${url}/direct-grants`, { method: "POST", headers })).status, 404);
    assert.equal(
      (await fetch(`${url}/harness/sessions`, { method: "POST", headers, body: "{}" })).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${url}/harness/sessions`, {
          method: "POST",
          headers: { ...headers, "X-Request-ID": "same-op" },
          body: "{}",
        })
      ).status,
      200,
    );
    assert.equal(seen.at(-1)?.caller.deviceId, "phone");
    assert.equal(seen.at(-1)?.caller.kind, "iphone");
    assert.equal(seen.at(-1)?.requestId, "same-op");
    assert.equal(seen.at(-1)?.transport, "direct");
    await grants.revoke("phone");
    assert.equal((await fetch(`${url}/health`, { headers })).status, 401);
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("explicit sync and Treasury scopes route only to their injected authenticated handlers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-scopes-"));
  const grants = new DirectGrants(path.join(dir, "grants.json"), "target", () => Date.now(), ["harness", "sync", "treasury"]);
  await grants.restore();
  const grant = await grants.issue({ kind: "legacy", deviceId: "tablet" });
  const seen: string[] = [];
  const handler = async (_req: unknown, res: import("node:http").ServerResponse, principal: { deviceId: string }) => { seen.push(principal.deviceId); res.writeHead(204); res.end(); return true; };
  const device = { schemaVersion: 1, deviceId: "target", name: "Mac", platform: "macos", endpoints: [], capabilities: [] } satisfies LeoDeviceDescriptor;
  const server = await startDirectServer({ bridge: {} as LinkBridge, grants, device, port: 0, replicaHandler: handler, treasuryHandler: handler });
  try {
    const headers = { Authorization: `Bearer ${grant.token}`, "X-Leo-Device-ID": "target" };
    const base = `http://127.0.0.1:${server.port}`;
    assert.equal((await fetch(`${base}/sync/v1/changes`, { headers })).status, 204);
    assert.equal((await fetch(`${base}/treasury/v1/tools`, { headers })).status, 204);
    assert.deepEqual(seen, ["tablet", "tablet"]);
  } finally { await server.stop(); await rm(dir, { recursive: true, force: true }); }
});


for (const ending of ["revoke", "expire"] as const) {
  test(`active direct stream rechecks ${ending} before its next write`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "leo-direct-stream-"));
    let now = Date.now();
    const grants = new DirectGrants(path.join(dir, "grants.json"), "target", () => now);
    await grants.restore();
    const grant = await grants.issue({ kind: "iphone", deviceId: "phone" });
    let send: (data: string) => void = () => assert.fail("stream not open");
    let streamSignal: AbortSignal | undefined;
    const bridge = {
      async stream(_req: LinkRequest, write: (data: string) => void, signal: AbortSignal) {
        send = write;
        streamSignal = signal;
        write("first");
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    } as unknown as LinkBridge;
    const device = { schemaVersion: 1, deviceId: "target", name: "Mac", platform: "macos", endpoints: [], capabilities: [] } satisfies LeoDeviceDescriptor;
    const server = await startDirectServer({ bridge, grants, device, port: 0 });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/harness/sessions/s/events`, {
        headers: { Authorization: `Bearer ${grant.token}`, "X-Leo-Device-ID": "target" },
      });
      const reader = response.body!.getReader();
      assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
      if (ending === "revoke") await grants.revoke("phone");
      else now = (grant.expiresAt + 1) * 1000;
      send("must-not-leak");
      assert.equal(streamSignal?.aborted, true);
      assert.equal((await reader.read()).done, true);
    } finally {
      await server.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("failed relay batch revocation denies every direct token and stream, then persists on retry", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-revoke-batch-"));
  const file = path.join(dir, "grants.json");
  const grants = new DirectGrants(file, "target");
  await grants.restore();
  const ids = ["a", "b", "other"];
  const issued = await Promise.all(ids.map((deviceId) => grants.issue({ kind: "iphone", deviceId })));
  const streams = new Map<string, { send: (data: string) => void; signal: AbortSignal }>();
  const bridge = new LinkBridge({ directGrants: grants, journalDir: dir,
    leoagent: { url: "http://127.0.0.1/unused", key: () => null } } as LinkBridgeDeps);
  bridge.handle = async () => ({ status: 200, body: {} });
  bridge.stream = async (req, send, signal) => {
    streams.set(req.caller.deviceId!, { send, signal });
    send("first");
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  };
  const device = { schemaVersion: 1, deviceId: "target", name: "Mac", platform: "macos", endpoints: [], capabilities: [] } satisfies LeoDeviceDescriptor;
  const server = await startDirectServer({ bridge, grants, device, port: 0 });
  const link = new RelayLink({ wsUrl: "ws://unused.invalid", name: "Mac", registerKey: "fixture" },
    bridge, { get: async () => null, set: async () => {} }, { info() {}, warn() {} }, "test");
  const relay = link as unknown as { applyRevocations(ids: string[]): void; revocations: Promise<void>; pendingRevocations: Set<string> };
  const base = `http://127.0.0.1:${server.port}`;
  const headers = issued.map(({ token }) => ({ Authorization: `Bearer ${token}`, "X-Leo-Device-ID": "target" }));
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  try {
    for (const header of headers) {
      const response = await fetch(`${base}/harness/sessions/s/events`, { headers: header });
      const reader = response.body!.getReader();
      readers.push(reader);
      assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
    }
    await mkdir(`${file}.tmp`);
    relay.applyRevocations(["a", "b"]);
    await assert.rejects(relay.revocations);
    assert.deepEqual([...relay.pendingRevocations], ["a", "b"]);
    for (const index of [0, 1]) {
      assert.equal(grants.authenticate(issued[index]!.token, "target"), null);
      streams.get(ids[index]!)!.send("must-not-leak");
      assert.equal(streams.get(ids[index]!)!.signal.aborted, true);
      assert.equal((await readers[index]!.read()).done, true);
      assert.equal((await fetch(`${base}/health`, { headers: headers[index] })).status, 401);
    }
    streams.get("other")!.send("still-authorized");
    assert.match(new TextDecoder().decode((await readers[2]!.read()).value), /still-authorized/);
    assert.equal((await fetch(`${base}/health`, { headers: headers[2] })).status, 200);
    await rm(`${file}.tmp`, { recursive: true });
    relay.applyRevocations([]);
    await relay.revocations;
    assert.equal(relay.pendingRevocations.size, 0);
    const restored = new DirectGrants(file, "target");
    await restored.restore();
    assert.equal(restored.authenticate(issued[0]!.token, "target"), null);
    assert.equal(restored.authenticate(issued[1]!.token, "target"), null);
    assert.equal(restored.authenticate(issued[2]!.token, "target")?.deviceId, "other");
  } finally {
    await Promise.all(readers.map((reader) => reader.cancel().catch(() => undefined)));
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
