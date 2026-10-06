import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { IZCodeTaskService } from "@zcode/services";
import type { LeoDeviceDescriptor } from "@zcode/shared/leo-device";

import { LinkBridge, readSSHHostKeys, type LinkRequest } from "./bridge.js";
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
    desktopTasks: [] as Record<string, unknown>[],
    async listTaskList(params: Record<string, unknown>) {
      calls.push(["listTaskList", params]);
      return { items: this.desktopTasks, total: this.desktopTasks.length, hasMore: false };
    },
    subscriptions: 0,
    onDynamicTaskEvent(params: { taskId: string }) {
      service.subscriptions += 1;
      return (listener: (event: unknown) => void) => {
        listeners.set(params.taskId, listener);
        return { dispose: () => listeners.delete(params.taskId) };
      };
    },
  };
  return {
    service: service as unknown as IZCodeTaskService,
    setDesktopTasks: (items: Record<string, unknown>[]) => {
      service.desktopTasks = items;
    },
    subscriptionCount: () => service.subscriptions,
    captureListener: (taskId: string) => listeners.get(taskId),
    calls,
    named: (name: string) => calls.filter(([n]) => n === name).map(([, p]) => p),
    fire: (taskId: string, event: Record<string, unknown>) =>
      listeners.get(taskId)?.({ taskId, traceId: "trace", ...event }),
  };
}

const unknown: Caller = { kind: "unknown" };
const iphone: Caller = { kind: "iphone", deviceId: "dev-iphone" };
const legacy: Caller = { kind: "legacy", deviceId: "dev-fold" };
const silent = { info() {}, warn() {} };
const permissionOptions = [
  { optionId: "allow_once", kind: "allow_once", name: "Allow", response: { decision: "allow" } },
  {
    optionId: "allow_project",
    kind: "allow_always",
    name: "Always allow in this project",
    response: { decision: "allow" },
  },
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
  run: (ctx: {
    bridge: LinkBridge;
    zcode: ReturnType<typeof fakeZCode>;
    dir: string;
    pushed: HarnessEvent[];
  }) => Promise<void>,
  options: {
    leoagentUrl?: string;
    dir?: string;
    recentWorkspaces?: string[];
    device?: LeoDeviceDescriptor;
    sshHostKeys?: () => Promise<string[]>;
  } = {},
) {
  const dir = options.dir ?? (await mkdtemp(path.join(os.tmpdir(), "leo-link-")));
  const zcode = fakeZCode();
  const pushed: HarnessEvent[] = [];
  const bridge = new LinkBridge({
    device: options.device,
    taskService: zcode.service,
    logger: silent,
    push: (event) => pushed.push(event),
    appVersion: "test",
    journalDir: path.join(dir, "journals"),
    leoagent: {
      // 没人听的端口(9 是 fetch 的禁用端口,连都不会去连,不像真的「没在运行」)。
      url: options.leoagentUrl ?? "http://127.0.0.1:2",
      key: () => "local-key-0123456789",
    },
    ...(options.recentWorkspaces
      ? { recentWorkspaces: async () => options.recentWorkspaces! }
      : {}),
    sshHostKeys: options.sshHostKeys ?? (async () => []),
  });
  try {
    await run({ bridge, zcode, dir, pushed });
  } finally {
    await bridge.close();
    if (!options.dir) await rm(dir, { recursive: true, force: true });
  }
}

function req(
  method: string,
  pathname: string,
  body?: unknown,
  caller: Caller = unknown,
  requestId?: string,
): LinkRequest {
  return { method, path: pathname, body, caller, ...(requestId ? { requestId } : {}) };
}

