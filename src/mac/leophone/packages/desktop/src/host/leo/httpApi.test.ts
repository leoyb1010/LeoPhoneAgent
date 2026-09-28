import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer, connect } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type { Server } from "node:http";

const home = await mkdtemp(path.join(os.tmpdir(), "leo-httpapi-"));
const port = await new Promise<number>((resolve) => {
  const probe = createNetServer().listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
  });
});
process.env["LEOAGENT_HOME"] = home;
process.env["LEOAGENT_PORT"] = String(port);
process.env["LEO_PAIR_SECRET"] = "pair-secret-for-test";
delete process.env["LEOAGENT_KEY"];

const { startLeoHttpApi, readJsonBody } = await import("./httpApi.js");
const { leoLocalKey, leoTreasuryKey } = await import("./leoPaths.js");

let server: Server;
const logs: string[] = [];

before(async () => {
  server = startLeoHttpApi({
    store: { count: () => 0 } as never,
    logger: { info: () => {}, warn: (msg) => logs.push(msg) },
    onSubscriptionChanged: () => {},
    onListening: () => {},
    onPortBusy: () => {},
  });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
});

function call(
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  body?: Buffer | string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method, path: pathname, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed: Record<string, unknown> = {};
          try {
            parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          } catch {
            parsed = { raw };
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** 原始 socket 发请求行:http.request 会把 `//` 规范化掉,打不出那条崩溃路径。 */
function rawRequestLine(line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`${line}\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    let raw = "";
    socket.on("data", (chunk) => (raw += chunk.toString("utf8")));
    socket.on("end", () => resolve(raw));
    socket.on("error", reject);
  });
}

test("GET // no longer takes the host down: answers 400 and keeps serving", async () => {
  const raw = await rawRequestLine("GET // HTTP/1.1");
  assert.match(raw, /^HTTP\/1\.1 400/);
  const health = await call("GET", "/api/leo/health");
  assert.equal(health.status, 200);
  assert.equal(health.body["app"], "leophoneagent-1.x");
});

test("request bodies are decoded after reassembly: multi-byte chars split across chunks survive", async () => {
  const text = "中文长上下文".repeat(4000);
  const payload = Buffer.from(JSON.stringify({ text }), "utf8");
  const { PassThrough } = await import("node:stream");
  const stream = new PassThrough();
  const pending = readJsonBody(stream as never);
  // 故意在一个汉字(3 字节)中间切块。
  for (let offset = 0; offset < payload.length; offset += 1001) stream.write(payload.subarray(offset, offset + 1001));
  stream.end();
  const parsed = await pending;
  assert.equal(parsed["text"], text);
});

test("oversized bodies get 413 instead of hanging forever", async () => {
  const { PassThrough } = await import("node:stream");
  const stream = new PassThrough();
  const pending = readJsonBody(stream as never, 1024);
  stream.write(Buffer.alloc(2048, 0x61));
  await assert.rejects(pending, (error: Error & { status?: number }) => error.status === 413);
});

test("pairing needs the in-memory secret, not just the local key file", async () => {
  const bearer = { authorization: `Bearer ${leoLocalKey()}` };
  const withoutSecret = await call("POST", "/api/leo/link/pair", bearer);
  assert.equal(withoutSecret.status, 403);
  const withSecret = await call("POST", "/api/leo/link/pair", { ...bearer, "x-leo-pair": "pair-secret-for-test" });
  // 测试里没配中继:口令对了才会走到出码逻辑,报「还没配置中继」。
  assert.equal(withSecret.status, 502);
  assert.match(String(withSecret.body["error"]), /中继/);
});

test("the pairing secret is scrubbed from the environment so child processes can't inherit it", () => {
  assert.equal(process.env["LEO_PAIR_SECRET"], undefined);
});

test("treasury key only opens the treasury, and is what mcp.json gets", async () => {
  const treasury = { authorization: `Bearer ${leoTreasuryKey()}` };
  assert.notEqual(leoTreasuryKey(), leoLocalKey());
  assert.equal((await call("GET", "/api/leo/treasury/tools", treasury)).status, 200);
  assert.equal((await call("GET", "/api/leo/link/status", treasury)).status, 401);
  assert.equal((await call("GET", "/v1/models", treasury)).status, 401);
  assert.equal(
    (await call("POST", "/api/leo/link/pair", { ...treasury, "x-leo-pair": "pair-secret-for-test" })).status,
    401,
  );
  assert.equal(readFileSync(path.join(home, "treasury.key"), "utf8").trim(), leoTreasuryKey());
});

test("unknown treasury tools are a 404, not a 200 with an error inside", async () => {
  const res = await call("POST", "/api/leo/treasury/call/nope", { authorization: `Bearer ${leoLocalKey()}` }, "{}");
  assert.equal(res.status, 404);
});

test("malformed JSON is a 400, not a silent empty body", async () => {
  const res = await call(
    "POST",
    "/api/leo/treasury/call/treasury_search",
    { authorization: `Bearer ${leoLocalKey()}`, "content-type": "application/json" },
    "{not json",
  );
  assert.equal(res.status, 400);
});

test("leoagent events are only accepted with leoagent's own key and only for pushable events", async () => {
  const { writeFileSync } = await import("node:fs");
  const agentKey = "leoagent-local-key-for-test-0123456789";
  writeFileSync(path.join(home, "leoagent-local.key"), agentKey);
  const event = { event: "approval.request", session_id: "hs_abc", tool: "Bash" };
  const body = (e: unknown) => JSON.stringify({ event: e });
  assert.equal((await call("POST", "/api/leo/link/leoagent-event", {}, body(event))).status, 401);
  assert.equal(
    (await call("POST", "/api/leo/link/leoagent-event", { authorization: `Bearer ${leoLocalKey()}` }, body(event))).status,
    401,
  );
  const agent = { authorization: `Bearer ${agentKey}` };
  assert.equal(
    (await call("POST", "/api/leo/link/leoagent-event", agent, body({ ...event, event: "message.delta" }))).status,
    400,
  );
  // 测试里没开桥接:钥匙和事件都对,才走到「连接没在跑」。
  assert.equal((await call("POST", "/api/leo/link/leoagent-event", agent, body(event))).status, 503);
});

test("malformed %-escapes in a path parameter are a 400, not a 500 with a warning", async () => {
  const before = logs.length;
  const res = await call("POST", "/api/leo/ui/oauth/providers/%E0%A4%A/login", { "x-leo-ui": "1" }, "{}");
  assert.equal(res.status, 400);
  assert.equal(logs.length, before);
});

test("chat requests without messages are a 400 before any model runtime loads", async () => {
  const res = await call(
    "POST",
    "/v1/chat/completions",
    { authorization: `Bearer ${leoLocalKey()}`, "content-type": "application/json" },
    JSON.stringify({ model: "openai-codex/gpt-6" }),
  );
  assert.equal(res.status, 400);
});

test("a chat body past the proxy limit reads as context overflow so the agent compacts instead of failing forever", async () => {
  const huge = JSON.stringify({ model: "x/y", messages: [{ role: "user", content: "a".repeat(49 * 1024 * 1024) }] });
  const res = await call(
    "POST",
    "/v1/chat/completions",
    { authorization: `Bearer ${leoLocalKey()}`, "content-type": "application/json" },
    huge,
  );
  assert.equal(res.status, 400);
  assert.equal((res.body["error"] as Record<string, unknown>)["code"], "context_length_exceeded");
});

test("direct configuration, pairing and revocation require the same local UI-only secret", async () => {
  const bearer = { authorization: `Bearer ${leoLocalKey()}` };
  for (const action of ["configure", "pair", "revoke"]) {
    assert.equal((await call("POST", `/api/leo/link/direct/${action}`, bearer, "{}")).status, 403);
    assert.equal((await call("POST", `/api/leo/link/direct/${action}`, { authorization: `Bearer ${leoTreasuryKey()}`, "x-leo-pair": "pair-secret-for-test" }, "{}")).status, 401);
  }
  const invalid = await call("POST", "/api/leo/link/direct/configure", { ...bearer, "x-leo-pair": "pair-secret-for-test" }, JSON.stringify({ enabled: true, baseURL: "http://not-tailnet.example", port: 38474 }));
  assert.equal(invalid.status, 400);
});
