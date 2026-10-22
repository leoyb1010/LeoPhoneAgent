import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// [up3-runtime] 外部 agent 仍按旧配置跑 Resources/leo/treasury-mcp.mjs;它现在是转发到
// Host HTTP MCP 端点的 stdio 垫片。这里起一个假的 Host 端点,真 spawn 垫片,走 stdio 驱动。
const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHIM = join(DESKTOP_ROOT, "leo/treasury-mcp.mjs");
const KEY = "test-treasury-key-0123456789";

type JsonRpc = { jsonrpc: "2.0"; id?: number | string | null; method?: string; params?: any; result?: any; error?: any };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

interface FakeHost {
  port: number;
  requests: Array<{ authorization?: string; host?: string; body: JsonRpc; protocolVersion?: string }>;
}

async function startFakeHost(): Promise<FakeHost> {
  const host: FakeHost = { port: 0, requests: [] };
  const server: Server = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as JsonRpc;
    host.requests.push({
      authorization: req.headers.authorization,
      host: req.headers.host,
      body,
      protocolVersion: req.headers["mcp-protocol-version"] as string | undefined,
    });
    if (req.url !== "/api/leo/treasury/mcp" || req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
      return;
    }
    if (body.id === undefined || body.method === undefined) {
      res.writeHead(202).end();
      return;
    }
    const reply = (result: unknown) =>
      res
        .writeHead(200, { "content-type": "application/json; charset=utf-8" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    switch (body.method) {
      case "initialize":
        reply({
          protocolVersion: body.params?.protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "leo-treasury", version: "test" },
        });
        return;
      case "tools/list":
        reply({ tools: [{ name: "treasury_search", description: "search", inputSchema: { type: "object" } }] });
        return;
      case "tools/call":
        // Streamable HTTP 也允许用 SSE 回;垫片两种都要会。
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: `found:${body.params?.arguments?.query}` }] },
          })}\n\n`,
        );
        return;
      default:
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } }));
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  host.port = (server.address() as AddressInfo).port;
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
  return host;
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

async function tempLeoHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "leo-shim-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function startShim(env: Record<string, string>) {
  const { LEOAGENT_KEY: _key, LEOAGENT_PORT: _port, LEOAGENT_HOME: _home, ...inherited } = process.env;
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [SHIM], {
    env: { ...inherited, ELECTRON_RUN_AS_NODE: "1", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  cleanups.push(() => {
    if (child.exitCode === null) child.kill();
  });
  const messages: JsonRpc[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => messages.push(JSON.parse(line)));
  const send = (message: JsonRpc) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = async (id: number | string | null, timeoutMs = 5_000): Promise<JsonRpc> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = messages.find((message) => message.id === id);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no reply for id ${String(id)}: ${JSON.stringify(messages)}`);
      await new Promise((done) => setTimeout(done, 10));
    }
  };
  return { child, messages, send, waitFor };
}

describe("Resources/leo/treasury-mcp.mjs stdio shim", () => {
  it("proxies initialize, tools/list and tools/call to the Host endpoint with the treasury key", async () => {
    const host = await startFakeHost();
    const shim = startShim({ LEOAGENT_PORT: String(host.port), LEOAGENT_KEY: KEY, LEOAGENT_HOME: await tempLeoHome() });

    shim.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "1" } },
    });
    const init = await shim.waitFor(1);
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "leo-treasury" } });

    shim.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    shim.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((await shim.waitFor(2)).result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "treasury_search",
    ]);

    shim.send({ jsonrpc: "2.0", id: "call-3", method: "tools/call", params: { name: "treasury_search", arguments: { query: "护照" } } });
    expect((await shim.waitFor("call-3")).result).toEqual({ content: [{ type: "text", text: "found:护照" }] });

    shim.send({ jsonrpc: "2.0", id: 4, method: "resources/list" });
    expect((await shim.waitFor(4)).error).toMatchObject({ code: -32601 });

    // 通知照样转给 Host,但不往 stdout 写任何东西。
    expect(host.requests.map((request) => request.body.method)).toContain("notifications/initialized");
    expect(shim.messages.every((message) => message.id !== undefined)).toBe(true);
    expect(host.requests.every((request) => request.authorization === `Bearer ${KEY}`)).toBe(true);
    // Host 只认 127.0.0.1:<port> 的 Host 头(防 DNS 重绑定)。
    expect(host.requests.every((request) => request.host === `127.0.0.1:${host.port}`)).toBe(true);
    expect(host.requests.at(-1)?.protocolVersion).toBe("2025-06-18");
  });

  it("reads the treasury key from LEOAGENT_HOME when the config passes no LEOAGENT_KEY", async () => {
    const host = await startFakeHost();
    const home = await tempLeoHome();
    await writeFile(join(home, "treasury.key"), `${KEY}\n`, { mode: 0o600 });
    const shim = startShim({ LEOAGENT_PORT: String(host.port), LEOAGENT_HOME: home });

    shim.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect((await shim.waitFor(1)).result.tools).toHaveLength(1);
  });

  it("answers with a clear JSON-RPC error when LeoBot is not running", async () => {
    const shim = startShim({ LEOAGENT_PORT: String(await closedPort()), LEOAGENT_KEY: KEY, LEOAGENT_HOME: await tempLeoHome() });

    shim.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    const reply = await shim.waitFor(1);
    expect(reply.error).toMatchObject({ code: -32000 });
    expect(reply.error.message).toContain("LeoBot");

    shim.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    shim.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await shim.waitFor(2);
    expect(shim.messages).toHaveLength(2);
  });

  it("reports a rejected key instead of hanging", async () => {
    const host = await startFakeHost();
    const shim = startShim({ LEOAGENT_PORT: String(host.port), LEOAGENT_KEY: "wrong-key-0123456789", LEOAGENT_HOME: await tempLeoHome() });

    shim.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const reply = await shim.waitFor(1);
    expect(reply.error).toMatchObject({ code: -32000 });
    expect(reply.error.message).toContain("401");
  });

  it("answers a malformed stdin line with a parse error and keeps serving", async () => {
    const host = await startFakeHost();
    const shim = startShim({ LEOAGENT_PORT: String(host.port), LEOAGENT_KEY: KEY, LEOAGENT_HOME: await tempLeoHome() });

    shim.child.stdin.write("{not json\n");
    expect((await shim.waitFor(null)).error).toMatchObject({ code: -32700 });
    shim.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect((await shim.waitFor(1)).result.tools).toHaveLength(1);
  });

  it("exits when stdin closes", async () => {
    const host = await startFakeHost();
    const shim = startShim({ LEOAGENT_PORT: String(host.port), LEOAGENT_KEY: KEY, LEOAGENT_HOME: await tempLeoHome() });
    const exited = new Promise<number | null>((done) => shim.child.on("exit", (code) => done(code)));
    shim.child.stdin.end();
    expect(await exited).toBe(0);
  });

  it("ships with the app bundle at Resources/leo/treasury-mcp.mjs", async () => {
    const config = (await import("../electron-builder.config.js")).default as {
      extraResources: Array<{ from: string; to: string }>;
    };
    expect(config.extraResources).toContainEqual({ from: "leo/treasury-mcp.mjs", to: "leo/treasury-mcp.mjs" });
  });
});