/** 读事件流直到 until 满足(或超时),返回除续传信封以外的事件。 */
async function collect(
  bridge: LinkBridge,
  sessionId: string,
  after: number,
  until: (events: HarnessEvent[]) => boolean,
  timeoutMs = 2000,
) {
  const controller = new AbortController();
  const events: HarnessEvent[] = [];
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  await bridge.stream(
    req("GET", `/harness/sessions/${sessionId}/events?after=${after}`),
    (data) => {
      const frame = JSON.parse(data) as HarnessEvent;
      if (frame["type"] === "resume") return;
      events.push(frame);
      if (until(events)) controller.abort();
    },
    controller.signal,
  );
  clearTimeout(timer);
  return events;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function createSession(
  bridge: LinkBridge,
  cwd: string,
  extra: Record<string, unknown> = {},
  caller: Caller = unknown,
): Promise<string> {
  const created = await bridge.handle(
    req("POST", "/harness/sessions", { harness: "zcode", cwd, ...extra }, caller),
  );
  assert.equal(created.status, 202, JSON.stringify(created.body));
  return (created.body as { session_id: string }).session_id;
}

test("a phone-created task streams mapped v0.4 events with continuous seq", async () => {
  await withBridge(async ({ bridge, zcode, dir }) => {
    const id = await createSession(bridge, dir, { prompt: "你好" });
    assert.deepEqual(zcode.named("createTask")[0], { workspacePath: dir, v4Create: true, mode: "build" });
    assert.deepEqual(zcode.named("setMode")[0], { taskId: id, mode: "build" });
    assert.equal(zcode.named("sendPrompt")[0]?.["content"], "你好");

    zcode.fire(id, { type: "task_run_started", startedAt: 1 });
    zcode.fire(id, { type: "agent_thought_chunk", content: "想" });
    zcode.fire(id, { type: "agent_thought_chunk", content: "一下" });
    zcode.fire(id, { type: "agent_message_chunk", content: "在的" });
    zcode.fire(id, {
      type: "agent_message_chunk",
      content: "子 agent 的话",
      parentToolUseId: "tool-9",
    });
    zcode.fire(id, {
      type: "tool_call",
      toolId: "x1",
      toolName: "Bash",
      kind: "Bash",
      title: "Bash",
      input: { command: "ls -la" },
      raw: {},
    });
    zcode.fire(id, { type: "tool_call_update", toolId: "x1", status: "completed", raw: {} });
    zcode.fire(id, {
      type: "task_complete",
      stopReason: "success",
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    });

    const events = await collect(bridge, id, 0, (all) =>
      all.some((e) => e.event === "run.completed"),
    );
    assert.deepEqual(
      events.map((e) => e.event),
      [
        "session.created",
        "user.message",
        "reasoning.available",
        "message.delta",
        "tool.started",
        "tool.completed",
        "run.completed",
      ],
    );
    assert.deepEqual(
      events.map((e) => e["seq"]),
      [1, 2, 3, 4, 5, 6, 7],
    );
    assert.equal(events[2]?.["text"], "想一下");
    assert.equal(events[3]?.["delta"], "在的");
    assert.equal(events[4]?.["preview"], "ls -la");
    assert.equal(events[5]?.["tool"], "Bash");
    assert.equal(events[5]?.["error"], false);
    assert.deepEqual(events[6]?.["usage"], { input_tokens: 3, output_tokens: 4, total_tokens: 7 });
    assert.ok(events.every((e) => e["session_id"] === id));

    // 从中间续传:只拿到之后的,不重复
    const resumed = await collect(bridge, id, 5, (all) =>
      all.some((e) => e.event === "run.completed"),
    );
    assert.deepEqual(
      resumed.map((e) => e["seq"]),
      [6, 7],
    );

    const list = (await bridge.handle(req("GET", "/harness/sessions"))).body as {
      sessions: Record<string, unknown>[];
    };
    assert.equal(list.sessions[0]?.["session_id"], id);
    assert.equal(list.sessions[0]?.["status"], "idle");
    assert.equal(list.sessions[0]?.["harness"], "zcode");
  });
});

test("approvals: once, task-scoped always, deny, and answers given on the Mac", async () => {
  await withBridge(async ({ bridge, zcode, dir, pushed }) => {
    const id = await createSession(bridge, dir, { prompt: "跑测试" });
    zcode.fire(id, permission("r1", "Bash", { command: "npm test" }));
    let list = (await bridge.handle(req("GET", "/harness/sessions"))).body as {
      sessions: Record<string, unknown>[];
    };
    assert.equal(list.sessions[0]?.["waiting_for_approval"], true);

    assert.equal(
      (
        await bridge.handle(
          req("POST", `/harness/sessions/${id}/approval`, { choice: "maybe", approval_id: "r1" }),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await bridge.handle(
          req("POST", `/harness/sessions/${id}/approval`, { choice: "once", approval_id: "nope" }),
        )
      ).status,
      409,
    );
    const always = await bridge.handle(
      req("POST", `/harness/sessions/${id}/approval`, { choice: "session", approval_id: "r1" }),
    );
    assert.equal(always.status, 200);
    assert.equal(
      zcode.named("respondPermission")[0]?.["optionId"],
      "allow_once",
      "「本任务都允许」不能落到项目级规则上",
    );
    zcode.fire(id, {
      type: "permission_response",
      requestId: "r1",
      optionId: "allow_once",
      response: { decision: "allow" },
    });

    // 同一目标再问:桥接自己答,不打扰手机
    zcode.fire(id, permission("r2", "Bash", { command: "npm test" }));
    await tick();
    assert.equal(zcode.named("respondPermission")[1]?.["requestId"], "r2");
    // 换个命令还得问
    zcode.fire(id, permission("r3", "Bash", { command: "rm -rf build" }));
    const denied = await bridge.handle(
      req("POST", `/harness/sessions/${id}/approval`, { choice: "deny", approval_id: "r3" }),
    );
    assert.equal(denied.status, 200);
    assert.equal(zcode.named("respondPermission")[2]?.["optionId"], "deny");
    // 在 Mac 桌面上答的,手机也要收卡
    zcode.fire(id, permission("r4", "Edit", { file_path: path.join(dir, "a.ts") }));
    zcode.fire(id, {
      type: "permission_response",
      requestId: "r4",
      optionId: "allow_once",
      response: { decision: "allow" },
    });
    zcode.fire(id, { type: "task_complete", stopReason: "success" });

    const events = await collect(bridge, id, 0, (all) =>
      all.some((e) => e.event === "run.completed"),
    );
    const requests = events
      .filter((e) => e.event === "approval.request")
      .map((e) => e["approval_id"]);
    const responded = events
      .filter((e) => e.event === "approval.responded")
      .map((e) => e["approval_id"]);
    assert.deepEqual(requests, ["r1", "r3", "r4"]);
    // r2 是「本次会话允许」自动放行的:手机上从没出现过它的卡片,也就不发回执。
    assert.deepEqual(responded, ["r1", "r3", "r4"]);
    const first = events.find((e) => e.event === "approval.request");
    assert.equal(first?.["command"], "Bash: npm test");
    assert.deepEqual(first?.["choices"], ["once", "session", "deny"]);

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(
      pushed.some((e) => e.event === "approval.request" && e["approval_id"] === "r1"),
      "审批落盘后推给中继",
    );
    list = (await bridge.handle(req("GET", "/harness/sessions"))).body as {
      sessions: Record<string, unknown>[];
    };
    assert.equal(list.sessions[0]?.["waiting_for_approval"], false);
  });
});

test("full-auto is accepted from any identified device and never reaches the phone as an approval", async () => {
  await withBridge(async ({ bridge, zcode, dir }) => {
    const refused = await bridge.handle(
      req("POST", "/harness/sessions", { harness: "zcode", cwd: dir, full_auto: true }, unknown),
    );
    assert.equal(refused.status, 403);
    assert.equal(zcode.named("createTask").length, 0);
    // 用中继钥匙连上的安卓、鸿蒙(legacy)和主钥匙,和 iPhone 一样能开全自动
    await createSession(bridge, dir, { full_auto: true }, legacy);
    const masterId = await createSession(bridge, dir, { full_auto: true }, {
      kind: "master",
    } as Caller);
    assert.equal(zcode.named("createTask").length, 2);

    const id = await createSession(bridge, dir, { full_auto: true, prompt: "修 bug" }, iphone);
    assert.deepEqual(zcode.named("setMode").at(-1), { taskId: id, mode: "yolo" });
    zcode.fire(id, permission("w1", "SaveWorkflow", { name: "x" }));
    await tick();
    assert.equal(zcode.named("respondPermission")[0]?.["optionId"], "allow_once");

    // 认不出身份的请求不能把老任务切成全自动
    assert.equal(
      (
        await bridge.handle(
          req("POST", `/harness/sessions/${id}/send`, { text: "继续", full_auto: true }, unknown),
        )
      ).status,
      403,
    );
    // 手机关掉开关:任务切回先问我,下一次审批照常下发
    const off = await bridge.handle(req("POST", "/harness/full-auto", { enabled: false }, iphone));
    // 别的设备(dev-fold)开的不动;主钥匙开的认不出是哪台,一起切回
    assert.deepEqual((off.body as { sessions: string[] }).sessions, [masterId, id]);
    assert.deepEqual(zcode.named("setMode").at(-1), { taskId: id, mode: "build" });
    zcode.fire(id, permission("w2", "Bash", { command: "git push" }));
    zcode.fire(id, { type: "task_complete", stopReason: "success" });
    const events = await collect(bridge, id, 0, (all) =>
      all.some((e) => e.event === "run.completed"),
    );
    assert.deepEqual(
      events.filter((e) => e.event === "approval.request").map((e) => e["approval_id"]),
      ["w2"],
    );
  });
});

test("legacy devices and the master key approve like a paired iPhone", async () => {
  await withBridge(async ({ bridge, zcode, dir }) => {
    const id = await createSession(bridge, dir);
    const approve = (approvalId: string, choice: string, caller: Caller) =>
      bridge.handle(
        req(
          "POST",
          `/harness/sessions/${id}/approval`,
          { choice, approval_id: approvalId },
          caller,
        ),
      );
    zcode.fire(id, permission("b1", "Bash", { command: "git push" }));
    assert.equal((await approve("b1", "once", legacy)).status, 200);
    zcode.fire(id, permission("b2", "Edit", { file_path: "/etc/hosts" }));
    assert.equal((await approve("b2", "session", { kind: "master" } as Caller)).status, 200);
    zcode.fire(id, permission("b3", "Bash", { command: "ls" }));
    assert.equal((await approve("b3", "once", iphone)).status, 200);
  });
});

test("only the v0.4 surface is reachable and writes are idempotent by request id", async () => {
  await withBridge(async ({ bridge, zcode, dir }) => {
    for (const blocked of [
      "/v1/models",
      "/v1/chat/completions",
      "/api/leo/treasury/items",
      "/api/bots/config",
      "/harness/sessions/x/digest",
    ]) {
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
    assert.equal(
      (await bridge.handle(req("POST", `/harness/sessions/${idle}/stop`, {}))).status,
      200,
    );
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
    assert.deepEqual(
      busyEvents.filter((e) => e.event.startsWith("run.")).map((e) => e.event),
      ["run.cancelled"],
    );
  });
});

test("questions the phone cannot answer are cancelled instead of hanging the task", async () => {
  await withBridge(async ({ bridge, zcode, dir }) => {
    const id = await createSession(bridge, dir, { prompt: "问我" });
    zcode.fire(id, {
      type: "elicitation_request",
      requestId: "q1",
      message: "选哪个方案?",
      options: [],
    });
    zcode.fire(id, { type: "task_complete", stopReason: "success" });
    await tick();
    assert.deepEqual(zcode.named("respondElicitation")[0], {
      taskId: id,
      workspacePath: dir,
      requestId: "q1",
      action: "cancel",
    });
    const events = await collect(bridge, id, 0, (all) =>
      all.some((e) => e.event === "run.completed"),
    );
    assert.ok(
      events.some((e) => e.event === "session.note" && String(e["text"]).includes("选哪个方案")),
    );
  });
});

test("after a restart the bridge picks its tasks back up: replay, continued seq, resume before sending", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-link-restart-"));
  try {
    let id = "";
    await withBridge(
      async ({ bridge, zcode }) => {
        id = await createSession(bridge, dir, { prompt: "第一轮" });
        zcode.fire(id, { type: "agent_message_chunk", content: "好" });
        zcode.fire(id, { type: "task_complete", stopReason: "success" });
        await collect(bridge, id, 0, (all) => all.some((e) => e.event === "run.completed"));
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
      { dir },
    );
    await withBridge(
      async ({ bridge, zcode }) => {
        await bridge.restore();
        const list = (await bridge.handle(req("GET", "/harness/sessions"))).body as {
          sessions: Record<string, unknown>[];
        };
        assert.equal(list.sessions[0]?.["session_id"], id);
        assert.equal(list.sessions[0]?.["title"], "第一轮");
        const sent = await bridge.handle(
          req("POST", `/harness/sessions/${id}/send`, { text: "第二轮" }),
        );
        assert.equal(sent.status, 200);
        assert.deepEqual(
          zcode.calls.map(([name]) => name),
          ["resumeTask", "sendPrompt"],
        );
        zcode.fire(id, { type: "task_complete", stopReason: "success" });
        const events = await collect(
          bridge,
          id,
          0,
          (all) => all.filter((e) => e.event === "run.completed").length === 2,
        );
        assert.deepEqual(
          events.map((e) => e.event),
          [
            "session.created",
            "user.message",
            "message.delta",
            "run.completed",
            "user.message",
            "run.completed",
          ],
        );
        assert.deepEqual(
          events.map((e) => e["seq"]),
          [1, 2, 3, 4, 5, 6],
        );
      },
      { dir },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("claude / codex / grok go to the local leoagent with its own key; the phone sees one Mac", async () => {
  const seen: { method: string; url: string; auth: string; caller: string; body: string }[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      seen.push({
        method: request.method ?? "",
        url: request.url ?? "",
        auth: String(request.headers.authorization ?? ""),
        caller: String(request.headers["x-leo-caller-kind"] ?? ""),
        body,
      });
      if (request.url === "/v1/capabilities") {
        response.end(JSON.stringify({ harnesses: [{ key: "claude", name: "Claude Code" }] }));
      } else if (request.url === "/harness/sessions" && request.method === "GET") {
        response.end(
          JSON.stringify({ sessions: [{ session_id: "hs_1", harness: "claude", status: "idle" }] }),
        );
      } else if (request.url === "/harness/sessions" && request.method === "POST") {
        response.statusCode = 202;
        response.end(JSON.stringify({ session_id: "hs_2", harness: "claude", status: "running" }));
      } else if (request.url?.startsWith("/harness/sessions/hs_2/events")) {
        response.setHeader("Content-Type", "text/event-stream");
        response.write(": keep-alive\n\n");
        response.end(
          'data: {"type":"resume","status":"ok","after":0,"min_after":0}\n\ndata: {"event":"message.delta","seq":1,"delta":"hi"}\n\n',
        );
      } else {
        response.statusCode = 404;
        response.end("{}");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await withBridge(
      async ({ bridge, dir }) => {
        await createSession(bridge, dir);
        const caps = (await bridge.handle(req("GET", "/v1/capabilities"))).body as {
          harnesses: { key: string }[];
        };
        assert.deepEqual(
          caps.harnesses.map((h) => h.key),
          ["zcode", "claude"],
        );
        const list = (await bridge.handle(req("GET", "/harness/sessions"))).body as {
          sessions: { harness: string }[];
        };
        assert.deepEqual(
          list.sessions.map((s) => s.harness),
          ["zcode", "claude"],
        );
        const created = await bridge.handle(
          req("POST", "/harness/sessions", { harness: "claude", cwd: "~", prompt: "x" }),
        );
        assert.equal(created.status, 202);
        assert.equal((created.body as Record<string, unknown>)["session_id"], "hs_2");
        // 全自动对 claude / codex / grok 也生效:认得出的设备转给 leoagent 并带上调用方类别
        assert.equal(
          (
            await bridge.handle(
              req("POST", "/harness/sessions", { harness: "claude", full_auto: true }, iphone),
            )
          ).status,
          202,
        );
        const forwarded = seen.filter((r) => r.method === "POST" && r.url === "/harness/sessions").at(-1)!;
        assert.equal(JSON.parse(forwarded.body).full_auto, true);
        assert.equal(forwarded.caller, "iphone");
        // 认不出的调用方:就地 403,带机器可读的修复步骤,不转发
        const before = seen.length;
        const refused = await bridge.handle(
          req("POST", "/harness/sessions", { harness: "claude", full_auto: true }, unknown),
        );
        assert.equal(refused.status, 403);
        const refusal = (refused.body as { error: Record<string, unknown> }).error;
        assert.equal(refusal["code"], "device_not_recognized");
        assert.equal(refusal["fix"], "mac_steps");
        assert.ok(Array.isArray(refusal["steps"]) && (refusal["steps"] as unknown[]).length > 0);
        assert.ok(String(refusal["message"]).length > 0);
        assert.equal(seen.length, before);
        const frames: string[] = [];
        await bridge.stream(
          req("GET", "/harness/sessions/hs_2/events?after=0"),
          (data) => frames.push(data),
          new AbortController().signal,
        );
        assert.equal(frames.length, 2);
        assert.equal(JSON.parse(frames[1]!).delta, "hi");
        assert.ok(seen.every((r) => r.auth === "Bearer local-key-0123456789"));
        assert.equal(JSON.parse(seen.find((r) => r.method === "POST")!.body).prompt, "x");
      },
      { leoagentUrl: `http://127.0.0.1:${port}` },
    );
  } finally {
    server.close();
  }
});

test("tasks opened on the Mac desktop show up on the phone and are adopted on first use", async () => {
  const workspace = "/Users/me/project";
  await withBridge(
    async ({ bridge, zcode }) => {
      zcode.setDesktopTasks([
        {
          taskId: "desk-1",
          workspacePath: workspace,
          title: "重构登录",
          status: "completed",
          mode: "build",
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      ]);
      const list = (await bridge.handle(req("GET", "/harness/sessions"))).body as {
        sessions: Record<string, unknown>[];
      };
      const row = list.sessions.find((s) => s["session_id"] === "desk-1");
      assert.equal(row?.["source"], "desktop");
      assert.equal(row?.["status"], "available", "空闲的桌面任务不能冒充手机首页的「进行中」");
      assert.equal(row?.["title"], "重构登录");
      assert.deepEqual(zcode.named("listTaskList")[0]?.["workspaceScopes"], [
        { workspacePath: workspace },
      ]);

      const sent = await bridge.handle(
        req("POST", "/harness/sessions/desk-1/send", { text: "接着做" }),
      );
      assert.equal(sent.status, 200);
      assert.deepEqual(
        zcode.calls.filter(([n]) => n !== "listTaskList").map(([n]) => n),
        ["resumeTask", "sendPrompt"],
      );
      zcode.fire("desk-1", { type: "agent_message_chunk", content: "好" });
      zcode.fire("desk-1", { type: "task_complete", stopReason: "success" });
      const events = await collect(bridge, "desk-1", 0, (all) =>
        all.some((e) => e.event === "run.completed"),
      );
      assert.deepEqual(
        events.map((e) => e.event),
        ["session.note", "user.message", "message.delta", "run.completed"],
      );

      // 接过来之后,列表里只出现一次(作为手机侧会话)
      const again = (await bridge.handle(req("GET", "/harness/sessions"))).body as {
        sessions: Record<string, unknown>[];
      };
      assert.equal(again.sessions.filter((s) => s["session_id"] === "desk-1").length, 1);
      // 没列过的 id 不会被当成桌面任务:转给 leoagent,它没在运行就是 503(手机对 502/503/504 一视同仁)
      assert.equal(
        (await bridge.handle(req("POST", "/harness/sessions/nope/send", { text: "x" }))).status,
        503,
      );
    },
    { recentWorkspaces: [workspace] },
  );
});

test("full-auto tasks refuse unidentified callers, wherever the yolo mode came from", async () => {
  const workspace = "/Users/me/project";
  await withBridge(
    async ({ bridge, zcode }) => {
      zcode.setDesktopTasks([
        {
          taskId: "desk-yolo",
          workspacePath: workspace,
          title: "完全访问的任务",
          status: "completed",
          mode: "yolo",
          createdAt: 1,
          updatedAt: 2,
        },
      ]);
      await bridge.handle(req("GET", "/harness/sessions"));
      const refused = await bridge.handle(
        req("POST", "/harness/sessions/desk-yolo/send", { text: "rm -rf" }, unknown),
      );
      assert.equal(refused.status, 403);
      assert.equal(zcode.named("sendPrompt").length, 0);
      // 用中继钥匙连上的设备照样能发
      assert.equal(
        (
          await bridge.handle(
            req("POST", "/harness/sessions/desk-yolo/send", { text: "继续" }, legacy),
          )
        ).status,
        200,
      );
      // 关掉全自动再发:切回先问我
      const downgraded = await bridge.handle(
        req("POST", "/harness/sessions/desk-yolo/send", { text: "再来", full_auto: false }, legacy),
      );
      assert.equal(downgraded.status, 200);
      assert.deepEqual(zcode.named("setMode").at(-1), { taskId: "desk-yolo", mode: "build" });
      assert.equal(
        (
          await bridge.handle(
            req(
              "POST",
              "/harness/sessions/desk-yolo/send",
              { text: "又来", full_auto: true },
              iphone,
            ),
          )
        ).status,
        200,
      );
    },
    { recentWorkspaces: [workspace] },
  );
});

test("two simultaneous requests adopt a desktop task once", async () => {
  const workspace = "/Users/me/project";
  await withBridge(
    async ({ bridge, zcode }) => {
      zcode.setDesktopTasks([
        {
          taskId: "desk-2",
          workspacePath: workspace,
          title: "并发",
          status: "completed",
          mode: "build",
          createdAt: 1,
          updatedAt: 2,
        },
      ]);
      await bridge.handle(req("GET", "/harness/sessions"));
      const controller = new AbortController();
      const streaming = bridge.stream(
        req("GET", "/harness/sessions/desk-2/events?after=0"),
        () => {},
        controller.signal,
      );
      const sent = await bridge.handle(
        req("POST", "/harness/sessions/desk-2/send", { text: "hi" }),
      );
      assert.equal(sent.status, 200);
      controller.abort();
      await streaming;
      assert.equal(zcode.subscriptionCount(), 1);
    },
    { recentWorkspaces: [workspace] },
  );
});

test("callers without an identity are restricted only once the relay can identify callers (0.2)", async () => {
  await withBridge(async ({ bridge, zcode, dir }) => {
    const id = await createSession(bridge, dir);
    zcode.fire(id, permission("s1", "Bash", { command: "ls" }));
    bridge.strictCallers = true;
    assert.equal(
      (
        await bridge.handle(
          req(
            "POST",
            `/harness/sessions/${id}/approval`,
            { choice: "once", approval_id: "s1" },
            unknown,
          ),
        )
      ).status,
      403,
    );
    bridge.strictCallers = false;
    assert.equal(
      (
        await bridge.handle(
          req(
            "POST",
            `/harness/sessions/${id}/approval`,
            { choice: "once", approval_id: "s1" },
            unknown,
          ),
        )
      ).status,
      200,
    );
  });
});

test("encoded path tricks in the session id are rejected", async () => {
  await withBridge(async ({ bridge }) => {
    for (const bad of ["..%2F..%2Fv1%2Fmodels", "a%2Fb", "%2E%2E"]) {
      const res = await bridge.handle(req("POST", `/harness/sessions/${bad}/send`, { text: "x" }));
      // 400 = 会话 id 被拒;404 = URL 规范化后已不是手机接口。两者都没被转发(转发会是 502)。
      assert.ok(res.status === 400 || res.status === 404, `${bad} → ${res.status}`);
    }
  });
});

test("full_auto:false on every phone message leaves plan/edit tasks alone and only downgrades yolo", async () => {
  const workspace = "/Users/me/project";
  await withBridge(
    async ({ bridge, zcode }) => {
      zcode.setDesktopTasks([
        {
          taskId: "desk-plan",
          workspacePath: workspace,
          title: "计划",
          status: "completed",
          mode: "plan",
          createdAt: 1,
          updatedAt: 2,
        },
      ]);
      await bridge.handle(req("GET", "/harness/sessions"));
      assert.equal(
        (
          await bridge.handle(
            req(
              "POST",
              "/harness/sessions/desk-plan/send",
              { text: "看看", full_auto: false },
              iphone,
            ),
          )
        ).status,
        200,
      );
      assert.equal(zcode.named("setMode").length, 0, "plan 任务不该被改成 build");
    },
    { recentWorkspaces: [workspace] },
  );
});

test("a turn that ends with an approval still pending closes the card; a late answer gets 409", async () => {
  await withBridge(async ({ bridge, zcode, dir }) => {
    const id = await createSession(bridge, dir, { prompt: "跑命令" });
    zcode.fire(id, permission("p1", "Bash", { command: "rm -rf build" }));
    zcode.fire(id, { type: "task_complete", stopReason: "cancelled" });
    const events = await collect(bridge, id, 0, (all) =>
      all.some((e) => e.event === "run.cancelled"),
    );
    assert.deepEqual(
      events
        .filter((e) => e.event.startsWith("approval.") || e.event.startsWith("run."))
        .map((e) => [e.event, e["choice"] ?? null]),
      [
        ["approval.request", null],
        ["approval.responded", "deny"],
        ["run.cancelled", null],
      ],
    );
    assert.equal(
      (
        await bridge.handle(
          req("POST", `/harness/sessions/${id}/approval`, { choice: "once", approval_id: "p1" }),
        )
      ).status,
      409,
    );
  });
});

test("a send the Mac can't take ends the turn instead of leaving it running", async () => {
  await withBridge(async ({ bridge, zcode, dir }) => {
    const id = await createSession(bridge, dir);
    (zcode.service as unknown as { sendPrompt: () => Promise<never> }).sendPrompt = async () => {
      throw new Error("agent runtime not ready");
    };
    assert.equal(
      (await bridge.handle(req("POST", `/harness/sessions/${id}/send`, { text: "在吗" }))).status,
      409,
    );
    const events = await collect(bridge, id, 0, (all) => all.some((e) => e.event === "run.failed"));
    assert.match(String(events.at(-1)?.["error"]), /agent runtime not ready/);
    const list = (await bridge.handle(req("GET", "/harness/sessions"))).body as {
      sessions: Record<string, unknown>[];
    };
    assert.equal(list.sessions.find((s) => s["session_id"] === id)?.["status"], "idle");
  });
});

test("turns started on the Mac keep their questions and don't push the phone", async () => {
  await withBridge(async ({ bridge, zcode, dir, pushed }) => {
    const id = await createSession(bridge, dir, { prompt: "手机发的" });
    zcode.fire(id, { type: "task_complete", stopReason: "success" });
    await collect(bridge, id, 0, (all) => all.some((e) => e.event === "run.completed"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      pushed.filter((e) => e.event === "run.completed").length,
      1,
      "手机发起的一轮照常推",
    );

    // 之后在 Mac 桌面上接着聊:提问留给 Mac,审批与完成不推手机
    zcode.fire(id, { type: "task_run_started" });
    zcode.fire(id, {
      type: "elicitation_request",
      requestId: "q1",
      message: "选哪个方案?",
      options: [],
    });
    zcode.fire(id, permission("m1", "Bash", { command: "make" }));
    zcode.fire(id, {
      type: "permission_response",
      requestId: "m1",
      optionId: "allow_once",
      response: { decision: "allow" },
    });
    zcode.fire(id, { type: "task_complete", stopReason: "success" });
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(zcode.named("respondElicitation").length, 0);
    assert.equal(pushed.filter((e) => e.event === "run.completed").length, 1);
    assert.ok(!pushed.some((e) => e["approval_id"] === "m1"));
  });
});

test("the completion push carries the phone's own session id when the phone gave one", async () => {
  await withBridge(async ({ bridge, zcode, dir, pushed }) => {
    const id = await createSession(bridge, dir, { prompt: "做完叫我", phone_session_id: "phone-chat-1" });
    zcode.fire(id, { type: "task_complete", stopReason: "success" });
    await collect(bridge, id, 0, (all) => all.some((e) => e.event === "run.completed"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const done = pushed.find((e) => e.event === "run.completed");
    assert.equal(done?.["phone_session_id"], "phone-chat-1");
    // 没带的老手机:推送里没有这个字段
    const legacyId = await createSession(bridge, dir, { prompt: "老手机" });
    zcode.fire(legacyId, { type: "task_complete", stopReason: "success" });
    await collect(bridge, legacyId, 0, (all) => all.some((e) => e.event === "run.completed"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const legacyDone = pushed.find((e) => e.event === "run.completed" && e["session_id"] === legacyId);
    assert.ok(legacyDone && !("phone_session_id" in legacyDone));
  });
});

test("stop racing a normal finish leaves the turn completed", async () => {
  await withBridge(async ({ bridge, zcode, dir }) => {
    const id = await createSession(bridge, dir, { prompt: "快完了" });
    await bridge.handle(req("POST", `/harness/sessions/${id}/stop`, {}));
    zcode.fire(id, { type: "task_complete", stopReason: "success" });
    await new Promise((resolve) => setTimeout(resolve, 5_300));
    const events = await collect(bridge, id, 0, () => false, 1000);
    assert.deepEqual(
      events.filter((e) => e.event.startsWith("run.")).map((e) => e.event),
      ["run.completed"],
    );
  });
});

test("finished tasks keep their real last activity across restarts, leave 进行中 after 30 minutes, and can be archived", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-link-stale-"));
  const realNow = Date.now;
  const listed = async (bridge: LinkBridge, id: string) =>
    (
      (await bridge.handle(req("GET", "/harness/sessions"))).body as {
        sessions: Record<string, unknown>[];
      }
    ).sessions.find((row) => row["session_id"] === id);
  try {
    let id = "";
    let finishedAt = 0;
    await withBridge(
      async ({ bridge, zcode }) => {
        id = await createSession(bridge, dir, { prompt: "跑一轮" });
        zcode.fire(id, { type: "task_complete", stopReason: "success" });
        const events = await collect(bridge, id, 0, (all) =>
          all.some((e) => e.event === "run.completed"),
        );
        finishedAt = Number(events.at(-1)?.["timestamp"]);
        assert.equal((await listed(bridge, id))?.["status"], "idle");
        // 在跑的不让清理:先停止。
        const busy = await createSession(bridge, dir, { prompt: "还在跑" });
        assert.equal(
          (await bridge.handle(req("POST", `/harness/sessions/${busy}/archive`, {}))).status,
          409,
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
      { dir },
    );

    // 31 分钟后 Mac 重启:认回来的任务保留真实的最后活动时间,不再报成 idle(手机上的「进行中」)。
    Date.now = () => realNow() + 31 * 60_000;
    await withBridge(
      async ({ bridge }) => {
        await bridge.restore();
        const row = await listed(bridge, id);
        assert.equal(row?.["updated_at"], finishedAt);
        assert.equal(row?.["status"], "available");
        const archived = await bridge.handle(req("POST", `/harness/sessions/${id}/archive`, {}));
        assert.equal(archived.status, 200);
        assert.equal((archived.body as Record<string, unknown>)["archived"], true);
        assert.equal(await listed(bridge, id), undefined);
      },
      { dir },
    );

    // 清理过的,再重启也不回来。
    await withBridge(
      async ({ bridge }) => {
        await bridge.restore();
        assert.equal(await listed(bridge, id), undefined);
      },
      { dir },
    );
  } finally {
    Date.now = realNow;
    await rm(dir, { recursive: true, force: true });
  }
});

test("capabilities publish the stable paired identity without replacing existing harness features", async () => {
  const device: LeoDeviceDescriptor = {
    schemaVersion: 1,
    deviceId: "9c0f2c99-17cf-47a1-a370-d97161f68f9a",
    name: "My Mac",
    platform: "macos",
    capabilities: ["harness"],
    endpoints: [],
  };
  await withBridge(
    async ({ bridge }) => {
      const response = await bridge.handle(req("GET", "/v1/capabilities"));
      assert.equal(response.status, 200);
      const body = response.body as {
        device: LeoDeviceDescriptor;
        features: { harness_sessions: boolean };
        ssh_host_keys: string[];
      };
      assert.deepEqual(body.device, device);
      assert.equal(body.features.harness_sessions, true);
      assert.deepEqual(body.ssh_host_keys, ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyForTest"]);
    },
    { device, sshHostKeys: async () => ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyForTest"] },
  );
});

test("readSSHHostKeys returns only well-formed public key lines", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-sshd-"));
  try {
    await writeFile(path.join(dir, "ssh_host_ed25519_key.pub"), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyForTest root@mac\n");
    await writeFile(path.join(dir, "ssh_host_rsa_key.pub"), "garbage line\n");
    await writeFile(path.join(dir, "ssh_host_ed25519_key"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    assert.deepEqual(await readSSHHostKeys(dir), ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyForTest"]);
    assert.deepEqual(await readSSHHostKeys(path.join(dir, "missing")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("completed mutation response replays after restart without creating or sending again", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-replay-restart-"));
  const request = req("POST", "/harness/sessions", { prompt: "once" }, iphone, "stable-create");
  let result: unknown;
  try {
    await withBridge(
      async ({ bridge, zcode }) => {
        result = await bridge.handle(request);
        assert.equal(zcode.named("createTask").length, 1);
        assert.equal(zcode.named("sendPrompt").length, 1);
        assert.match(String(zcode.named("createTask")[0]?.operationId), /^leo-.*-create$/);
        assert.match(String(zcode.named("sendPrompt")[0]?.traceId), /^leo-.*-send$/);
      },
      { dir },
    );
    await withBridge(
      async ({ bridge, zcode }) => {
        await bridge.restore();
        assert.deepEqual(await bridge.handle({ ...request, transport: "direct" }), result);
        assert.equal(zcode.named("createTask").length, 0);
        assert.equal(zcode.named("sendPrompt").length, 0);
      },
      { dir },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("crash after persisted runtime send admission recovers task id via command query, never sends twice", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-recover-send-"));
  const request = req("POST", "/harness/sessions", { prompt: "once" }, iphone, "crash-create");
  try {
    await withBridge(
      async ({ bridge }) => {
        assert.equal((await bridge.handle(request)).status, 202);
      },
      { dir },
    );
    const receipts = path.join(dir, "journals", "operations");
    const file = path.join(receipts, (await readdir(receipts))[0]!);
    const receipt = JSON.parse(await readFile(file, "utf8"));
    const taskId = receipt.response.body.session_id;
    // Model process death between runtime ACK and durable HTTP response.
    receipt.state = "admitted";
    delete receipt.response;
    receipt.checkpoint = { stage: "sending", cwd: os.homedir(), taskId };
    await writeFile(file, JSON.stringify(receipt));
    await withBridge(
      async ({ bridge, zcode }) => {
        await bridge.restore();
        zcode.service.queryOperation = async ({ operationId }) => ({
          commandId: operationId,
          status: "accepted",
          revisionAtDecision: 0,
        });
        const recovered = await bridge.handle(request);
        assert.equal(recovered.status, 202);
        assert.equal((recovered.body as { session_id: string }).session_id, taskId);
        assert.equal(zcode.named("createTask").length, 0);
        assert.equal(zcode.named("sendPrompt").length, 0);
      },
      { dir },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pre-task-id failure keeps admission recoverable and retries the same runtime create id", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-before-create-"));
  const request = req("POST", "/harness/sessions", { prompt: "once" }, iphone, "before-create");
  let operationId: string | undefined;
  try {
    await withBridge(async ({ bridge, zcode }) => {
      zcode.service.createTask = async (params) => { operationId = params.operationId; throw new Error("CLI unavailable before draft creation"); };
      assert.equal((await bridge.handle(request)).status, 409);
    }, { dir });
    await withBridge(async ({ bridge, zcode }) => {
      await bridge.restore();
      assert.equal((await bridge.handle(request)).status, 202);
      assert.equal(zcode.named("createTask").length, 1);
      assert.equal(zcode.named("createTask")[0]?.operationId, operationId);
      assert.equal(zcode.named("sendPrompt").length, 1);
    }, { dir });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("ready checkpoint resumes or replaces only an unsubmitted draft before first input", async () => {
  const { OperationReceipts } = await import("./operationReceipts.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-before-send-"));
  const request = req("POST", "/harness/sessions", { prompt: "once" }, iphone, "before-send");
  try {
    const receipts = new OperationReceipts(path.join(dir, "journals", "operations"));
    await receipts.run(request, async () => { await receipts.checkpoint(request, { stage: "ready", cwd: dir, taskId: "lost-draft" }); throw new Error("CLI restarted before send"); });
    await withBridge(async ({ bridge, zcode }) => {
      await bridge.restore();
      const result = await bridge.handle(request);
      assert.equal(result.status, 202);
      assert.equal(zcode.named("createTask")[0]?.draftSessionId, "lost-draft");
      assert.equal(zcode.named("sendPrompt").length, 1);
      assert.equal((result.body as { session_id: string }).session_id, "task-1");
    }, { dir });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("close drains an already queued mode index write before releasing sessions", async () => {
  await withBridge(async ({ bridge, zcode, dir }) => {
    const id = await createSession(bridge, dir, {}, iphone);
    const writer = bridge as unknown as { saving: Promise<void>; writeIndex(): Promise<void>; sessions: Map<string, { close(): Promise<void> }> };
    await writer.saving;
    const realWrite = writer.writeIndex.bind(bridge);
    const retiredDelivery = zcode.captureListener(id)!;
    let writes = 0;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    // Only delay the existing production writer. The actual index encoding and IO run unchanged.
    writer.writeIndex = async () => { writes += 1; started(); await gate; await realWrite(); };
    zcode.fire(id, { type: "mode_update", currentModeId: "yolo" });
    await entered;
    let sessionDrained!: () => void;
    const drained = new Promise<void>(resolve => { sessionDrained = resolve; });
    const session = writer.sessions.get(id)!;
    const realSessionClose = session.close.bind(session);
    session.close = async () => { await realSessionClose(); sessionDrained(); };
    let settled = false;
    const closing = bridge.close().then(() => { settled = true; });
    await drained;
    // A callback captured before unsubscribe can arrive after disposal on a transport queue.
    retiredDelivery({ type: "mode_update", currentModeId: "build" });
    await new Promise<void>(resolve => setImmediate(resolve));
    const returnedBeforeWrite = settled;
    release();
    await closing;
    await writer.saving;
    assert.equal(returnedBeforeWrite, false, "close must await the accepted index write");
    assert.equal(writes, 1, "Retired stream callbacks must not enqueue another index write during drain");
    const saved = JSON.parse(await readFile(path.join(dir, "journals", "sessions.json"), "utf8"));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].task_id, id);
    assert.equal(saved[0].mode, "yolo");
    await bridge.close();
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, "journals", "sessions.json"), "utf8")), saved);
  });
});

test("full-auto off reports failure when the local leoagent errors, but not when it is simply not running", async () => {
  const server: Server = createServer((_request, response) => {
    response.statusCode = 500;
    response.end(JSON.stringify({ error: { message: "boom" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    await withBridge(
      async ({ bridge }) => {
        const off = await bridge.handle(req("POST", "/harness/full-auto", { enabled: false }, iphone));
        // 以前一律回 ok:手机以为都关了,leoagent 那边的任务还在免审批地跑。
        assert.equal(off.status, 502);
      },
      { leoagentUrl: `http://127.0.0.1:${port}` },
    );
  } finally {
    server.close();
  }
  await withBridge(async ({ bridge }) => {
    // 默认指向没人听的端口:leoagent 没在运行,没有要切的任务。
    const off = await bridge.handle(req("POST", "/harness/full-auto", { enabled: false }, iphone));
    assert.equal(off.status, 200);
  });
});
