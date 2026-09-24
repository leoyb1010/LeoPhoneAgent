import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { IZCodeTaskService } from "@zcode/services";

import { LinkBridge, type LinkRequest } from "./bridge.js";
import type { HarnessEvent } from "./journal.js";
import type { Caller } from "./session.js";

type Call = [string, Record<string, unknown>];

/** 只实现桥接用到的那几个方法;流事件由测试手动 fire。 */
function fakeZCode() {
  const listeners = new Map<string, (event: unknown) => void>();
  const calls: Call[] = [];
  let next = 0;
  const record = (name: string) => async (params: Record<string, unknown>) => {
    calls.push([name, params]);
    return true;
  };
  const service = {
    async createTask(params: Record<string, unknown>) {
      calls.push(["createTask", params]);
      next += 1;
      return { taskId: `task-${next}` };
    },
    setMode: record("setMode"),
    sendPrompt: record("sendPrompt"),
    resumeTask: record("resumeTask"),
    stopGeneration: record("stopGeneration"),
    respondPermission: record("respondPermission"),
    respondElicitation: record("respondElicitation"),
    onDynamicTaskEvent(params: { taskId: string }) {
      return (listener: (event: unknown) => void) => {
        listeners.set(params.taskId, listener);
        return { dispose: () => listeners.delete(params.taskId) };
      };
    },
  };
  return {
    service: service as unknown as IZCodeTaskService,
    calls,
    named: (name: string) => calls.filter(([n]) => n === name).map(([, p]) => p),
    fire: (taskId: string, event: Record<string, unknown>) => listeners.get(taskId)?.({ taskId, traceId: "trace", ...event }),
  };
}

const unknown: Caller = { kind: "unknown" };
const iphone: Caller = { kind: "iphone", deviceId: "dev-iphone" };
const legacy: Caller = { kind: "legacy", deviceId: "dev-fold" };
const silent = { info() {}, warn() {} };
const permissionOptions = [
  { optionId: "allow_once", kind: "allow_once", name: "Allow", response: { decision: "allow" } },
  { optionId: "allow_project", kind: "allow_always", name: "Always allow in this project", response: { decision: "allow" } },
  { optionId: "deny", kind: "deny", name: "Deny", response: { decision: "deny" } },
];

function permission(requestId: string, toolName: string, input: Record<string, unknown>) {
  return {
    type: "permission_request",
    requestId,
    description: toolName,
    kind: toolName,
    title: toolName,
    options: permissionOptions,
    raw: { requestId, toolName, reason: "needs approval", input },
  };
}

async function withBridge(
  run: (ctx: { bridge: LinkBridge; zcode: ReturnType<typeof fakeZCode>; dir: string; pushed: HarnessEvent[] }) => Promise<void>,
  options: { leoagentUrl?: string; dir?: string } = {},
) {
  const dir = options.dir ?? (await mkdtemp(path.join(os.tmpdir(), "leo-link-")));
  const zcode = fakeZCode();
  const pushed: HarnessEvent[] = [];
  const bridge = new LinkBridge({
    taskService: zcode.service,
    logger: silent,
    push: (event) => pushed.push(event),
    appVersion: "test",
    journalDir: path.join(dir, "journals"),
    leoagent: { url: options.leoagentUrl ?? "http://127.0.0.1:9", key: () => "local-key-0123456789" },
  });
  try {
    await run({ bridge, zcode, dir, pushed });
  } finally {
    await bridge.close();
    if (!options.dir) await rm(dir, { recursive: true, force: true });
  }
}

function req(method: string, pathname: string, body?: unknown, caller: Caller = unknown, requestId?: string): LinkRequest {
  return { method, path: pathname, body, caller, ...(requestId ? { requestId } : {}) };
}

