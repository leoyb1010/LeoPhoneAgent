import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import dns from "node:dns";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { LinkBridge, LinkRequest } from "./bridge.js";
import { RelayLink, tailnetLookup, type MachineKeyStore } from "./relayLink.js";

/**
 * 契约测试:对着仓库里真的中继(src/mac/leoagent/relay.py,0.2)跑 RelayLink。
 * 覆盖注册 + 机器名钉扎(领机器专属钥匙)、调用方透传、request id、事件流、关键事件上报、
 * 用机器钥匙重连。本机没有带 aiohttp 的 Python 时跳过。
 */
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

async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      // 还没起来
    }
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function memoryKeys(): MachineKeyStore & { value: string | null } {
  return {
    value: null,
    async get() {
      return this.value;
    },
    async set(key: string) {
      this.value = key;
    },
  };
}

const python = existsSync(relaySource) ? pickPython() : null;

test("RelayLink against the real relay 0.2: pin, caller, request id, stream, push, reconnect", { skip: python ? false : "no python with aiohttp" }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-relay-"));
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
    // HOME 指到临时目录:中继的默认路径(推送配置、设备表)都落在 ~/.leoagent,测试绝不能碰真的。
    env: { ...process.env, HOME: dir, RELAY_KEY: MASTER },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  const auth = (key: string) => ({ Authorization: `Bearer ${key}` });
  const seen: LinkRequest[] = [];
  const bridge = {
    async handle(req: LinkRequest) {
      seen.push(req);
      return { status: 200, body: { path: req.path } };
    },
    async stream(req: LinkRequest, write: (data: string) => void, signal: AbortSignal) {
      seen.push(req);
      write(JSON.stringify({ event: "message.delta", seq: 1, delta: "hi" }));
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 300);
      });
    },
  } as unknown as LinkBridge;
  const keys = memoryKeys();
  const config = { wsUrl: `ws://127.0.0.1:${port}/relay/agent`, name: "TestMac", registerKey: MASTER };
  const silent = { info() {}, warn() {} };
  let link = new RelayLink(config, bridge, keys, silent, "test");
  try {
    await waitFor(async () => (await fetch(`${base}/relay/health`)).ok);
    link.start();
    // 首次注册用主钥匙,领到机器专属钥匙
    const machineKey = await waitFor(async () => keys.value);
    assert.ok(machineKey.length >= 16);
    const machines = await waitFor(async () => {
      const body = (await (await fetch(`${base}/relay/api/machines`, { headers: auth(MASTER) })).json()) as { machines: { name: string }[] };
      return body.machines.some((m) => m.name === "TestMac") ? body.machines : null;
    });
    assert.ok(machines.length >= 1);

    const exchanged = (await (await fetch(`${base}/relay/api/device/exchange`, {
      method: "POST", headers: { ...auth(MASTER), "Content-Type": "application/json" }, body: JSON.stringify({ name: "iPhone" }),
    })).json()) as { accessKey: string; deviceId: string };

    const health = await fetch(`${base}/relay/api/m/TestMac/health`, { headers: auth(exchanged.accessKey) });
    assert.equal(health.status, 200);
    assert.deepEqual(seen.at(-1)?.caller, { kind: "iphone", deviceId: exchanged.deviceId, name: "iPhone" });

    const created = await fetch(`${base}/relay/api/m/TestMac/harness/sessions`, {
      method: "POST",
      headers: { ...auth(exchanged.accessKey), "Content-Type": "application/json", "X-Leo-Request-Id": "req-42" },
      body: JSON.stringify({ harness: "zcode", prompt: "hi" }),
    });
    assert.equal(created.status, 200);
    assert.equal(seen.at(-1)?.requestId, "req-42");
    assert.deepEqual(seen.at(-1)?.body, { harness: "zcode", prompt: "hi" });

    const stream = await fetch(`${base}/relay/api/m/TestMac/harness/sessions/s1/events?after=0`, { headers: auth(exchanged.accessKey) });
    assert.ok((await stream.text()).includes('data: {"event":"message.delta","seq":1,"delta":"hi"}'));

    link.pushEvent({ event: "run.completed", session_id: "s1", seq: 2 });
    const events = await waitFor(async () => {
      const body = (await (await fetch(`${base}/relay/api/events`, { headers: auth(exchanged.accessKey) })).json()) as { events: { machine: string; event: { event: string } }[] };
      return body.events.find((e) => e.machine === "TestMac" && e.event.event === "run.completed");
    });
    assert.ok(events);

    // 重连只用机器钥匙;主钥匙已经顶不掉这个名字
    link.stop();
    link = new RelayLink({ ...config, registerKey: "wrong-key-0123456789abcdef" }, bridge, keys, silent, "test");
    link.start();
    await waitFor(async () => (await fetch(`${base}/relay/api/m/TestMac/health`, { headers: auth(exchanged.accessKey) })).status === 200);

    // 中继解了钉(或丢了状态):存着的机器钥匙不再被认(4001),链路改用注册钥匙重新领一把,而不是一直被拒
    link.stop();
    const unpinned = await fetch(`${base}/relay/api/machines/TestMac/unpin`, { method: "POST", headers: auth(MASTER) });
    assert.equal(unpinned.status, 200);
    const stale = keys.value;
    link = new RelayLink(config, bridge, keys, silent, "test");
    link.start();
    const fresh = await waitFor(async () => (keys.value !== stale ? keys.value : null), 15_000);
    assert.ok(fresh && fresh.length >= 16);
    await waitFor(async () => (await fetch(`${base}/relay/api/m/TestMac/health`, { headers: auth(exchanged.accessKey) })).status === 200);
  } finally {
    link.stop();
    relay.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("tailnetLookup only touches *.ts.net names and falls back to the system resolver", async () => {
  // 故意给一个不可达的 DNS:tailnet 名字解析失败时必须退回系统解析,而不是报错卡住连接。
  const lookup = tailnetLookup(["127.0.0.1:9"]);
  const resolve = (hostname: string) =>
    new Promise<{ error: unknown; address: unknown }>((done) => {
      lookup(hostname, { family: 4 }, (error, address) => done({ error, address }));
    });
  const local = await resolve("localhost");
  assert.equal(local.error, null);
  assert.equal(local.address, "127.0.0.1");
  // tailnet DNS 不可达时,结果必须和系统解析一模一样(开着 Clash 假 IP 时系统解析也会给地址)。
  const name = "no-such-machine.example-tailnet.ts.net";
  const tailnet = await resolve(name);
  const system = await new Promise<{ error: unknown; address: unknown }>((done) => {
    dns.lookup(name, { family: 4 }, (error, address) => done({ error, address }));
  });
  assert.equal(Boolean(tailnet.error), Boolean(system.error));
  assert.equal(tailnet.address, system.address);
});
