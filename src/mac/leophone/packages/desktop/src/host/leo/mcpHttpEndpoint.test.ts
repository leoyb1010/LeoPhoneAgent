// [up-d-mac] 藏宝阁 / 第二大脑的共享 HTTP MCP 端点:用 CLI 同款 SDK 客户端(auto 版本协商,先发
// server/discover 再退回 initialize)真连一遍,确认 CLI 能列出并调用工具、返回形状与原 stdio 脚本一致。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { createBrainMcpServer } from "./brainTools.js";
import { handleMcpHttpRequest } from "./mcpHttpEndpoint.js";
import { createTreasuryMcpServer } from "./treasuryTools.js";

const dir = mkdtempSync(join(tmpdir(), "leo-mcp-http-"));
const keyFile = join(dir, "leobot-mac.key");
writeFileSync(keyFile, "brain-key-for-test\n", { mode: 0o600 });
const uploadFile = join(dir, "note.txt");
writeFileSync(uploadFile, "hello brain");

const gatewayCalls: Array<{ url: string; auth: string | null; body?: string }> = [];
const fakeGateway: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  const body = init?.body instanceof Blob ? await init.body.text() : (init?.body as string);
  gatewayCalls.push({ url: String(input), auth: headers.get("authorization"), body });
  if (String(input).includes("/v1/brief")) {
    return new Response("brief text", { headers: { "content-type": "text/plain" } });
  }
  if (String(input).includes("/v1/search")) {
    return new Response(JSON.stringify({ error: "bad key" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json" },
  });
};

const store = {
  search: () => [
    {
      id: "t1",
      kind: "note",
      title: "Saved",
      source_uri: null,
      tags: [],
      annotation: "",
      reading_state: "none",
      archived: false,
      pinned: false,
      created_at: "",
      updated_at: "",
      content: "",
      score: 1,
    },
  ],
} as never;

const treasury = createTreasuryMcpServer(store);
const brain = createBrainMcpServer({ keyFile, baseUrl: "https://gateway.test", fetch: fakeGateway });

let server: Server;
let base = "";
before(async () => {
  server = createServer((req, res) => {
    const target = req.url === "/brain" ? brain : treasury;
    void handleMcpHttpRequest(target, req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

async function connect(path: string) {
  const client = new Client(
    { name: "leo-test", version: "0.0.0" },
    // 与 CLI adapters/src/mcp/index.ts 对 http server 的默认一致:auto 协商。
    { versionNegotiation: { mode: "auto", probe: { timeoutMs: 5_000 } } },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(base + path)));
  return client;
}

test("treasury: the CLI's SDK client connects, lists and calls tools; payload stays in the first text block", async () => {
  const client = await connect("/treasury");
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["treasury_search", "treasury_get", "treasury_save", "treasury_update"],
    );
    const result = await client.callTool({
      name: "treasury_search",
      arguments: { query: "saved" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const payload = JSON.parse(text) as { untrusted_content: boolean; items: Array<{ id: string }> };
    assert.equal(payload.untrusted_content, true);
    assert.equal(payload.items[0]!.id, "t1");
    // 写操作缺 user_confirmed:照旧是 {error} 放在 text 里,不是协议错误。
    const refused = await client.callTool({
      name: "treasury_save",
      arguments: { kind: "note", content: "x" },
    });
    const refusedText = (refused.content as Array<{ text: string }>)[0]!.text;
    assert.match(refusedText, /user_confirmed/);
  } finally {
    await client.close();
  }
});

test("brain: key is read per request into Authorization only; gateway errors become isError results", async () => {
  const client = await connect("/brain");
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 9);
    assert.ok(tools.some((tool) => tool.name === "brain_upload"));

    const brief = await client.callTool({ name: "brain_brief", arguments: {} });
    assert.equal((brief.content as Array<{ text: string }>)[0]!.text, "brief text");
    assert.equal(gatewayCalls.at(-1)!.auth, "Bearer brain-key-for-test");

    // 换 key 文件内容后立即生效:Host 每次请求都重新读。
    writeFileSync(keyFile, "rotated-key\n");
    const failed = await client.callTool({ name: "brain_search", arguments: { query: "x" } });
    assert.equal(failed.isError, true);
    assert.match((failed.content as Array<{ text: string }>)[0]!.text, /HTTP 401 bad key/);
    assert.equal(gatewayCalls.at(-1)!.auth, "Bearer rotated-key");
    assert.ok(!(failed.content as Array<{ text: string }>)[0]!.text.includes("rotated-key"));

    const uploaded = await client.callTool({ name: "brain_upload", arguments: { path: uploadFile } });
    assert.notEqual(uploaded.isError, true);
    assert.equal(gatewayCalls.at(-1)!.body, "hello brain");
  } finally {
    await client.close();
  }
});

test("protocol edges: notifications are 202, GET is 405, unknown tools are a JSON-RPC error", async () => {
  const post = (body: unknown) =>
    fetch(`${base}/treasury`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    });
  assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  assert.equal((await fetch(`${base}/treasury`)).status, 405);
  const unknown = (await (
    await post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "nope" } })
  ).json()) as { id: number; error: { code: number } };
  assert.equal(unknown.id, 7);
  assert.equal(unknown.error.code, -32602);
  const discover = (await (await post({ jsonrpc: "2.0", id: 8, method: "server/discover" })).json()) as {
    error: { code: number };
  };
  assert.equal(discover.error.code, -32601);
});
