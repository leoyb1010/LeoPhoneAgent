import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createPairingCode,
  encodePairPayload,
  PAIR_PREFIX_V2,
  probePairingSupport,
  relayHttpBase,
  type relayRequest,
} from "./pairing.js";

test("relayHttpBase normalizes relay.json urls to the relay's https root", () => {
  assert.equal(relayHttpBase("https://relay.example/leoagent-relay/"), "https://relay.example/leoagent-relay");
  assert.equal(relayHttpBase("wss://relay.example/leoagent-relay/relay/agent"), "https://relay.example/leoagent-relay");
  assert.equal(relayHttpBase("https://relay.example/relay/api"), "https://relay.example");
  assert.equal(relayHttpBase("ws://127.0.0.1:8650"), "http://127.0.0.1:8650");
});

test("encodePairPayload matches the phones' scan format", () => {
  const payload = encodePairPayload({ apiRoot: "https://r.example/relay/api", machine: "mac", join: "tok", exp: 12 });
  assert.ok(payload.startsWith(PAIR_PREFIX_V2));
  assert.deepEqual(JSON.parse(payload.slice(PAIR_PREFIX_V2.length)), {
    apiRoot: "https://r.example/relay/api",
    machine: "mac",
    join: "tok",
    exp: 12,
  });
});

test("createPairingCode tries the machine key first and falls back on 401 only", async () => {
  const calls: Array<{ key: string; body: unknown; path: string }> = [];
  const fake: typeof relayRequest = async (_base, _method, reqPath, key, body) => {
    calls.push({ key, body, path: reqPath });
    if (key === "machine-key") return { status: 401, body: {} };
    return { status: 200, body: { token: "one-time", exp: 1_900_000_000, machine: "mac-a" } };
  };
  const code = await createPairingCode({
    relayUrl: "https://relay.example/leoagent-relay",
    machine: "mac-a",
    keys: ["machine-key", "register-key"],
    request: fake,
  });
  assert.deepEqual(calls.map((call) => call.key), ["machine-key", "register-key"]);
  assert.equal(calls[0]!.path, "/relay/api/join-tokens");
  // iOS 还不会轮询 0.2 的待定配对:一定要「兑换即发钥匙」的码。
  assert.deepEqual(calls[1]!.body, { machine: "mac-a", kind: "legacy" });
  assert.equal(code.apiRoot, "https://relay.example/leoagent-relay/relay/api");
  assert.equal(code.machine, "mac-a");
  const decoded = JSON.parse(code.payload.slice(PAIR_PREFIX_V2.length)) as Record<string, unknown>;
  assert.equal(decoded["join"], "one-time");
});

test("createPairingCode reports relay errors instead of trying other keys", async () => {
  let calls = 0;
  const fake: typeof relayRequest = async () => {
    calls += 1;
    return { status: 500, body: {} };
  };
  await assert.rejects(
    createPairingCode({ relayUrl: "https://r.example", machine: "m", keys: ["a", "b"], request: fake }),
    /HTTP 500/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    createPairingCode({ relayUrl: "https://r.example", machine: "m", keys: ["a"], request: async () => ({ status: 403, body: {} }) }),
    /不认这台 Mac 的钥匙/,
  );
});

test("pairing support probe: 404 = old relay without join tokens, 401 = supported, errors = unknown", async () => {
  const reply = (status: number): typeof relayRequest => async (_b, _m, reqPath, key) => {
    assert.equal(reqPath, "/relay/api/join-tokens");
    assert.equal(key, "", "the probe never sends a real key");
    return { status, body: {} };
  };
  assert.equal(await probePairingSupport("https://r.example", reply(404)), "unsupported");
  assert.equal(await probePairingSupport("https://r.example", reply(401)), "supported");
  assert.equal(await probePairingSupport("https://r.example", reply(502)), "unknown");
  assert.equal(
    await probePairingSupport("https://r.example", async () => {
      throw new Error("offline");
    }),
    "unknown",
  );
  await assert.rejects(
    createPairingCode({ relayUrl: "https://r.example", machine: "m", keys: ["a"], request: async () => ({ status: 404, body: {} }) }),
    /版本太旧/,
  );
});

// -- 契约:对着仓库里真的中继(relay.py 0.2)走一遍「Mac 出码 → 手机兑换 → 手机用新钥匙」 --

const MASTER = "master-key-0123456789abcdef";
const here = path.dirname(fileURLToPath(import.meta.url));
const macRoot = path.resolve(here, "../../../../../../..");
const relaySource = path.join(macRoot, "leoagent", "relay.py");

function pickPython(): string | null {
  for (const candidate of [process.env["LEO_RELAY_PYTHON"], path.join(os.homedir(), ".leoagent/venv/bin/python"), "python3"]) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ["-c", "import aiohttp"], { stdio: "ignore" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

const python = existsSync(relaySource) ? pickPython() : null;

test("pairing against the real relay 0.2: one-time code -> own device key -> single use", { skip: python ? false : "no python with aiohttp" }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-pair-"));
  const port = await freePort();
  const launcher = [
    "import os, sys",
    "sys.path.insert(0, sys.argv[1])",
    "from aiohttp import web",
    "from leoagent.relay import Relay",
    "tmp = sys.argv[2]",
    "relay = Relay(os.environ['RELAY_KEY'], rejected_log=os.path.join(tmp, 'rejected.log'),",
    "  device_keys_path=os.path.join(tmp, 'device-keys.json'), treasury_sync_path=os.path.join(tmp, 'treasury.json'),",
    "  treasury_asset_dir=os.path.join(tmp, 'assets'))",
    "web.run_app(relay.build_app(), host='127.0.0.1', port=int(sys.argv[3]), print=None)",
  ].join("\n");
  const relay: ChildProcess = spawn(python!, ["-c", launcher, macRoot, dir, String(port)], {
    env: { ...process.env, HOME: dir, RELAY_KEY: MASTER },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 8000;
    for (;;) {
      const ok = await fetch(`${base}/relay/health`).then((res) => res.ok).catch(() => false);
      if (ok) break;
      if (Date.now() > deadline) throw new Error("relay did not start");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.equal(await probePairingSupport(base), "supported");
    const code = await createPairingCode({ relayUrl: base, machine: "mac-test", keys: ["not-a-key-0123456789", MASTER] });
    const pair = JSON.parse(code.payload.slice(PAIR_PREFIX_V2.length)) as { apiRoot: string; machine: string; join: string };
    assert.equal(pair.apiRoot, `${base}/relay/api`);
    assert.equal(pair.machine, "mac-test");

    // 手机:用码换钥匙(iOS RelayMachinesClient.join 的请求)。
    const joined = await fetch(`${pair.apiRoot}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: pair.join }),
    });
    assert.equal(joined.status, 200);
    const joinedBody = (await joined.json()) as { accessKey?: string; machine?: string };
    assert.ok(joinedBody.accessKey && joinedBody.accessKey.length >= 16, "phone gets its own key");
    assert.notEqual(joinedBody.accessKey, MASTER);
    assert.equal(joinedBody.machine, "mac-test");

    // 新钥匙能列机器;同一个码不能再用。
    const machines = await fetch(`${pair.apiRoot}/machines`, { headers: { authorization: `Bearer ${joinedBody.accessKey}` } });
    assert.equal(machines.status, 200);
    const reused = await fetch(`${pair.apiRoot}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: pair.join }),
    });
    assert.equal(reused.status, 409);
  } finally {
    relay.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