/** 读事件流直到 until 满足(或超时),返回除续传信封以外的事件。 */
async function collect(bridge: LinkBridge, sessionId: string, after: number, until: (events: HarnessEvent[]) => boolean, timeoutMs = 2000) {
  const controller = new AbortController();
  const events: HarnessEvent[] = [];
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  await bridge.stream(req("GET", `/harness/sessions/${sessionId}/events?after=${after}`), (data) => {
    const frame = JSON.parse(data) as HarnessEvent;
    if (frame["type"] === "resume") return;
    events.push(frame);
    if (until(events)) controller.abort();
  }, controller.signal);
  clearTimeout(timer);
  return events;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function createSession(bridge: LinkBridge, cwd: string, extra: Record<string, unknown> = {}, caller: Caller = unknown): Promise<string> {
  const created = await bridge.handle(req("POST", "/harness/sessions", { harness: "zcode", cwd, ...extra }, caller));
  assert.equal(created.status, 202, JSON.stringify(created.body));
  return (created.body as { session_id: string }).session_id;
}

test("a phone-created task streams mapped v0.4 events with continuous seq", async () => {
  await withBridge(async ({ bridge, zcode, dir }) => {
    const id = await createSession(bridge, dir, { prompt: "你好" });
    assert.deepEqual(zcode.named("createTask")[0], { workspacePath: dir, v4Create: true });
    assert.deepEqual(zcode.named("setMode")[0], { taskId: id, mode: "build" });
    assert.equal(zcode.named("sendPrompt")[0]?.["content"], "你好");

    zcode.fire(id, { type: "task_run_started", startedAt: 1 });
    zcode.fire(id, { type: "agent_thought_chunk", content: "想" });
    zcode.fire(id, { type: "agent_thought_chunk", content: "一下" });
    zcode.fire(id, { type: "agent_message_chunk", content: "在的" });
    zcode.fire(id, { type: "agent_message_chunk", content: "子 agent 的话", parentToolUseId: "tool-9" });
    zcode.fire(id, { type: "tool_call", toolId: "x1", toolName: "Bash", kind: "Bash", title: "Bash", input: { command: "ls -la" }, raw: {} });
    zcode.fire(id, { type: "tool_call_update", toolId: "x1", status: "completed", raw: {} });
    zcode.fire(id, { type: "task_complete", stopReason: "success", usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } });

    const events = await collect(bridge, id, 0, (all) => all.some((e) => e.event === "run.completed"));
    assert.deepEqual(events.map((e) => e.event), [
      "session.created", "user.message", "reasoning.available", "message.delta", "tool.started", "tool.completed", "run.completed",
    ]);
    assert.deepEqual(events.map((e) => e["seq"]), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(events[2]?.["text"], "想一下");
    assert.equal(events[3]?.["delta"], "在的");
    assert.equal(events[4]?.["preview"], "ls -la");
    assert.equal(events[5]?.["tool"], "Bash");
    assert.equal(events[5]?.["error"], false);
    assert.deepEqual(events[6]?.["usage"], { input_tokens: 3, output_tokens: 4, total_tokens: 7 });
    assert.ok(events.every((e) => e["session_id"] === id));

    // 从中间续传:只拿到之后的,不重复
    const resumed = await collect(bridge, id, 5, (all) => all.some((e) => e.event === "run.completed"));
    assert.deepEqual(resumed.map((e) => e["seq"]), [6, 7]);

    const list = (await bridge.handle(req("GET", "/harness/sessions"))).body as { sessions: Record<string, unknown>[] };
    assert.equal(list.sessions[0]?.["session_id"], id);
    assert.equal(list.sessions[0]?.["status"], "idle");
    assert.equal(list.sessions[0]?.["harness"], "zcode");
  });
});

test("approvals: once, task-scoped always, deny, and answers given on the Mac", async () => {
  await withBridge(async ({ bridge, zcode, dir, pushed }) => {
    const id = await createSession(bridge, dir, { prompt: "跑测试" });
    zcode.fire(id, permission("r1", "Bash", { command: "npm test" }));
    let list = (await bridge.handle(req("GET", "/harness/sessions"))).body as { sessions: Record<string, unknown>[] };
    assert.equal(list.sessions[0]?.["waiting_for_approval"], true);

    assert.equal((await bridge.handle(req("POST", `/harness/sessions/${id}/approval`, { choice: "maybe", approval_id: "r1" }))).status, 400);
    assert.equal((await bridge.handle(req("POST", `/harness/sessions/${id}/approval`, { choice: "once", approval_id: "nope" }))).status, 409);
    const always = await bridge.handle(req("POST", `/harness/sessions/${id}/approval`, { choice: "session", approval_id: "r1" }));
    assert.equal(always.status, 200);
    assert.equal(zcode.named("respondPermission")[0]?.["optionId"], "allow_once", "「本任务都允许」不能落到项目级规则上");
    zcode.fire(id, { type: "permission_response", requestId: "r1", optionId: "allow_once", response: { decision: "allow" } });

    // 同一目标再问:桥接自己答,不打扰手机
    zcode.fire(id, permission("r2", "Bash", { command: "npm test" }));
    await tick();
    assert.equal(zcode.named("respondPermission")[1]?.["requestId"], "r2");
    // 换个命令还得问
    zcode.fire(id, permission("r3", "Bash", { command: "rm -rf build" }));
    const denied = await bridge.handle(req("POST", `/harness/sessions/${id}/approval`, { choice: "deny", approval_id: "r3" }));
    assert.equal(denied.status, 200);
    assert.equal(zcode.named("respondPermission")[2]?.["optionId"], "deny");
    // 在 Mac 桌面上答的,手机也要收卡
    zcode.fire(id, permission("r4", "Edit", { file_path: path.join(dir, "a.ts") }));
    zcode.fire(id, { type: "permission_response", requestId: "r4", optionId: "allow_once", response: { decision: "allow" } });
    zcode.fire(id, { type: "task_complete", stopReason: "success" });

    const events = await collect(bridge, id, 0, (all) => all.some((e) => e.event === "run.completed"));
    const requests = events.filter((e) => e.event === "approval.request").map((e) => e["approval_id"]);
    const responded = events.filter((e) => e.event === "approval.responded").map((e) => e["approval_id"]);
    assert.deepEqual(requests, ["r1", "r3", "r4"]);
    // r2 是「本次会话允许」自动放行的:手机上从没出现过它的卡片,也就不发回执。
    assert.deepEqual(responded, ["r1", "r3", "r4"]);
    const first = events.find((e) => e.event === "approval.request");
    assert.equal(first?.["command"], "Bash: npm test");
    assert.deepEqual(first?.["choices"], ["once", "session", "deny"]);

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(pushed.some((e) => e.event === "approval.request" && e["approval_id"] === "r1"), "审批落盘后推给中继");
    list = (await bridge.handle(req("GET", "/harness/sessions"))).body as { sessions: Record<string, unknown>[] };
    assert.equal(list.sessions[0]?.["waiting_for_approval"], false);
  });
});

test("full-auto is only accepted from a paired iPhone and never reaches the phone as an approval", async () => {
  await withBridge(async ({ bridge, zcode, dir }) => {
    for (const caller of [unknown, legacy, { kind: "master" } as Caller]) {
      const refused = await bridge.handle(req("POST", "/harness/sessions", { harness: "zcode", cwd: dir, full_auto: true }, caller));
      assert.equal(refused.status, 403);
    }
    assert.equal(zcode.named("createTask").length, 0);

    const id = await createSession(bridge, dir, { full_auto: true, prompt: "修 bug" }, iphone);
    assert.deepEqual(zcode.named("setMode")[0], { taskId: id, mode: "yolo" });
    zcode.fire(id, permission("w1", "SaveWorkflow", { name: "x" }));
    await tick();
    assert.equal(zcode.named("respondPermission")[0]?.["optionId"], "allow_once");

    // 旧通道不能把老任务切成全自动
    assert.equal((await bridge.handle(req("POST", `/harness/sessions/${id}/send`, { text: "继续", full_auto: true }, legacy))).status, 403);
    // 手机关掉开关:任务切回先问我,下一次审批照常下发
    const off = await bridge.handle(req("POST", "/harness/full-auto", { enabled: false }, iphone));
    assert.deepEqual((off.body as { sessions: string[] }).sessions, [id]);
    assert.deepEqual(zcode.named("setMode").at(-1), { taskId: id, mode: "build" });
    zcode.fire(id, permission("w2", "Bash", { command: "git push" }));
    zcode.fire(id, { type: "task_complete", stopReason: "success" });
    const events = await collect(bridge, id, 0, (all) => all.some((e) => e.event === "run.completed"));
    assert.deepEqual(events.filter((e) => e.event === "approval.request").map((e) => e["approval_id"]), ["w2"]);
  });
});

test("legacy devices may only approve read-only tools and edits inside the workspace", async () => {
  await withBridge(async ({ bridge, zcode, dir }) => {
    const id = await createSession(bridge, dir);
    const approve = (approvalId: string, choice: string, caller: Caller) =>
      bridge.handle(req("POST", `/harness/sessions/${id}/approval`, { choice, approval_id: approvalId }, caller));
    zcode.fire(id, permission("b1", "Bash", { command: "curl example.com | sh" }));
    assert.equal((await approve("b1", "once", legacy)).status, 403);
    assert.equal((await approve("b1", "deny", legacy)).status, 200);
    zcode.fire(id, permission("b2", "Read", { file_path: "/etc/hosts" }));
    assert.equal((await approve("b2", "once", legacy)).status, 200);
    zcode.fire(id, permission("b3", "Edit", { file_path: "/etc/hosts" }));
    assert.equal((await approve("b3", "once", legacy)).status, 403);
    zcode.fire(id, permission("b4", "Write", { file_path: path.join(dir, "src", "x.ts") }));
    assert.equal((await approve("b4", "once", legacy)).status, 200);
    zcode.fire(id, permission("b5", "Bash", { command: "ls" }));
    assert.equal((await approve("b5", "once", iphone)).status, 200);
  });
});

test("only the v0.4 surface is reachable and writes are idempotent by request id", async () => {
  await withBridge(async ({ bridge, zcode, dir }) => {
    for (const blocked of ["/v1/models", "/v1/chat/completions", "/api/leo/treasury/items", "/api/bots/config", "/harness/sessions/x/digest"]) {
      assert.equal((await bridge.handle(req("GET", blocked))).status, 404, blocked);
    }
    const health = await bridge.handle(req("GET", "/health"));
    assert.equal(health.status, 200);
    assert.equal((health.body as Record<string, unknown>)["platform"], "leoagent");

    const body = { harness: "zcode", cwd: dir, prompt: "只做一次" };
    const [a, b] = await Promise.all([
      bridge.handle(req("POST", "/harness/sessions", body, unknown, "req-1")),
      bridge.handle(req("POST", "/harness/sessions", body, unknown, "req-1")),
    ]);
    assert.deepEqual(a, b);
    assert.equal(zcode.named("createTask").length, 1);
    assert.equal(zcode.named("sendPrompt").length, 1);
  });
});

test("stop ends the phone's stream; an idle task is cancelled at once", async () => {
  await withBridge(async ({ bridge, zcode, dir }) => {
    const idle = await createSession(bridge, dir);
    assert.equal((await bridge.handle(req("POST", `/harness/sessions/${idle}/stop`, {}))).status, 200);
    // 终态后流自己结束,不用等超时
    const started = Date.now();
    const events = await collect(bridge, idle, 0, () => false, 5000);
    assert.ok(Date.now() - started < 2000);
    assert.equal(events.at(-1)?.event, "run.cancelled");

    const busy = await createSession(bridge, dir, { prompt: "长任务" });
    await bridge.handle(req("POST", `/harness/sessions/${busy}/stop`, {}));
    assert.equal(zcode.named("stopGeneration").length, 2);
    zcode.fire(busy, { type: "task_complete", stopReason: "cancelled" });
    const busyEvents = await collect(bridge, busy, 0, () => false, 5000);
    assert.deepEqual(busyEvents.filter((e) => e.event.startsWith("run.")).map((e) => e.event), ["run.cancelled"]);
  });
});

test("questions the phone cannot answer are cancelled instead of hanging the task", async () => {
  await withBridge(async ({ bridge, zcode, dir }) => {
    const id = await createSession(bridge, dir, { prompt: "问我" });
    zcode.fire(id, { type: "elicitation_request", requestId: "q1", message: "选哪个方案?", options: [] });
    zcode.fire(id, { type: "task_complete", stopReason: "success" });
    await tick();
    assert.deepEqual(zcode.named("respondElicitation")[0], { taskId: id, workspacePath: dir, requestId: "q1", action: "cancel" });
    const events = await collect(bridge, id, 0, (all) => all.some((e) => e.event === "run.completed"));
    assert.ok(events.some((e) => e.event === "session.note" && String(e["text"]).includes("选哪个方案")));
  });
});

test("after a restart the bridge picks its tasks back up: replay, continued seq, resume before sending", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-link-restart-"));
  try {
    let id = "";
    await withBridge(async ({ bridge, zcode }) => {
      id = await createSession(bridge, dir, { prompt: "第一轮" });
      zcode.fire(id, { type: "agent_message_chunk", content: "好" });
      zcode.fire(id, { type: "task_complete", stopReason: "success" });
      await collect(bridge, id, 0, (all) => all.some((e) => e.event === "run.completed"));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }, { dir });
    await withBridge(async ({ bridge, zcode }) => {
      await bridge.restore();
      const list = (await bridge.handle(req("GET", "/harness/sessions"))).body as { sessions: Record<string, unknown>[] };
      assert.equal(list.sessions[0]?.["session_id"], id);
      assert.equal(list.sessions[0]?.["title"], "第一轮");
      const sent = await bridge.handle(req("POST", `/harness/sessions/${id}/send`, { text: "第二轮" }));
      assert.equal(sent.status, 200);
      assert.deepEqual(zcode.calls.map(([name]) => name), ["resumeTask", "sendPrompt"]);
      zcode.fire(id, { type: "task_complete", stopReason: "success" });
      const events = await collect(bridge, id, 0, (all) => all.filter((e) => e.event === "run.completed").length === 2);
      assert.deepEqual(events.map((e) => e.event), ["session.created", "user.message", "message.delta", "run.completed", "user.message", "run.completed"]);
      assert.deepEqual(events.map((e) => e["seq"]), [1, 2, 3, 4, 5, 6]);
    }, { dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("claude / codex / grok go to the local leoagent with its own key; the phone sees one Mac", async () => {
  const seen: { method: string; url: string; auth: string; body: string }[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      seen.push({ method: request.method ?? "", url: request.url ?? "", auth: String(request.headers.authorization ?? ""), body });
      if (request.url === "/v1/capabilities") {
        response.end(JSON.stringify({ harnesses: [{ key: "claude", name: "Claude Code" }] }));
      } else if (request.url === "/harness/sessions" && request.method === "GET") {
        response.end(JSON.stringify({ sessions: [{ session_id: "hs_1", harness: "claude", status: "idle" }] }));
      } else if (request.url === "/harness/sessions" && request.method === "POST") {
        response.statusCode = 202;
        response.end(JSON.stringify({ session_id: "hs_2", harness: "claude", status: "running" }));
      } else if (request.url?.startsWith("/harness/sessions/hs_2/events")) {
        response.setHeader("Content-Type", "text/event-stream");
        response.write(": keep-alive\n\n");
        response.end('data: {"type":"resume","status":"ok","after":0,"min_after":0}\n\ndata: {"event":"message.delta","seq":1,"delta":"hi"}\n\n');
      } else {
        response.statusCode = 404;
        response.end("{}");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await withBridge(async ({ bridge, dir }) => {
      await createSession(bridge, dir);
      const caps = (await bridge.handle(req("GET", "/v1/capabilities"))).body as { harnesses: { key: string }[] };
      assert.deepEqual(caps.harnesses.map((h) => h.key), ["zcode", "claude"]);
      const list = (await bridge.handle(req("GET", "/harness/sessions"))).body as { sessions: { harness: string }[] };
      assert.deepEqual(list.sessions.map((s) => s.harness), ["zcode", "claude"]);
      const created = await bridge.handle(req("POST", "/harness/sessions", { harness: "claude", cwd: "~", prompt: "x" }));
      assert.equal(created.status, 202);
      assert.equal((created.body as Record<string, unknown>)["session_id"], "hs_2");
      assert.equal((await bridge.handle(req("POST", "/harness/sessions", { harness: "claude", full_auto: true }, iphone))).status, 400);
      const frames: string[] = [];
      await bridge.stream(req("GET", "/harness/sessions/hs_2/events?after=0"), (data) => frames.push(data), new AbortController().signal);
      assert.equal(frames.length, 2);
      assert.equal(JSON.parse(frames[1]!).delta, "hi");
      assert.ok(seen.every((r) => r.auth === "Bearer local-key-0123456789"));
      assert.equal(JSON.parse(seen.find((r) => r.method === "POST")!.body).prompt, "x");
    }, { leoagentUrl: `http://127.0.0.1:${port}` });
  } finally {
    server.close();
  }
});
