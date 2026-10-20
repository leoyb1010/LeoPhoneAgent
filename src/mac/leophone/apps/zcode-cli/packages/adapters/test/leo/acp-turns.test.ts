// [leo] ACP 会话的时序与进程回收：停止后迟到的 stop 不结束新一轮、工具表按轮清、diff 上限、
// 闲置回收（支持 session/load 才收）、按进程组收进程（SIGTERM 不理时补 SIGKILL）。
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PromptResponse, SessionNotification } from "@agentclientprotocol/sdk";
import { AcpSessionManager } from "../../src/acp/manager.js";
import { spawnAcpAgent, type AcpAgentConnection } from "../../src/acp/process.js";
import { ACP_DIFF_LIMIT_BYTES, AcpSessionHost, capDiff } from "../../src/acp/session.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 每次 prompt 返回一个由测试决定何时结束的 Promise。 */
function scriptedHost() {
  const prompts: Array<ReturnType<typeof deferred<PromptResponse>>> = [];
  let cancelled = 0;
  const host = new AcpSessionHost("claude-code");
  host.attach({
    sessionId: "s1",
    agent: {
      prompt: () => {
        const next = deferred<PromptResponse>();
        prompts.push(next);
        return next.promise;
      },
      cancel: async () => {
        cancelled += 1;
      },
    },
  });
  const update = (value: SessionNotification["update"]) =>
    host.clientHandlers().sessionUpdate({ sessionId: "s1", update: value });
  const say = (text: string) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  return { host, prompts, update, say, cancelled: () => cancelled };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("cancel → late stop already queued → the next turn's first message does not end it", async () => {
  const { host, prompts, say } = scriptedHost();
  host.startTurn([{ type: "text", text: "一" }]);
  await say("半句");
  await host.cancel();
  // 运行时那边因 abort 不再取事件；agent 随后回 cancelled，stop 落进队列。
  prompts[0]!.resolve({ stopReason: "cancelled" });
  await tick();
  host.startTurn([{ type: "text", text: "二" }]);
  await say("新一轮");
  const first = await host.next();
  assert.deepEqual(first, { kind: "text", text: "新一轮" });
  assert.equal(host.turnActive, true);
});

test("cancel → new turn starts → late stop of the old turn is dropped, turnActive stays", async () => {
  const { host, prompts, say } = scriptedHost();
  host.startTurn([{ type: "text", text: "一" }]);
  await host.cancel();
  host.startTurn([{ type: "text", text: "二" }]);
  prompts[0]!.resolve({ stopReason: "cancelled" });
  await tick();
  assert.equal(host.turnActive, true, "旧一轮的 stop 不能清掉新一轮的 turnActive");
  await say("回答");
  assert.deepEqual(await host.next(), { kind: "text", text: "回答" });
  prompts[1]!.resolve({ stopReason: "end_turn" });
  const stop = await host.next();
  assert.equal(stop.kind, "stop");
  assert.equal(host.turnActive, false);
});

test("a late error of the old turn does not fail the current turn", async () => {
  const failing = new AcpSessionHost("codex");
  const first = deferred<PromptResponse>();
  let calls = 0;
  failing.attach({
    sessionId: "s",
    agent: {
      prompt: () => (++calls === 1 ? first.promise.then(() => Promise.reject(new Error("aborted"))) : new Promise(() => undefined)),
      cancel: async () => undefined,
    },
  });
  failing.startTurn([{ type: "text", text: "一" }]);
  failing.startTurn([{ type: "text", text: "二" }]);
  first.resolve({ stopReason: "cancelled" });
  await tick();
  await tick();
  assert.equal(failing.turnActive, true);
});

test("turn end wakes a tool that never got its final update; abort rejects without leaking", async () => {
  const { host, prompts, update } = scriptedHost();
  host.startTurn([{ type: "text", text: "跑" }]);
  await update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "ls", kind: "execute", status: "in_progress" });
  const event = await host.next();
  assert.equal(event.kind, "tool");
  const waiting = host.runApprovedTool("acp-t1", "t1");
  prompts[0]!.resolve({ stopReason: "end_turn" });
  const output = await waiting;
  assert.equal(output.status, "cancelled");

  host.startTurn([{ type: "text", text: "再跑" }]);
  await update({ sessionUpdate: "tool_call", toolCallId: "t2", title: "ls", kind: "execute", status: "in_progress" });
  const controller = new AbortController();
  const aborted = host.runApprovedTool("acp-t2", "t2", { signal: controller.signal });
  controller.abort(new Error("stop"));
  await assert.rejects(aborted, /stop/);
});

test("a new turn drops the previous turn's tools (the table does not grow across turns)", async () => {
  const { host, prompts, update } = scriptedHost();
  host.startTurn([{ type: "text", text: "一" }]);
  await update({ sessionUpdate: "tool_call", toolCallId: "old", title: "ls", kind: "execute", status: "completed" });
  prompts[0]!.resolve({ stopReason: "end_turn" });
  await tick();
  // 本轮结束后运行时仍能取到这一步的结果。
  assert.equal((await host.runApprovedTool("acp-old", "old")).status, "completed");
  host.startTurn([{ type: "text", text: "二" }]);
  assert.equal((await host.runApprovedTool("acp-old", "old")).text, "这一步已不在当前会话中");
});

