import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LeoDeviceDescriptor } from "@zcode/shared/leo-device";
import type { LinkBridge, LinkRequest } from "./bridge.js";
import { DirectGrants } from "./directGrants.js";
import { startDirectServer } from "./directServer.js";

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
