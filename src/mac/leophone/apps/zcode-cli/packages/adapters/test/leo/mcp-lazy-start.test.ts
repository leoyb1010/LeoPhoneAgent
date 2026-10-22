// [leo] 按需启动的 stdio MCP(node_repl):连上列完工具就停进程,首次工具调用再拉起;
// 并发调用共用一次拉起;存活校验不会把它拉起来。用一个真实的 stdio 小服务记录每次启动。

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { createMcpAdapter } from "../../src/mcp/index.js";

const dir = mkdtempSync(join(tmpdir(), "leo-mcp-lazy-"));
const spawnLog = join(dir, "spawns.log");
const serverScript = join(dir, "server.mjs");
writeFileSync(
  serverScript,
  `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync(${JSON.stringify(spawnLog)}, process.pid + "\\n");
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: msg.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "lazy", version: "1.0.0" },
    } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "js", description: "run", inputSchema: { type: "object", properties: {} } },
    ] } });
  } else if (msg.method === "tools/call") {
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "pid " + process.pid }] } });
  } else {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
`,
);

after(() => rmSync(dir, { recursive: true, force: true }));

const config = {
  type: "stdio" as const,
  command: process.execPath,
  args: [serverScript],
  protocolVersion: "legacy" as const,
  leoLazyStart: true,
};

const spawnedPids = () => readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).map(Number);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("lazy-start server: tools listed, process stopped, woken once by concurrent first calls", async () => {
  writeFileSync(spawnLog, "");
  const adapter = createMcpAdapter({ env: {} });
  try {
    const status = await adapter.connectServer("node_repl", config);
    assert.equal(status.status, "connected");
    assert.deepEqual(
      (await adapter.listTools()).map((tool) => tool.toolName),
      ["js"],
    );
    const [firstPid] = spawnedPids();
    assert.equal(spawnedPids().length, 1);
    await waitUntil(() => !isAlive(firstPid!));

    // 存活校验(设置页刷新)不拉起停放中的 server。
    assert.equal(await adapter.pingServer?.("node_repl"), true);
    assert.equal(spawnedPids().length, 1);
    assert.equal((await adapter.status())["node_repl"]?.status, "connected");

    const calls = await Promise.all([
      adapter.callTool({ serverName: "node_repl", toolName: "js", arguments: {} }),
      adapter.callTool({ serverName: "node_repl", toolName: "js", arguments: {} }),
    ]);
    assert.equal(spawnedPids().length, 2);
    const wokenPid = spawnedPids()[1]!;
    for (const result of calls) {
      assert.equal((result.content[0] as { text: string }).text, `pid ${wokenPid}`);
    }
    // 唤醒后常驻,后续调用不再拉起。
    await adapter.callTool({ serverName: "node_repl", toolName: "js", arguments: {} });
    assert.equal(spawnedPids().length, 2);
    assert.ok(isAlive(wokenPid));
  } finally {
    await adapter.close();
  }
});

test("a failed wake surfaces the start error to the caller and the status, and the next call retries", async () => {
  writeFileSync(spawnLog, "");
  const failMarker = join(dir, "fail-next-start");
  const flaky = join(dir, "flaky.mjs");
  writeFileSync(
    flaky,
    `import { existsSync } from "node:fs";
if (existsSync(${JSON.stringify(failMarker)})) {
  process.stderr.write("node_repl boot failed: missing runtime\\n");
  process.exit(3);
}
await import(${JSON.stringify(serverScript)});
`,
  );
  const adapter = createMcpAdapter({ env: {} });
  try {
    await adapter.connectServer("node_repl", { ...config, args: [flaky] });
    const [firstPid] = spawnedPids();
    await waitUntil(() => !isAlive(firstPid!));

    writeFileSync(failMarker, "");
    await assert.rejects(
      adapter.callTool({ serverName: "node_repl", toolName: "js", arguments: {} }),
      (error: Error) => {
        assert.match(error.message, /node_repl failed to start/);
        assert.doesNotMatch(error.message, /is not connected/);
        return true;
      },
    );
    const failed = (await adapter.status())["node_repl"];
    assert.equal(failed?.status, "failed");
    assert.ok(failed?.error);
    // 工具仍在列表里(停放状态保留),修好后下一次调用照常拉起。
    assert.deepEqual(
      (await adapter.listTools()).map((tool) => tool.toolName),
      ["js"],
    );
    rmSync(failMarker);
    const result = await adapter.callTool({
      serverName: "node_repl",
      toolName: "js",
      arguments: {},
    });
    assert.match((result.content[0] as { text: string }).text, /^pid \d+$/);
    assert.equal((await adapter.status())["node_repl"]?.status, "connected");
  } finally {
    await adapter.close();
  }
});

test("servers without the flag still connect eagerly and stay up", async () => {
  writeFileSync(spawnLog, "");
  const adapter = createMcpAdapter({ env: {} });
  try {
    const { leoLazyStart: _lazy, ...eager } = config;
    await adapter.connectServer("eager", eager);
    const [pid] = spawnedPids();
    assert.ok(isAlive(pid!));
    await adapter.callTool({ serverName: "eager", toolName: "js", arguments: {} });
    assert.equal(spawnedPids().length, 1);
  } finally {
    await adapter.close();
  }
});