test("diffs over 256KB become a summary", () => {
  const small = capDiff("/w/a", "a", "b");
  assert.deepEqual(small, { path: "/w/a", oldText: "a", newText: "b" });
  const big = capDiff("/w/lock", "x\n".repeat(10), "y".repeat(ACP_DIFF_LIMIT_BYTES));
  assert.equal(big.oldText, null);
  assert.match(big.newText, /改动过大/);
  assert.ok(big.newText.length < 200);
});

function fakeClaudeEnvironment() {
  const home = mkdtempSync(join(tmpdir(), "leo-acp-reap-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  const claude = join(bin, "claude");
  writeFileSync(claude, "#!/bin/sh\nexit 0\n");
  chmodSync(claude, 0o755);
  return { home, environment: { env: { PATH: bin, HOME: home }, resolveClaudeAgentAcpEntry: () => "/fake/acp.js" } };
}

function reapManager(loadSession: boolean) {
  const { home, environment } = fakeClaudeEnvironment();
  const statePath = join(home, "acp-sessions.json");
  const connects: Array<{ resumeSessionId?: string }> = [];
  let disposed = 0;
  const manager = new AcpSessionManager({
    environment,
    statePath,
    idleMs: 1_000,
    connect: (async (_launch: unknown, options: { host: AcpSessionHost; resumeSessionId?: string }) => {
      connects.push({ ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}) });
      options.host.attach({ sessionId: "acp-1", agent: { prompt: async () => ({ stopReason: "end_turn" }), cancel: async () => undefined } });
      return {
        connection: {} as never,
        initialize: { protocolVersion: 1, agentCapabilities: { loadSession } },
        sessionId: "acp-1",
        resumed: Boolean(options.resumeSessionId),
        dispose: () => {
          disposed += 1;
        },
      } as AcpAgentConnection;
    }) as never,
  });
  return { manager, statePath, connects, disposed: () => disposed };
}

test("idle agents that support session/load are reaped and resumed on the next message", async () => {
  const { manager, statePath, connects, disposed } = reapManager(true);
  await manager.ensure("leo-1", "claude-code", "/w");
  await tick();
  assert.equal(JSON.parse(readFileSync(statePath, "utf8"))["leo-1"].acpSessionId, "acp-1");
  assert.deepEqual(manager.reapIdle(Date.now()), [], "还没闲置够");
  assert.deepEqual(manager.reapIdle(Date.now() + 2_000), ["leo-1"]);
  assert.equal(disposed(), 1);
  assert.equal(manager.host("leo-1"), undefined);
  await manager.ensure("leo-1", "claude-code", "/w");
  assert.deepEqual(connects, [{}, { resumeSessionId: "acp-1" }]);
  manager.disposeAll();
});

test("idle agents without session/load keep their process", async () => {
  const { manager, disposed } = reapManager(false);
  await manager.ensure("leo-1", "claude-code", "/w");
  await tick();
  assert.deepEqual(manager.reapIdle(Date.now() + 2_000), []);
  assert.equal(disposed(), 0);
  assert.ok(manager.host("leo-1"));
  manager.disposeAll();
});

test("busy agents (turn running) are never reaped", async () => {
  const { manager, disposed } = reapManager(true);
  const { host } = await manager.ensure("leo-1", "claude-code", "/w");
  await tick();
  host.attach({ sessionId: "acp-1", agent: { prompt: () => new Promise(() => undefined), cancel: async () => undefined } });
  host.startTurn([{ type: "text", text: "跑很久" }]);
  assert.deepEqual(manager.reapIdle(Date.now() + 2_000), []);
  assert.equal(disposed(), 0);
  manager.disposeAll();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("dispose kills the whole process group, escalating to SIGKILL when SIGTERM is ignored", { skip: process.platform === "win32" }, async () => {
  // 假 agent：不理 SIGTERM，不回握手，自己再起一个同样不理 SIGTERM 的孙进程。
  const grandchild = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
  const script = `
    process.on("SIGTERM", () => {});
    const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });
    process.stderr.write("pids " + process.pid + " " + child.pid + "\\n");
    setInterval(() => {}, 1000);
  `;
  let stderr = "";
  await assert.rejects(
    spawnAcpAgent(
      { command: process.execPath, args: ["-e", script], env: { PATH: process.env.PATH ?? "" } } as never,
      {
        host: new AcpSessionHost("claude-code"),
        cwd: tmpdir(),
        stageTimeouts: { initialize: 500 },
        killGraceMs: 200,
        onStderr: (chunk) => {
          stderr += chunk;
        },
      },
    ),
  );
  const match = /pids (\d+) (\d+)/.exec(stderr);
  assert.ok(match, `没拿到进程号：${stderr}`);
  const pids = [Number(match[1]), Number(match[2])];
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(pids.every(alive), "SIGTERM 被忽略，宽限期内还活着");
  const deadline = Date.now() + 3_000;
  while (pids.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(!pids.some(alive), "宽限期后整组被 SIGKILL");
});
