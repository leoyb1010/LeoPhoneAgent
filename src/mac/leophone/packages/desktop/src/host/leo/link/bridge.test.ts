import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { IZCodeTaskService } from "@zcode/services";
import { acpModelSelection } from "@zcode/shared/acp";
import type { LeoDeviceDescriptor } from "@zcode/shared/leo-device";

import { LinkBridge, readSSHHostKeys, type LinkBridgeDeps, type LinkRequest } from "./bridge.js";
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
    legacyHarness?: boolean;
    acpAgents?: LinkBridgeDeps["acpAgents"];
    acpAgentVersion?: LinkBridgeDeps["acpAgentVersion"];
    zcodeModelSelection?: LinkBridgeDeps["zcodeModelSelection"];
    agentLogin?: LinkBridgeDeps["agentLogin"];
    automations?: LinkBridgeDeps["automations"];
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
    legacyHarness: () => options.legacyHarness ?? false,
    ...(options.acpAgents ? { acpAgents: options.acpAgents } : {}),
    ...(options.acpAgentVersion ? { acpAgentVersion: options.acpAgentVersion } : {}),
    ...(options.zcodeModelSelection ? { zcodeModelSelection: options.zcodeModelSelection } : {}),
    ...(options.agentLogin ? { agentLogin: options.agentLogin } : {}),
    ...(options.automations ? { automations: options.automations } : {}),
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
        // [WP-41] 开跑也是一条事件(推给中继拉起灵动岛)。
        "run.started",
        "reasoning.available",
        "message.delta",
        "tool.started",
        "tool.completed",
        "run.completed",
      ],
    );
    assert.deepEqual(
      events.map((e) => e["seq"]),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.equal(events[3]?.["text"], "想一下");
    assert.equal(events[4]?.["delta"], "在的");
    assert.equal(events[5]?.["preview"], "ls -la");
    assert.equal(events[6]?.["tool"], "Bash");
    assert.equal(events[6]?.["error"], false);
    assert.deepEqual(events[7]?.["usage"], { input_tokens: 3, output_tokens: 4, total_tokens: 7 });
    assert.ok(events.every((e) => e["session_id"] === id));

    // 从中间续传:只拿到之后的,不重复
    const resumed = await collect(bridge, id, 6, (all) =>
      all.some((e) => e.event === "run.completed"),
    );
    assert.deepEqual(
      resumed.map((e) => e["seq"]),
      [7, 8],
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
      // [WP-23] 旧 leoagent 转发只在 legacy 开关打开时生效。
      { leoagentUrl: `http://127.0.0.1:${port}`, legacyHarness: true },
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
      // 没列过的 id 不会被当成桌面任务。[WP-23] 旧 leoagent 转发默认关:直接 404,不再转发。
      assert.equal(
        (await bridge.handle(req("POST", "/harness/sessions/nope/send", { text: "x" }))).status,
        404,
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
      // [WP-23] 旧 leoagent 转发只在 legacy 开关打开时生效。
      { leoagentUrl: `http://127.0.0.1:${port}`, legacyHarness: true },
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

test("[WP-41] run.started is announced once per run and handed to the relay push path for phone turns", async () => {
  await withBridge(async ({ bridge, zcode, dir, pushed }) => {
    const id = await createSession(bridge, dir, { prompt: "跑一下" });
    zcode.fire(id, { type: "task_run_started", startedAt: 1 });
    zcode.fire(id, { type: "task_run_started", startedAt: 2 });
    zcode.fire(id, { type: "task_complete", stopReason: "success" });
    const events = await collect(bridge, id, 0, (all) => all.some((e) => e.event === "run.completed"));
    assert.equal(events.filter((e) => e.event === "run.started").length, 1);
    // 推送在日志落盘后才交出去:等一会儿。
    for (let i = 0; i < 40 && !pushed.some((e) => e.event === "run.started"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const started = pushed.find((e) => e.event === "run.started");
    assert.equal(started?.["session_id"], id);
  });
});


test("[WP-21] ACP agents are the phone's harnesses; sessions run as LeoBot tasks on the ACP model", async () => {
  const leoagentCalls: string[] = [];
  const server: Server = createServer((request, response) => {
    leoagentCalls.push(`${request.method} ${request.url}`);
    response.end(JSON.stringify({ harnesses: [{ key: "grok", name: "Grok" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await withBridge(
      async ({ bridge, zcode }) => {
        const capabilities = (await bridge.handle(req("GET", "/v1/capabilities"))).body as {
          harnesses: Record<string, unknown>[];
        };
        // [fix-remote] 不可用的也列出来(带原因),手机灰显;能不能用以 available 为准。
        assert.deepEqual(
          capabilities.harnesses.map((harness) => [harness["key"], harness["available"]]),
          [
            ["zcode", true],
            ["claude", true],
            ["codex", false],
          ],
        );
        const created = await bridge.handle(
          req("POST", "/harness/sessions", { harness: "claude", cwd: os.tmpdir(), prompt: "" }),
        );
        assert.equal(created.status, 202);
        assert.equal((created.body as Record<string, unknown>)["harness"], "claude");
        const [createParams] = zcode.named("createTask") as Record<string, unknown>[];
        assert.deepEqual(createParams?.["modelSelection"], {
          providerId: "acp",
          modelId: "claude-code",
          options: { reasoningLevel: "default" },
        });
        const listed = (await bridge.handle(req("GET", "/harness/sessions"))).body as {
          sessions: Record<string, unknown>[];
        };
        assert.equal(listed.sessions[0]?.["harness"], "claude");
        assert.equal(listed.sessions[0]?.["name"], "Claude Code");
        // [WP-23] 旧 leoagent harness 默认不转发
        const grok = await bridge.handle(req("POST", "/harness/sessions", { harness: "grok", prompt: "hi" }));
        assert.equal(grok.status, 400);
        assert.deepEqual(leoagentCalls, []);
      },
      {
        leoagentUrl: `http://127.0.0.1:${port}`,
        acpAgents: () => [
          { id: "claude-code", name: "Claude Code", harnessKey: "claude", available: true },
          { id: "codex", name: "Codex", harnessKey: "codex", available: false },
        ],
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const sonnet = { providerId: "personal-anthropic", modelId: "claude-sonnet", options: { reasoningLevel: "high" } };

test("[fix-remote] grok is an ACP harness: listed with path, version and runs as a LeoBot task on acp/grok", async () => {
  const versions: string[] = [];
  await withBridge(
    async ({ bridge, zcode }) => {
      const capabilities = (await bridge.handle(req("GET", "/v1/capabilities"))).body as {
        harnesses: Record<string, unknown>[];
      };
      const grok = capabilities.harnesses.find((harness) => harness["key"] === "grok");
      assert.deepEqual(grok, {
        key: "grok",
        name: "Grok",
        executable: "Grok",
        runtime: "acp",
        available: true,
        cli_path: "/Users/me/.grok/bin/grok",
        version: "grok 1.0.60",
        login_command: "grok login",
      });
      const gemini = capabilities.harnesses.find((harness) => harness["key"] === "gemini");
      assert.equal(gemini?.["available"], false);
      assert.match(String(gemini?.["unavailable_reason"]), /没有找到 gemini/);
      assert.deepEqual(versions, ["/Users/me/.grok/bin/grok"]);

      const created = await bridge.handle(req("POST", "/harness/sessions", { harness: "grok", cwd: os.tmpdir() }));
      assert.equal(created.status, 202, JSON.stringify(created.body));
      assert.equal((created.body as Record<string, unknown>)["harness"], "grok");
      assert.deepEqual(zcode.named("createTask")[0]?.["modelSelection"], {
        providerId: "acp",
        modelId: "grok",
        options: { reasoningLevel: "default" },
      });

      // 认得但本机装不上的 agent:把原因原样告诉手机。
      const refused = await bridge.handle(req("POST", "/harness/sessions", { harness: "gemini", prompt: "hi" }));
      assert.equal(refused.status, 400);
      assert.match(JSON.stringify(refused.body), /Gemini.*没有找到 gemini/);
    },
    {
      acpAgents: () => [
        {
          id: "grok",
          name: "Grok",
          harnessKey: "grok",
          available: true,
          cliPath: "/Users/me/.grok/bin/grok",
          loginCommand: "grok login",
        },
        {
          id: "gemini",
          name: "Gemini",
          harnessKey: "gemini",
          available: false,
          unavailableReason: "本机没有找到 gemini 命令",
        },
      ],
      acpAgentVersion: async (cliPath) => {
        versions.push(cliPath);
        return "grok 1.0.60";
      },
      zcodeModelSelection: async () => sonnet,
    },
  );
});

test("[fix-remote] LeoBot tasks pin a non-acp model; with none configured the phone gets 409 and a fix", async () => {
  await withBridge(
    async ({ bridge, zcode }) => {
      await createSession(bridge, os.tmpdir(), { prompt: "hi" });
      assert.deepEqual(zcode.named("createTask")[0]?.["modelSelection"], sonnet);
      const capabilities = (await bridge.handle(req("GET", "/v1/capabilities"))).body as {
        harnesses: Record<string, unknown>[];
      };
      assert.equal(capabilities.harnesses[0]?.["available"], true);
    },
    { zcodeModelSelection: async () => sonnet },
  );
  await withBridge(
    async ({ bridge, zcode }) => {
      const refused = await bridge.handle(req("POST", "/harness/sessions", { harness: "zcode", prompt: "hi" }));
      assert.equal(refused.status, 409);
      assert.match(JSON.stringify(refused.body), /LeoBot 还没配置模型.*设置 → AI 服务商.*全部发送到 Mac/);
      assert.equal(zcode.named("createTask").length, 0);
      const capabilities = (await bridge.handle(req("GET", "/v1/capabilities"))).body as {
        harnesses: Record<string, unknown>[];
      };
      assert.equal(capabilities.harnesses[0]?.["key"], "zcode");
      assert.equal(capabilities.harnesses[0]?.["available"], false);
      assert.match(String(capabilities.harnesses[0]?.["unavailable_reason"]), /LeoBot 还没配置模型/);
    },
    { zcodeModelSelection: async () => null },
  );
});

test("[fix-remote] ready-checkpoint recovery re-creates the LeoBot draft on the pinned model too", async () => {
  const { OperationReceipts } = await import("./operationReceipts.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-ready-model-"));
  const request = req("POST", "/harness/sessions", { prompt: "once" }, iphone, "ready-model");
  try {
    const receipts = new OperationReceipts(path.join(dir, "journals", "operations"));
    await receipts.run(request, async () => {
      await receipts.checkpoint(request, { stage: "ready", cwd: dir, taskId: "lost-draft" });
      throw new Error("CLI restarted before send");
    });
    await withBridge(
      async ({ bridge, zcode }) => {
        await bridge.restore();
        assert.equal((await bridge.handle(request)).status, 202);
        assert.equal(zcode.named("createTask")[0]?.["draftSessionId"], "lost-draft");
        assert.deepEqual(zcode.named("createTask")[0]?.["modelSelection"], sonnet);
      },
      { dir, zcodeModelSelection: async () => sonnet },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("[fix-remote] O: phone logs a Mac agent in: status, start, paste key, poll; writes need an identified device", async () => {
  const { AcpLoginFlows, acpAuthState } = await import("@zcode/shared/acp-login");
  const home = await mkdtemp(path.join(os.tmpdir(), "leo-agent-login-"));
  const env = { HOME: home, PATH: "/usr/bin" };
  const flows = new AcpLoginFlows({ env });
  try {
    await withBridge(
      async ({ bridge }) => {
        const caps = (await bridge.handle(req("GET", "/v1/capabilities"))).body as {
          features: Record<string, unknown>;
          harnesses: Record<string, unknown>[];
        };
        assert.equal(caps.features["agent_login"], true);
        assert.deepEqual(caps.harnesses.find((h) => h["key"] === "gemini")?.["auth"], { logged_in: false, login_kind: "api_key" });

        const status = await bridge.handle(req("GET", "/agents/gemini/auth"));
        assert.equal((status.body as { logged_in: boolean }).logged_in, false);

        // 认不出的调用方不能改 Mac 上的凭据。
        assert.equal((await bridge.handle(req("POST", "/agents/gemini/login", {}, unknown))).status, 403);

        const started = await bridge.handle(req("POST", "/agents/gemini/login", {}, iphone, "login-1"));
        assert.equal(started.status, 202);
        const flow = started.body as { flow_id: string; needs_code: boolean; url: string };
        assert.equal(flow.needs_code, true);
        assert.match(flow.url, /aistudio/);
        const pasted = await bridge.handle(
          req("POST", `/agents/gemini/login/${flow.flow_id}/code`, { code: "AIzaKEY" }, iphone, "login-2"),
        );
        assert.equal(pasted.status, 202);
        const polled = (await bridge.handle(req("GET", `/agents/gemini/login/${flow.flow_id}`))).body as { status: string };
        assert.equal(polled.status, "succeeded");
        assert.equal(((await bridge.handle(req("GET", "/agents/gemini/auth"))).body as { logged_in: boolean }).logged_in, true);
        assert.equal((await bridge.handle(req("GET", "/agents/nope/auth"))).status, 404);
      },
      {
        acpAgents: () => [{ id: "gemini", name: "Gemini", harnessKey: "gemini", available: true }],
        agentLogin: { state: (id) => acpAuthState(id, env), flows },
      },
    );
  } finally {
    flows.dispose();
    await rm(home, { recursive: true, force: true });
  }
});

test("[fix-remote] O: login codes never reach the operation receipts on disk", async () => {
  const { AcpLoginFlows, acpAuthState } = await import("@zcode/shared/acp-login");
  const home = await mkdtemp(path.join(os.tmpdir(), "leo-agent-login2-"));
  const env = { HOME: home, PATH: "/usr/bin" };
  const flows = new AcpLoginFlows({ env });
  try {
    await withBridge(
      async ({ bridge, dir }) => {
        const flow = (await bridge.handle(req("POST", "/agents/opencode/login", {}, iphone, "op-1"))).body as { flow_id: string };
        await bridge.handle(req("POST", `/agents/opencode/login/${flow.flow_id}/code`, { code: "SECRETKEY123" }, iphone, "op-2"));
        const operations = path.join(dir, "journals", "operations");
        const files = await readdir(operations).catch(() => [] as string[]);
        for (const file of files) assert.doesNotMatch(await readFile(path.join(operations, file), "utf8"), /SECRETKEY123/);
      },
      {
        acpAgents: () => [{ id: "opencode", name: "opencode", harnessKey: "opencode", available: true }],
        agentLogin: { state: (id) => acpAuthState(id, env), flows },
      },
    );
  } finally {
    flows.dispose();
    await rm(home, { recursive: true, force: true });
  }
});

test("[fix-remote] O: run.failed carries the failure code so the phone can offer 去登录", async () => {
  await withBridge(async ({ bridge, zcode, dir }) => {
    const id = await createSession(bridge, dir, { prompt: "hi" });
    zcode.fire(id, { type: "task_run_started", startedAt: 1 });
    zcode.fire(id, { type: "task_error", error: "Grok 在这台 Mac 上未登录或读不到登录态：…", code: "acp_auth" });
    const events = await collect(bridge, id, 0, (seen) => seen.some((e) => e["event"] === "run.failed"));
    const failed = events.find((e) => e["event"] === "run.failed");
    assert.equal(failed?.["code"], "acp_auth");
    assert.match(String(failed?.["error"]), /未登录/);
  });
});

test("mode / changes / diff / revert routes: modes, per-turn checkpoints in a git workspace, revert", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const git = (cwd: string, ...args: string[]) => promisify(execFile)("git", args, { cwd });
  await withBridge(async ({ bridge, zcode, dir }) => {
    const repo = path.join(dir, "repo");
    await git(dir, "init", "-q", repo);
    await git(repo, "config", "user.email", "t@example.com");
    await git(repo, "config", "user.name", "t");
    await writeFile(path.join(repo, "a.txt"), "1\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "init");

    // 创建时带 mode:优先于 full_auto;摘要带 mode
    const id = await createSession(bridge, repo, { prompt: "改 a", mode: "guarded", full_auto: false });
    assert.equal(zcode.named("createTask")[0]?.["mode"], "guarded");
    const listed = (await bridge.handle(req("GET", "/harness/sessions"))).body as { sessions: Record<string, unknown>[] };
    assert.equal(listed.sessions.find((s) => s["session_id"] === id)?.["mode"], "guarded");
    assert.equal((await bridge.handle(req("POST", "/harness/sessions", { cwd: repo, mode: "nope" }))).status, 400);
    assert.equal((await bridge.handle(req("POST", "/harness/sessions", { cwd: repo, mode: "yolo" }, unknown))).status, 403);

    // 切模式:非法 400、认不出的设备不能开全自动 403、其余 200,事件流里有 mode
    assert.equal((await bridge.handle(req("POST", `/harness/sessions/${id}/mode`, { mode: "auto" }))).status, 400);
    assert.equal((await bridge.handle(req("POST", `/harness/sessions/${id}/mode`, { mode: "yolo" }, unknown))).status, 403);
    assert.equal((await bridge.handle(req("GET", `/harness/sessions/${id}/mode`))).status, 405);
    const planned = await bridge.handle(req("POST", `/harness/sessions/${id}/mode`, { mode: "plan" }));
    assert.deepEqual(planned, { status: 200, body: { mode: "plan" } });
    assert.deepEqual(zcode.named("setMode").at(-1), { taskId: id, mode: "plan" });
    zcode.fire(id, { type: "mode_update", currentModeId: "build" }); // Mac 桌面上切的
    const modes = await collect(bridge, id, 0, (seen) => seen.filter((e) => e.event === "mode").length >= 2);
    assert.deepEqual(
      modes.filter((e) => e.event === "mode").map((e) => [e["type"], e["mode"]]),
      [
        ["mode", "plan"],
        ["mode", "build"],
      ],
    );

    // 这一轮开始前已拍了检查点 1;agent 改了文件
    await writeFile(path.join(repo, "a.txt"), "1\n2\n");
    await writeFile(path.join(repo, "new.txt"), "n\n");
    const changes = await bridge.handle(req("GET", `/harness/sessions/${id}/changes`));
    assert.equal(changes.status, 200);
    const body = changes.body as Record<string, unknown> & { files: Record<string, unknown>[]; checkpoints: Record<string, unknown>[] };
    assert.equal(body["is_repo"], true);
    assert.equal(body["cwd"], repo);
    assert.deepEqual(
      body.files.map((f) => [f["path"], f["status"], f["additions"], f["deletions"]]),
      [
        ["a.txt", "M", 1, 0],
        ["new.txt", "?", 1, 0],
      ],
    );
    assert.deepEqual(
      body.checkpoints.map((c) => [c["id"], c["turn"], c["label"]]),
      [["1", 1, "改 a"]],
    );
    const diff = await bridge.handle(req("GET", `/harness/sessions/${id}/diff?path=a.txt&checkpoint=1`));
    assert.equal(diff.status, 200);
    assert.match(String((diff.body as Record<string, unknown>)["diff"]), /^\+2$/m);
    assert.equal((await bridge.handle(req("GET", `/harness/sessions/${id}/diff?path=../x`))).status, 400);
    assert.equal((await bridge.handle(req("GET", `/harness/sessions/${id}/diff?path=a.txt&checkpoint=7`))).status, 404);

    // 还在跑不让回滚;跑完后回到第 1 轮开始之前
    assert.equal((await bridge.handle(req("POST", `/harness/sessions/${id}/revert`, { checkpoint: "1" }))).status, 409);
    zcode.fire(id, { type: "task_complete", stopReason: "success" });
    const reverted = await bridge.handle(req("POST", `/harness/sessions/${id}/revert`, { checkpoint: "1", paths: [] }));
    assert.deepEqual(reverted, { status: 200, body: { reverted: ["a.txt", "new.txt"], checkpoint: "1" } });
    assert.equal(await readFile(path.join(repo, "a.txt"), "utf8"), "1\n");

    // 第二轮:又拍一个检查点
    await bridge.handle(req("POST", `/harness/sessions/${id}/send`, { text: "再来" }));
    const again = (await bridge.handle(req("GET", `/harness/sessions/${id}/changes`))).body as { checkpoints: Record<string, unknown>[] };
    assert.deepEqual(again.checkpoints.map((c) => c["turn"]), [1, 2]);
    // 插话(还在跑)不是新的一轮
    await bridge.handle(req("POST", `/harness/sessions/${id}/send`, { text: "顺便" }));
    const steer = (await bridge.handle(req("GET", `/harness/sessions/${id}/changes`))).body as { checkpoints: unknown[] };
    assert.equal(steer.checkpoints.length, 2);

    // 非 git 工作区
    const plain = await createSession(bridge, dir);
    assert.deepEqual((await bridge.handle(req("GET", `/harness/sessions/${plain}/changes`))).body, {
      is_repo: false,
      cwd: dir,
      branch: null,
      files: [],
      checkpoints: [],
    });
    assert.equal((await bridge.handle(req("POST", `/harness/sessions/${plain}/revert`, { paths: ["a.txt"] }))).status, 409);
    assert.equal((await bridge.handle(req("GET", "/harness/sessions/missing/changes"))).status, 404);
  });
});

// -- [up-p3-mac] /automations(docs/specs/leo-link-automations.md) --------------------------------------

type FakeAutomation = import("@zcode/shared").ZCodeAutomation;
type FakeRun = import("@zcode/shared").ZCodeAutomationRun;

/** 假的自动化服务:只做内存表,记下桥接怎么调它(真服务的领域规则不在这里重复)。 */
function fakeAutomations(options: { limit?: number } = {}) {
  const items: FakeAutomation[] = [];
  const runs = new Map<string, FakeRun[]>();
  const calls: Call[] = [];
  let next = 0;
  let inFlight = new Set<string>();
  const find = (id: string) => items.find((item) => item.automationId === id);
  const service = {
    async listAllAutomations() {
      return items.map((item) => ({ ...item }));
    },
    async listAutomationRuns(params: { automationId: string }) {
      return runs.get(params.automationId) ?? [];
    },
    async createAutomation(params: Record<string, unknown>) {
      calls.push(["createAutomation", params]);
      if (items.length >= (options.limit ?? 20))
        throw new Error("[AUTOMATION_CREATE_LIMIT_REACHED] At most 20 automations may be retained.");
      if (String(params["cronExpr"]).startsWith("99")) {
        const invalid = new Error(`非法的 cron 表达式：${String(params["cronExpr"])}`);
        invalid.name = "InvalidCronExprError";
        throw invalid;
      }
      next += 1;
      const created: FakeAutomation = {
        automationId: `automation-${next}`,
        title: String(params["title"]),
        cronExpr: String(params["cronExpr"]),
        prompt: String(params["prompt"]),
        ...(params["mode"] ? { mode: params["mode"] as FakeAutomation["mode"] } : {}),
        ...(params["modelSelection"]
          ? { modelSelection: params["modelSelection"] as FakeAutomation["modelSelection"] }
          : {}),
        workspaceKey: String(params["workspacePath"]),
        workspacePath: String(params["workspacePath"]),
        locationKind: "local",
        recurring: params["recurring"] !== false,
        runCount: 0,
        enabled: true,
        lifecycleStatus: "active",
        nextRunAt: 1_800_000_000_000,
        dispatchStatus: "idle",
        dispatchAttempts: 0,
        createdAt: 1_761_000_000_000 + next,
        updatedAt: 1_761_000_000_000 + next,
      };
      items.push(created);
      return { ...created };
    },
    async updateAutomation(params: Record<string, unknown>) {
      calls.push(["updateAutomation", params]);
      const item = find(String(params["automationId"]));
      if (!item) return null;
      if (typeof params["title"] === "string") item.title = params["title"];
      if (typeof params["prompt"] === "string") item.prompt = params["prompt"];
      if (typeof params["cronExpr"] === "string") item.cronExpr = params["cronExpr"];
      if (typeof params["mode"] === "string") item.mode = params["mode"] as FakeAutomation["mode"];
      return { ...item };
    },
    async setAutomationEnabled(params: Record<string, unknown>) {
      calls.push(["setAutomationEnabled", params]);
      const item = find(String(params["automationId"]));
      if (item) item.enabled = params["enabled"] === true;
    },
    async deleteAutomation(params: Record<string, unknown>) {
      calls.push(["deleteAutomation", params]);
      const index = items.findIndex((item) => item.automationId === params["automationId"]);
      if (index >= 0) items.splice(index, 1);
    },
    async runAutomationNow(params: Record<string, unknown>) {
      calls.push(["runAutomationNow", params]);
      const id = String(params["automationId"]);
      if (inFlight.has(id)) return { status: "duplicate" as const };
      inFlight.add(id);
      return { status: "queued" as const };
    },
  };
  return {
    service: service as unknown as NonNullable<LinkBridgeDeps["automations"]>,
    items,
    runs,
    calls,
    named: (name: string) => calls.filter(([n]) => n === name).map(([, p]) => p),
    finishRuns: () => {
      inFlight = new Set();
    },
  };
}

type AutomationBody = {
  automation: Record<string, unknown> & { id: string; schedule: Record<string, unknown> };
};
const errorCode = (body: unknown) => (body as { error: { code: string } }).error.code;

test("automations: without the service the routes are closed and capabilities say so", async () => {
  await withBridge(async ({ bridge, pushed }) => {
    assert.equal((await bridge.handle(req("GET", "/automations"))).status, 404);
    const caps = await bridge.handle(req("GET", "/v1/capabilities"));
    assert.equal((caps.body as { features: Record<string, unknown> }).features["automations"], false);
    await bridge.automationRunCompleted({
      automationId: "a",
      runId: "a:1",
      trigger: "schedule",
      outcome: "succeeded",
      taskId: "t",
      workspacePath: "/w",
    });
    assert.equal(pushed.length, 0);
  });
});

test("automations: create uses phone-task defaults, is idempotent per request id, and follows the full-auto rule", async () => {
  const automations = fakeAutomations();
  await withBridge(
    async ({ bridge, dir }) => {
      const caps = await bridge.handle(req("GET", "/v1/capabilities"));
      assert.equal((caps.body as { features: Record<string, unknown> }).features["automations"], true);

      const body = {
        name: "日报",
        prompt: "汇总昨天的提交",
        schedule: { kind: "daily", time: "09:00" },
        workspace: dir,
      };
      assert.equal((await bridge.handle(req("POST", "/automations", body))).status, 400, "没有操作编号不建");
      const first = await bridge.handle(req("POST", "/automations", body, iphone, "op-create-1"));
      assert.equal(first.status, 201, JSON.stringify(first.body));
      const created = (first.body as AutomationBody).automation;
      assert.equal(created.name, "日报");
      assert.equal(created.workspace, dir);
      assert.equal(created.mode, "build");
      assert.deepEqual(created.schedule, {
        cron: "0 9 * * *",
        recurring: true,
        kind: "daily",
        human: "每天 09:00",
        time: "09:00",
      });
      assert.deepEqual(automations.named("createAutomation")[0], {
        workspacePath: dir,
        title: "日报",
        prompt: "汇总昨天的提交",
        cronExpr: "0 9 * * *",
        recurring: true,
        mode: "build",
        modelSelection: sonnet,
      });

      // 同一编号重试:同一个回执,不重复建。
      const retry = await bridge.handle(req("POST", "/automations", body, iphone, "op-create-1"));
      assert.deepEqual(retry, first);
      assert.equal(automations.named("createAutomation").length, 1);
      const conflict = await bridge.handle(
        req("POST", "/automations", { ...body, prompt: "别的" }, iphone, "op-create-1"),
      );
      assert.equal(conflict.status, 409);
      assert.equal(errorCode(conflict.body), "request_id_conflict");
      const receipt = await bridge.handle(req("GET", "/operations/op-create-1", undefined, iphone));
      assert.equal((receipt.body as { state: string }).state, "completed");

      // 没给工作区:和手机开任务同一规则(没有手机会话时是主目录)。
      const home = await bridge.handle(
        req("POST", "/automations", { prompt: "看看磁盘", schedule: "15 * * * *" }, iphone, "op-create-2"),
      );
      assert.equal(home.status, 201, JSON.stringify(home.body));
      assert.equal((home.body as AutomationBody).automation.workspace, os.homedir());
      assert.equal((home.body as AutomationBody).automation.name, "看看磁盘");

      // 一次性:recurring=false。
      const at = new Date(Date.now() + 3_600_000).toISOString();
      const once = await bridge.handle(
        req("POST", "/automations", { prompt: "提醒", schedule: { kind: "once", at }, workspace: dir }, iphone, "op-once"),
      );
      assert.equal(once.status, 201);
      assert.equal(automations.named("createAutomation").at(-1)?.["recurring"], false);

      // 全自动:认不出设备 403,认得出的可以。
      const yolo = { ...body, full_auto: true };
      const refused = await bridge.handle(req("POST", "/automations", yolo, unknown, "op-yolo-unknown"));
      assert.equal(refused.status, 403);
      assert.equal(errorCode(refused.body), "device_not_recognized");
      const allowed = await bridge.handle(req("POST", "/automations", yolo, legacy, "op-yolo-fold"));
      assert.equal(allowed.status, 201);
      assert.equal((allowed.body as AutomationBody).automation.mode, "yolo");

      // 校验与服务错误都成为正常响应(重试拿到同一个错误,不卡在 uncertain)。
      const missingDir = await bridge.handle(
        req("POST", "/automations", { ...body, workspace: path.join(dir, "nope") }, iphone, "op-missing-dir"),
      );
      assert.equal(missingDir.status, 400);
      const badTime = { ...body, schedule: { kind: "daily", time: "25:00" } };
      assert.equal((await bridge.handle(req("POST", "/automations", badTime, iphone, "op-bad"))).status, 400);
      const invalid = { ...body, schedule: "99 9 * * *" };
      const invalidCron = await bridge.handle(req("POST", "/automations", invalid, iphone, "op-invalid-cron"));
      assert.equal(invalidCron.status, 400);
      assert.deepEqual(await bridge.handle(req("POST", "/automations", invalid, iphone, "op-invalid-cron")), invalidCron);
      const badAgent = await bridge.handle(req("POST", "/automations", { ...body, harness: "nope" }, iphone, "op-agent"));
      assert.equal(badAgent.status, 400);
    },
    { automations: automations.service, zcodeModelSelection: async () => sonnet },
  );
});

test("automations: create maps no-model and the automation limit, ACP agents pick their model", async () => {
  await withBridge(
    async ({ bridge, dir }) => {
      const body = { prompt: "x", schedule: "0 9 * * *", workspace: dir };
      assert.equal((await bridge.handle(req("POST", "/automations", body, iphone, "op-1"))).status, 409);
    },
    { automations: fakeAutomations().service, zcodeModelSelection: async () => null },
  );
  const automations = fakeAutomations({ limit: 1 });
  await withBridge(
    async ({ bridge, dir }) => {
      const claude = await bridge.handle(
        req("POST", "/automations", { prompt: "x", schedule: "0 9 * * *", workspace: dir, harness: "claude" }, iphone, "op-1"),
      );
      assert.equal(claude.status, 201, JSON.stringify(claude.body));
      assert.deepEqual(automations.named("createAutomation")[0]?.["modelSelection"], acpModelSelection("claude-code"));
      const full = await bridge.handle(
        req("POST", "/automations", { prompt: "y", schedule: "0 9 * * *", workspace: dir }, iphone, "op-2"),
      );
      assert.equal(full.status, 409);
      assert.equal(errorCode(full.body), "automation_limit");
    },
    {
      automations: automations.service,
      zcodeModelSelection: async () => sonnet,
      acpAgents: () => [{ id: "claude-code", name: "Claude Code", harnessKey: "claude", available: true }],
    },
  );
});

test("automations: list, patch, enable/disable, run now, delete through the automation service", async () => {
  const automations = fakeAutomations();
  await withBridge(
    async ({ bridge, dir }) => {
      const make = async (extra: Record<string, unknown>, op: string) => {
        const body = { prompt: "p", schedule: "0 9 * * *", workspace: dir, ...extra };
        const created = await bridge.handle(req("POST", "/automations", body, iphone, op));
        return (created.body as AutomationBody).automation.id;
      };
      const id = await make({ name: "普通" }, "op-a");
      const yoloId = await make({ name: "全自动", mode: "yolo" }, "op-b");
      automations.runs.set(id, [
        {
          runId: `${id}:1`,
          automationId: id,
          workspaceKey: dir,
          trigger: "schedule",
          dispatchStatus: "dispatched",
          outcome: "failed",
          error: "boom",
          sessionId: "task-x",
          attempts: 1,
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      ]);

      const listed = await bridge.handle(req("GET", "/automations"));
      assert.equal(listed.status, 200);
      const rows = (listed.body as { automations: Array<Record<string, unknown>> }).automations;
      assert.deepEqual(rows.map((row) => row["id"]), [yoloId, id], "新建的在前");
      assert.deepEqual(rows[1]?.["last_run"], {
        status: "failed",
        at: 2,
        task_id: "task-x",
        trigger: "schedule",
        error: "boom",
      });
      assert.equal((await bridge.handle(req("GET", `/automations/${id}`))).status, 200);

      // 停用 + 改计划:分别走 setAutomationEnabled / updateAutomation,作用域是它自己的工作区。
      const patched = await bridge.handle(
        req("PATCH", `/automations/${id}`, {
          enabled: false,
          schedule: { kind: "weekly", time: "08:00", weekdays: [1, 5] },
        }),
      );
      assert.equal(patched.status, 200, JSON.stringify(patched.body));
      assert.deepEqual(automations.named("updateAutomation")[0], {
        automationId: id,
        workspacePath: dir,
        cronExpr: "0 8 * * 1,5",
        recurring: true,
        scheduleRule: null,
        scheduleEditedByUser: true,
      });
      assert.deepEqual(automations.named("setAutomationEnabled")[0], {
        automationId: id,
        workspacePath: dir,
        enabled: false,
      });
      const view = (patched.body as AutomationBody).automation;
      assert.equal(view.enabled, false);
      assert.equal(view.next_run_at, null);
      assert.equal(view.schedule.human, "每周一、五 08:00");
      assert.equal((await bridge.handle(req("PATCH", `/automations/${id}`, {}))).status, 400);

      // 全自动的那条:认不出设备不能改内容 / 启用 / 立即运行,但能改名、停用。
      const patchAs = async (target: string, body: unknown) =>
        (await bridge.handle(req("PATCH", `/automations/${target}`, body, unknown))).status;
      assert.equal(await patchAs(yoloId, { prompt: "rm -rf" }), 403);
      assert.equal(await patchAs(yoloId, { enabled: true }), 403);
      assert.equal(await patchAs(id, { mode: "yolo" }), 403);
      assert.equal(await patchAs(yoloId, { name: "改名", enabled: false }), 200);
      assert.equal((await bridge.handle(req("POST", `/automations/${yoloId}/run`, undefined, unknown))).status, 403);

      // 立即运行:排上 202;已有一次在跑 409;带编号的重试拿同一个回执,不再触发。
      const run = await bridge.handle(req("POST", `/automations/${id}/run`, undefined, iphone, "op-run-1"));
      assert.deepEqual(run, { status: 202, body: { ok: true, status: "queued" } });
      assert.deepEqual(await bridge.handle(req("POST", `/automations/${id}/run`, undefined, iphone, "op-run-1")), run);
      assert.equal(automations.named("runAutomationNow").length, 1);
      const busy = await bridge.handle(req("POST", `/automations/${id}/run`, undefined, iphone, "op-run-2"));
      assert.equal(busy.status, 409);
      assert.equal(errorCode(busy.body), "automation_run_in_flight");
      assert.equal((await bridge.handle(req("POST", `/automations/${yoloId}/run`, undefined, iphone))).status, 202);
      assert.equal((await bridge.handle(req("GET", `/automations/${id}/run`))).status, 405);

      assert.deepEqual(await bridge.handle(req("DELETE", `/automations/${id}`)), {
        status: 200,
        body: { ok: true, deleted: true },
      });
      assert.deepEqual(automations.named("deleteAutomation")[0], { automationId: id, workspacePath: dir });
      assert.equal((await bridge.handle(req("DELETE", `/automations/${id}`))).status, 404);
      assert.equal((await bridge.handle(req("PATCH", `/automations/${id}`, { name: "x" }))).status, 404);
      assert.equal((await bridge.handle(req("GET", "/automations/a%20b"))).status, 400);
      assert.equal((await bridge.handle(req("PUT", "/automations"))).status, 405);
    },
    { automations: automations.service, zcodeModelSelection: async () => sonnet },
  );
});

test("automations: a finished run is pushed to the phone and its task becomes adoptable", async () => {
  const automations = fakeAutomations();
  await withBridge(
    async ({ bridge, dir, pushed, zcode }) => {
      const body = { name: "日报", prompt: "p", schedule: "0 9 * * *", workspace: dir };
      const created = await bridge.handle(req("POST", "/automations", body, iphone, "op-a"));
      const id = (created.body as AutomationBody).automation.id;
      await bridge.automationRunCompleted({
        automationId: id,
        runId: `${id}:1761181200000`,
        trigger: "schedule",
        outcome: "failed",
        error: "模型额度用完了",
        taskId: "task-auto-1",
        workspacePath: dir,
      });
      assert.equal(pushed.length, 1);
      const { timestamp, ...event } = pushed[0]!;
      assert.equal(typeof timestamp, "number");
      assert.deepEqual(event, {
        event: "automation.run.completed",
        automation_id: id,
        name: "日报",
        status: "failed",
        summary: "模型额度用完了",
        task_id: "task-auto-1",
        session_id: "task-auto-1",
        run_id: `${id}:1761181200000`,
        trigger: "schedule",
        workspace: dir,
      });

      // 工作区不在 Mac 最近项目里也能接管:手机点通知打开这个任务。
      const stop = await bridge.handle(req("POST", "/harness/sessions/task-auto-1/stop", {}, iphone));
      assert.equal(stop.status, 200, JSON.stringify(stop.body));
      assert.equal(zcode.subscriptionCount(), 1);

      // 自动化已删:名字用占位,照样推。
      await bridge.automationRunCompleted({
        automationId: "automation-gone",
        runId: "automation-gone:manual:1",
        trigger: "manual",
        outcome: "succeeded",
        taskId: "task-auto-2",
        workspacePath: dir,
      });
      assert.equal(pushed[1]?.["name"], "定时任务");
      assert.equal(pushed[1]?.["summary"], "已在 Mac 上跑完");
    },
    { automations: automations.service, zcodeModelSelection: async () => sonnet },
  );
});
