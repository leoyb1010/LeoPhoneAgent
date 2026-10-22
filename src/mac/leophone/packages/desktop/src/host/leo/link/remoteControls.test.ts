// [remote-ctl-mac] docs/specs/leo-link-remote-controls.md 的 Mac 端:模型 / 强度、压缩、改名、附件、提问、关注、notify。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { IZCodeTaskService, ModelSelectionView } from "@zcode/services";
import type { ModelSelection, ZCodeAutomation } from "@zcode/shared";

import { LinkBridge, type LinkBridgeDeps, type LinkRequest } from "./bridge.js";
import type { HarnessEvent } from "./journal.js";
import { isLinkPath } from "./linkPolicy.js";
import type { Caller } from "./session.js";

type Call = [string, Record<string, unknown>];
const iphone: Caller = { kind: "iphone", deviceId: "dev-iphone" };
const silent = { info() {}, warn() {} };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function eventually(check: () => boolean, label: string) {
  for (let i = 0; i < 60 && !check(); i += 1) await sleep(20);
  assert.ok(check(), label);
}

const VIEW = {
  revision: 1,
  providers: [
    {
      providerId: "anthropic",
      providerName: "Anthropic",
      config: {},
      models: [
        { modelId: "sonnet", config: { optionSpecs: { reasoningLevel: { values: ["low", "medium", "high"] } } } },
        { modelId: "haiku", config: { optionSpecs: {} } },
        { modelId: "off", config: { enabled: false, optionSpecs: {} } },
      ],
    },
    { providerId: "acp", providerName: "ACP", config: {}, models: [{ modelId: "claude-code", config: { optionSpecs: {} } }] },
  ],
  preferredSelection: { providerId: "anthropic", modelId: "sonnet", options: { reasoningLevel: "high" } },
} as unknown as ModelSelectionView;
const DEFAULT: ModelSelection = { providerId: "anthropic", modelId: "sonnet", options: { reasoningLevel: "high" } };

function fakeZCode() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const calls: Call[] = [];
  let next = 0;
  let current: ModelSelection | null = null;
  const record = (name: string, result: unknown = true) => async (params: Record<string, unknown>) => {
    calls.push([name, params]);
    return result;
  };
  const service = {
    desktopTasks: [] as Record<string, unknown>[],
    async createTask(params: Record<string, unknown>) {
      calls.push(["createTask", params]);
      next += 1;
      current = (params["modelSelection"] as ModelSelection | undefined) ?? null;
      return { taskId: `task-${next}` };
    },
    setMode: record("setMode"),
    sendPrompt: record("sendPrompt"),
    resumeTask: record("resumeTask"),
    stopGeneration: record("stopGeneration"),
    respondPermission: record("respondPermission"),
    respondElicitation: record("respondElicitation"),
    compactSession: record("compactSession", { ok: true }),
    async renameTask(params: Record<string, unknown>) {
      calls.push(["renameTask", params]);
      return { taskId: params["taskId"], title: params["title"] };
    },
    async setModel(params: { modelSelection: ModelSelection }) {
      calls.push(["setModel", params]);
      // 内核换模型时先用目标模型的默认档位(这里取 low,便于看出强度是否被单独收敛)。
      current = { providerId: params.modelSelection.providerId, modelId: params.modelSelection.modelId, options: { reasoningLevel: "low" } };
      return [];
    },
    async setConfigOption(params: { value: string }) {
      calls.push(["setConfigOption", params]);
      if (current) current = { ...current, options: { reasoningLevel: params.value } };
      return [];
    },
    async getTaskModelSelection() {
      return current;
    },
    async listTaskList() {
      return { items: service.desktopTasks, total: service.desktopTasks.length, hasMore: false };
    },
    async getTaskSnapshot() {
      return null;
    },
    onDynamicTaskEvent(params: { taskId: string }) {
      return (listener: (event: unknown) => void) => {
        const set = listeners.get(params.taskId) ?? new Set();
        set.add(listener);
        listeners.set(params.taskId, set);
        return { dispose: () => set.delete(listener) };
      };
    },
  };
  return {
    service: service as unknown as IZCodeTaskService,
    raw: service,
    named: (name: string) => calls.filter(([n]) => n === name).map(([, p]) => p),
    fire: (taskId: string, event: Record<string, unknown>) => {
      for (const listener of Array.from(listeners.get(taskId) ?? [])) listener({ taskId, traceId: "trace", ...event });
    },
  };
}

function fakeAutomations() {
  const items: ZCodeAutomation[] = [];
  let next = 0;
  const service = {
    async listAllAutomations() {
      return items.map((item) => ({ ...item }));
    },
    async listAutomationRuns() {
      return [];
    },
    async createAutomation(params: Record<string, unknown>) {
      next += 1;
      const created = {
        automationId: `automation-${next}`,
        title: String(params["title"]),
        cronExpr: String(params["cronExpr"]),
        prompt: String(params["prompt"]),
        workspaceKey: String(params["workspacePath"]),
        workspacePath: String(params["workspacePath"]),
        locationKind: "local",
        recurring: true,
        runCount: 0,
        enabled: true,
        lifecycleStatus: "active",
        nextRunAt: 1_800_000_000_000,
        dispatchStatus: "idle",
        dispatchAttempts: 0,
        createdAt: 1_761_000_000_000 + next,
        updatedAt: 1_761_000_000_000 + next,
      } as ZCodeAutomation;
      items.push(created);
      return { ...created };
    },
    async updateAutomation() {
      return null;
    },
    async setAutomationEnabled() {},
    async deleteAutomation() {},
    async runAutomationNow() {
      return { status: "queued" as const };
    },
  };
  return { service: service as unknown as NonNullable<LinkBridgeDeps["automations"]>, items };
}

type Ctx = { bridge: LinkBridge; zcode: ReturnType<typeof fakeZCode>; dir: string; pushed: HarnessEvent[] };

async function withBridge(
  run: (ctx: Ctx) => Promise<void>,
  options: Partial<Omit<LinkBridgeDeps, "recentWorkspaces">> & { dir?: string; recentWorkspaces?: string[]; noModels?: boolean } = {},
) {
  const dir = options.dir ?? (await mkdtemp(path.join(os.tmpdir(), "leo-remote-")));
  const zcode = fakeZCode();
  const pushed: HarnessEvent[] = [];
  const { dir: _dir, recentWorkspaces, noModels, ...deps } = options;
  const bridge = new LinkBridge({
    taskService: zcode.service,
    logger: silent,
    push: (event) => pushed.push(event),
    appVersion: "test",
    journalDir: path.join(dir, "journals"),
    leoagent: { url: "http://127.0.0.1:2", key: () => "local-key-0123456789" },
    sshHostKeys: async () => [],
    legacyHarness: () => false,
    zcodeModelSelection: async () => DEFAULT,
    ...(noModels ? {} : { modelView: async () => VIEW }),
    ...(recentWorkspaces ? { recentWorkspaces: async () => recentWorkspaces } : {}),
    ...deps,
  });
  try {
    await run({ bridge, zcode, dir, pushed });
  } finally {
    await bridge.close();
    if (!options.dir) await rm(dir, { recursive: true, force: true });
  }
}

function req(method: string, pathname: string, body?: unknown, requestId?: string): LinkRequest {
  return { method, path: pathname, body, caller: iphone, ...(requestId ? { requestId } : {}) };
}

async function create(bridge: LinkBridge, cwd: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await bridge.handle(req("POST", "/harness/sessions", { harness: "zcode", cwd, ...extra }));
  assert.equal(created.status, 202, JSON.stringify(created.body));
  return (created.body as { session_id: string }).session_id;
}

async function events(bridge: LinkBridge, id: string, until: (all: HarnessEvent[]) => boolean, timeoutMs = 1500) {
  const controller = new AbortController();
  const out: HarnessEvent[] = [];
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  await bridge.stream(
    req("GET", `/harness/sessions/${id}/events?after=0`),
    (data) => {
      const frame = JSON.parse(data) as HarnessEvent;
      if (frame["type"] === "resume") return;
      out.push(frame);
      if (until(out)) controller.abort();
    },
    controller.signal,
  );
  clearTimeout(timer);
  return out;
}

async function summary(bridge: LinkBridge, id: string): Promise<Record<string, unknown>> {
  const list = (await bridge.handle(req("GET", "/harness/sessions"))).body as { sessions: Record<string, unknown>[] };
  return list.sessions.find((row) => row["session_id"] === id)!;
}

// -- 模型 / 强度 ------------------------------------------------------------------------------------

test("GET /harness/models lists LeoBot models with efforts and the default; 404 without a model view", async () => {
  await withBridge(async ({ bridge }) => {
    const res = await bridge.handle(req("GET", "/harness/models"));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      models: [
        { provider: "anthropic", provider_name: "Anthropic", model: "sonnet", name: "sonnet", efforts: ["low", "medium", "high"], default_effort: "high" },
        { provider: "anthropic", provider_name: "Anthropic", model: "haiku", name: "haiku", efforts: [], default_effort: null },
      ],
      default: { provider: "anthropic", model: "sonnet", effort: "high" },
    });
    assert.equal((await bridge.handle(req("POST", "/harness/models", {}))).status, 405);
  });
  await withBridge(async ({ bridge }) => {
    assert.equal((await bridge.handle(req("GET", "/harness/models"))).status, 404);
  }, { noModels: true });
});

test("POST …/model switches model (+effort), sets effort alone, validates, and emits a model event", async () => {
  await withBridge(async ({ bridge, zcode, dir }) => {
    const id = await create(bridge, dir);
    assert.deepEqual((await summary(bridge, id))["model"], { provider: "anthropic", model: "sonnet", name: "sonnet", effort: "high" });

    const switched = await bridge.handle(req("POST", `/harness/sessions/${id}/model`, { provider: "anthropic", model: "haiku" }));
    assert.equal(switched.status, 200, JSON.stringify(switched.body));
    assert.deepEqual(switched.body, { model: { provider: "anthropic", model: "haiku", name: "haiku", effort: "low" } });
    assert.equal(zcode.named("setConfigOption").length, 0, "没给强度不单独设档位");

    const both = await bridge.handle(req("POST", `/harness/sessions/${id}/model`, { provider: "anthropic", model: "sonnet", effort: "medium" }));
    assert.equal(both.status, 200);
    assert.deepEqual((both.body as { model: unknown }).model, { provider: "anthropic", model: "sonnet", name: "sonnet", effort: "medium" });
    assert.deepEqual(zcode.named("setModel").at(-1)?.["modelSelection"], { providerId: "anthropic", modelId: "sonnet", options: { reasoningLevel: "medium" } });
    assert.equal(zcode.named("setConfigOption").at(-1)?.["configId"], "thought_level");

    // 只改强度:不换模型。
    const effortOnly = await bridge.handle(req("POST", `/harness/sessions/${id}/model`, { effort: "low" }));
    assert.equal(effortOnly.status, 200);
    assert.equal(zcode.named("setModel").length, 2);
    assert.deepEqual(zcode.named("setConfigOption").at(-1), { taskId: id, traceId: zcode.named("setConfigOption").at(-1)?.["traceId"], configId: "thought_level", value: "low" });
    assert.equal((await summary(bridge, id))["model"] && ((await summary(bridge, id))["model"] as { effort: string }).effort, "low");

    const bad = async (body: unknown) => (await bridge.handle(req("POST", `/harness/sessions/${id}/model`, body))).status;
    assert.equal(await bad({ provider: "anthropic", model: "nope" }), 400);
    assert.equal(await bad({ provider: "acp", model: "claude-code" }), 400, "acp 不在可选列表");
    assert.equal(await bad({ effort: "max" }), 400);
    assert.equal(await bad({ provider: "anthropic", model: "haiku", effort: "high" }), 400, "haiku 没有档位");
    assert.equal(await bad({}), 400);
    assert.equal(await bad({ provider: "anthropic" }), 400);
    assert.equal((await bridge.handle(req("POST", "/harness/sessions/missing/model", { effort: "low" }))).status, 404);

    const stream = await events(bridge, id, (all) => all.filter((e) => e.event === "model").length >= 3);
    assert.deepEqual(
      stream.filter((e) => e.event === "model").map((e) => (e["model"] as { model: string; effort: string }).effort),
      ["low", "medium", "low"],
    );
    // Mac 桌面上换的(内核报 glm_agent_model_state_update)也发 model 事件。
    zcode.fire(id, { type: "glm_agent_model_state_update", model: { currentValue: "anthropic/haiku" }, thoughtLevel: { enabled: false, options: [] } });
    assert.deepEqual((await summary(bridge, id))["model"], { provider: "anthropic", model: "haiku", name: "haiku", effort: null });
  });
});

test("create honours model + effort and maps legacy thinking to effort; bad explicit values are 400", async () => {
  await withBridge(async ({ bridge, zcode, dir }) => {
    await create(bridge, dir, { model: { provider: "anthropic", model: "sonnet" }, effort: "low" });
    assert.deepEqual(zcode.named("createTask").at(-1)?.["modelSelection"], { providerId: "anthropic", modelId: "sonnet", options: { reasoningLevel: "low" } });
    await create(bridge, dir, { thinking: "medium" });
    assert.deepEqual(zcode.named("createTask").at(-1)?.["modelSelection"], { providerId: "anthropic", modelId: "sonnet", options: { reasoningLevel: "medium" } });
    // 旧 iPhone 的 thinking 取值不认识:静默按自动选择(旧行为)。
    await create(bridge, dir, { thinking: "adaptive" });
    assert.deepEqual(zcode.named("createTask").at(-1)?.["modelSelection"], DEFAULT);
    const id = await create(bridge, dir, { model: { provider: "anthropic", model: "haiku" } });
    assert.deepEqual(zcode.named("createTask").at(-1)?.["modelSelection"], { providerId: "anthropic", modelId: "haiku" });
    assert.deepEqual((await summary(bridge, id))["model"], { provider: "anthropic", model: "haiku", name: "haiku", effort: null });
    // 不带任何新字段:和以前一样。
    await create(bridge, dir);
    assert.deepEqual(zcode.named("createTask").at(-1)?.["modelSelection"], DEFAULT);
    const fail = async (body: Record<string, unknown>) =>
      (await bridge.handle(req("POST", "/harness/sessions", { harness: "zcode", cwd: dir, ...body }))).status;
    assert.equal(await fail({ model: { provider: "anthropic", model: "nope" } }), 400);
    assert.equal(await fail({ effort: "max" }), 400);
    assert.equal(await fail({ model: "sonnet" }), 400);
  });
});

// -- 压缩 / 改名 ------------------------------------------------------------------------------------

test("compact goes through the kernel (202), not as text; a running task is 409", async () => {
  await withBridge(async ({ bridge, zcode, dir }) => {
    const id = await create(bridge, dir);
    const res = await bridge.handle(req("POST", `/harness/sessions/${id}/compact`, {}));
    assert.deepEqual([res.status, res.body], [202, { ok: true }]);
    assert.deepEqual(zcode.named("compactSession"), [{ taskId: id, workspacePath: dir }]);
    assert.equal(zcode.named("sendPrompt").length, 0);
    const notes = await events(bridge, id, (all) => all.some((e) => e["kind"] === "compacted"));
    assert.ok(notes.some((e) => e["kind"] === "compacted"));
    await bridge.handle(req("POST", `/harness/sessions/${id}/send`, { text: "跑起来" }));
    assert.equal((await bridge.handle(req("POST", `/harness/sessions/${id}/compact`, {}))).status, 409);
  });
});

test("rename changes the real task title", async () => {
  await withBridge(async ({ bridge, zcode, dir }) => {
    const id = await create(bridge, dir, { prompt: "原来的标题" });
    const res = await bridge.handle(req("POST", `/harness/sessions/${id}/rename`, { title: "  新 标题 " }));
    assert.deepEqual([res.status, res.body], [200, { title: "新 标题" }]);
    assert.deepEqual(zcode.named("renameTask"), [{ taskId: id, workspacePath: dir, title: "新 标题" }]);
    assert.equal((await summary(bridge, id))["title"], "新 标题");
    assert.equal((await bridge.handle(req("POST", `/harness/sessions/${id}/rename`, { title: " " }))).status, 400);
    assert.equal((await bridge.handle(req("POST", `/harness/sessions/${id}/rename`, { title: "x".repeat(201) }))).status, 400);
  });
});

// -- 附件 ------------------------------------------------------------------------------------------

test("send attachments: images only, ≤ 5 MB each, ≤ 4; HEIC is converted to JPEG", async () => {
  const converted: number[] = [];
  await withBridge(
    async ({ bridge, zcode, dir }) => {
      const id = await create(bridge, dir);
      const small = Buffer.from("fake-jpeg").toString("base64");
      const ok = await bridge.handle(
        req("POST", `/harness/sessions/${id}/send`, {
          text: "",
          attachments: [
            { name: "a.jpg", mime: "image/jpeg", data_base64: small },
            { name: "b.heic", mime: "image/heic", data_base64: Buffer.from("heic").toString("base64") },
          ],
        }),
      );
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.deepEqual(zcode.named("sendPrompt").at(-1)?.["attachments"], [
        { kind: "image", filename: "a.jpg", mimeType: "image/jpeg", sizeBytes: 9, dataBase64: small },
        { kind: "image", filename: "b.jpg", mimeType: "image/jpeg", sizeBytes: 4, dataBase64: Buffer.from("JPEG").toString("base64") },
      ]);
      assert.deepEqual(converted, [4]);
      const status = async (attachments: unknown, text = "看图") =>
        (await bridge.handle(req("POST", `/harness/sessions/${id}/send`, { text, attachments }))).status;
      const one = { mime: "image/png", data_base64: small };
      assert.equal(await status([one, one, one, one, one]), 413);
      const big = Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64");
      assert.equal(await status([{ mime: "image/png", data_base64: big }]), 413);
      assert.equal(await status([{ mime: "image/gif", data_base64: small }]), 415);
      assert.equal(await status([{ mime: "application/pdf", data_base64: small }]), 415);
      assert.equal(await status([{ mime: "image/png", data_base64: "%%%" }]), 400);
      assert.equal(await status("nope"), 400);
      assert.equal(await status(undefined, ""), 400, "没字也没图");
      assert.equal(zcode.named("sendPrompt").length, 1);
      // 旧手机不带 attachments:sendPrompt 里没有这个字段。
      await bridge.handle(req("POST", `/harness/sessions/${id}/send`, { text: "纯文字" }));
      assert.ok(!("attachments" in zcode.named("sendPrompt").at(-1)!));
    },
    {
      convertHeic: async (data) => {
        converted.push(data.length);
        return Buffer.from("JPEG");
      },
    },
  );
});

// -- 提问 ------------------------------------------------------------------------------------------

const ASK = {
  type: "elicitation_request",
  requestId: "q1",
  message: "",
  options: [],
  questions: [
    { question: "用哪个库?", header: "库", multiSelect: false, options: [{ value: "zod", label: "Zod", description: "校验" }, { value: "yup", label: "Yup" }] },
    { question: "要哪些平台?", header: "平台", multiSelect: true, options: [{ value: "ios", label: "iOS" }, { value: "mac", label: "macOS" }] },
  ],
};

test("question.request → POST …/answer accepts with the CLI content shape; decline; Mac answers close the card", async () => {
  await withBridge(async ({ bridge, zcode, dir }) => {
    const id = await create(bridge, dir, { prompt: "问我" });
    zcode.fire(id, ASK);
    const asked = await events(bridge, id, (all) => all.some((e) => e.event === "question.request"));
    assert.deepEqual(
      (({ seq: _s, session_id: _i, timestamp: _t, durability: _d, ...rest }) => rest)(asked.find((e) => e.event === "question.request")!),
      {
        event: "question.request",
        question_id: "q1",
        questions: [
          { question: "用哪个库?", header: "库", options: [{ label: "Zod", description: "校验" }, { label: "Yup" }], multi_select: false },
          { question: "要哪些平台?", header: "平台", options: [{ label: "iOS" }, { label: "macOS" }], multi_select: true },
        ],
      },
    );
    assert.equal((await bridge.handle(req("POST", `/harness/sessions/${id}/answer`, { question_id: "q1" }))).status, 400);
    const answered = await bridge.handle(
      req("POST", `/harness/sessions/${id}/answer`, {
        question_id: "q1",
        answers: [
          { question: "用哪个库?", selected: ["Zod"] },
          { question: "要哪些平台?", selected: ["iOS", "macOS"], text: "还有手表" },
        ],
      }),
    );
    assert.deepEqual([answered.status, answered.body], [200, { ok: true, question_id: "q1" }]);
    assert.deepEqual(zcode.named("respondElicitation"), [
      {
        taskId: id,
        workspacePath: dir,
        requestId: "q1",
        action: "accept",
        content: {
          answers: { "用哪个库?": "zod", "要哪些平台?": "ios, mac, 还有手表" },
          answer_0: "zod",
          answer_1: ["ios", "mac", "还有手表"],
        },
      },
    ]);
    assert.equal((await bridge.handle(req("POST", `/harness/sessions/${id}/answer`, { question_id: "q1", decline: true }))).status, 409);
    const responded = await events(bridge, id, (all) => all.some((e) => e.event === "question.responded"));
    assert.equal(responded.find((e) => e.event === "question.responded")?.["question_id"], "q1");

    // 跳过
    zcode.fire(id, { ...ASK, requestId: "q2" });
    await tick();
    const declined = await bridge.handle(req("POST", `/harness/sessions/${id}/answer`, { question_id: "q2", decline: true }));
    assert.equal(declined.status, 200);
    assert.deepEqual(zcode.named("respondElicitation").at(-1), { taskId: id, workspacePath: dir, requestId: "q2", action: "decline" });

    // Mac 上答了:手机收卡,手机再答是 409。
    zcode.fire(id, { ...ASK, requestId: "q3" });
    zcode.fire(id, { type: "elicitation_response", requestId: "q3", action: "accept" });
    await tick();
    assert.equal((await bridge.handle(req("POST", `/harness/sessions/${id}/answer`, { question_id: "q3", decline: true }))).status, 409);
    const all = await events(bridge, id, (list) => list.filter((e) => e.event === "question.responded").length >= 3);
    assert.deepEqual(all.filter((e) => e.event === "question.responded").map((e) => e["question_id"]), ["q1", "q2", "q3"]);

    // 旧版手机答不了,直接发消息:先替它跳过提问,消息照常送进去。
    zcode.fire(id, { ...ASK, requestId: "q4" });
    await tick();
    await bridge.handle(req("POST", `/harness/sessions/${id}/send`, { text: "用 zod" }));
    assert.deepEqual(zcode.named("respondElicitation").at(-1), { taskId: id, workspacePath: dir, requestId: "q4", action: "decline" });
    assert.equal(zcode.named("sendPrompt").at(-1)?.["content"], "用 zod");
  });
});

test("unattended automation runs still decline questions and stop the run", async () => {
  const automations = fakeAutomations();
  await withBridge(
    async ({ bridge, zcode, dir }) => {
      const created = await bridge.handle(req("POST", "/automations", { name: "a", prompt: "p", schedule: "0 9 * * *", workspace: dir }, "op-q"));
      const id = (created.body as { automation: { id: string } }).automation.id;
      bridge.automationRunStarted({ automationId: id, runId: `${id}:1`, trigger: "schedule", taskId: "task-u", workspacePath: dir });
      zcode.fire("task-u", ASK);
      await eventually(() => zcode.named("stopGeneration").length === 1, "停掉这次运行");
      assert.deepEqual(zcode.named("respondElicitation"), [{ taskId: "task-u", workspacePath: dir, requestId: "q1", action: "decline" }]);
    },
    { automations: automations.service },
  );
});

// -- 关注(省电) ------------------------------------------------------------------------------------

test("follow gate: only followed sessions push; send / create follow; opening a desktop task does not", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "leo-remote-ws-"));
  try {
    await withBridge(
      async ({ bridge, zcode, dir, pushed }) => {
        const id = await create(bridge, dir, { prompt: "手机发的" });
        assert.deepEqual([(await summary(bridge, id))["following"], (await summary(bridge, id))["source"]], [true, "phone"]);
        zcode.fire(id, { type: "task_complete", stopReason: "success" });
        await eventually(() => pushed.some((e) => e.event === "run.completed"), "关注的会话推");

        // 取消关注:之后 Mac 上的一轮(审批 / 完成)只记日志,不推。
        const off = await bridge.handle(req("POST", `/harness/sessions/${id}/follow`, { following: false }));
        assert.deepEqual([off.status, off.body], [200, { following: false }]);
        const before = pushed.length;
        zcode.fire(id, { type: "task_run_started" });
        zcode.fire(id, { type: "task_complete", stopReason: "success" });
        await sleep(60);
        assert.equal(pushed.length, before);
        const followEvents = (await events(bridge, id, (all) => all.filter((e) => e.event === "follow").length >= 1)).filter((e) => e.event === "follow");
        assert.deepEqual(followEvents.map((e) => e["following"]), [false]);

        // 发消息 ⇒ 重新关注。
        await bridge.handle(req("POST", `/harness/sessions/${id}/send`, { text: "再来" }));
        assert.equal((await summary(bridge, id))["following"], true);
        zcode.fire(id, { type: "task_complete", stopReason: "success" });
        await eventually(() => pushed.length > before, "重新关注后推");

        assert.equal((await bridge.handle(req("POST", `/harness/sessions/${id}/follow`, { following: "yes" }))).status, 400);

        // 桌面任务:列表里 following=false / source=desktop;打开看看(事件流)不关注,也不推。
        zcode.raw.desktopTasks = [
          { taskId: "desk-1", workspacePath: workspace, title: "桌面任务", status: "completed", mode: "build", createdAt: 1_000, updatedAt: 2_000 },
          { taskId: "desk-2", workspacePath: workspace, title: "另一个", status: "completed", mode: "build", createdAt: 1_000, updatedAt: 2_000 },
        ];
        const row = await summary(bridge, "desk-1");
        assert.deepEqual([row["following"], row["source"], row["model"]], [false, "desktop", null]);
        await events(bridge, "desk-1", () => true);
        const adopted = await summary(bridge, "desk-1");
        assert.deepEqual([adopted["following"], adopted["source"]], [false, "desktop"]);
        const pushedBefore = pushed.length;
        zcode.fire("desk-1", { type: "task_run_started" });
        zcode.fire("desk-1", { type: "task_complete", stopReason: "success" });
        await sleep(60);
        assert.equal(pushed.length, pushedBefore, "没关注的桌面任务不推");

        // 关注一个还没接过来的桌面任务:先接管再关注。
        await summary(bridge, "desk-2");
        const follow = await bridge.handle(req("POST", "/harness/sessions/desk-2/follow", { following: true }));
        assert.deepEqual([follow.status, follow.body], [200, { following: true }]);
        assert.deepEqual([(await summary(bridge, "desk-2"))["following"], (await summary(bridge, "desk-2"))["source"]], [true, "desktop"]);
        zcode.fire("desk-2", { type: "task_run_started" });
        await eventually(() => pushed.some((e) => e.event === "run.started" && e["session_id"] === "desk-2"), "关注后 Mac 上的一轮也推");
        assert.equal((await bridge.handle(req("POST", "/harness/sessions/nope/follow", { following: true }))).status, 404);
      },
      { recentWorkspaces: [workspace] },
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("following, source and model survive a Mac restart (sessions.json); old index rows default to unfollowed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-remote-restore-"));
  try {
    let followed = "";
    let unfollowed = "";
    await withBridge(
      async ({ bridge }) => {
        followed = await create(bridge, dir, { model: { provider: "anthropic", model: "haiku" } });
        unfollowed = await create(bridge, dir);
        await bridge.handle(req("POST", `/harness/sessions/${unfollowed}/follow`, { following: false }));
        await sleep(30);
      },
      { dir },
    );
    // 升级前的任务表行:没有 following / source / model。
    const indexFile = path.join(dir, "journals", "sessions.json");
    const rows = JSON.parse(await (await import("node:fs/promises")).readFile(indexFile, "utf8")) as Record<string, unknown>[];
    rows.push({ task_id: "legacy-1", cwd: dir, title: "旧任务", mode: "build", created_at: 1 });
    await writeFile(indexFile, JSON.stringify(rows));
    await withBridge(
      async ({ bridge }) => {
        await bridge.restore();
        const a = await summary(bridge, followed);
        assert.deepEqual([a["following"], a["source"], a["model"]], [true, "phone", { provider: "anthropic", model: "haiku", name: "haiku", effort: null }]);
        assert.equal((await summary(bridge, unfollowed))["following"], false);
        const legacy = await summary(bridge, "legacy-1");
        assert.deepEqual([legacy["following"], legacy["source"], legacy["model"]], [false, "phone", null]);
      },
      { dir },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// -- 定时任务 notify -----------------------------------------------------------------------------------

test("automation notify: phone-created default true, PATCH-able; completion and unattended approvals push only when notify or followed", async () => {
  const automations = fakeAutomations();
  await withBridge(
    async ({ bridge, zcode, dir, pushed }) => {
      const created = await bridge.handle(req("POST", "/automations", { name: "日报", prompt: "p", schedule: "0 9 * * *", workspace: dir }, "op-n1"));
      const id = (created.body as { automation: { id: string; notify: boolean } }).automation.id;
      assert.equal((created.body as { automation: { notify: boolean } }).automation.notify, true);
      const quiet = await bridge.handle(req("POST", "/automations", { name: "静默", prompt: "p", schedule: "0 9 * * *", workspace: dir, notify: false }, "op-n2"));
      const quietId = (quiet.body as { automation: { id: string; notify: boolean } }).automation.id;
      assert.equal((quiet.body as { automation: { notify: boolean } }).automation.notify, false);
      assert.equal((await bridge.handle(req("POST", "/automations", { prompt: "p", schedule: "0 9 * * *", notify: "yes" }, "op-n3"))).status, 400);

      const done = (automationId: string, taskId: string) =>
        bridge.automationRunCompleted({ automationId, runId: `${automationId}:${taskId}`, trigger: "schedule", outcome: "succeeded", taskId, workspacePath: dir });
      await done(id, "t1");
      assert.equal(pushed.filter((e) => e.event === "automation.run.completed").length, 1);
      await done(quietId, "t2");
      assert.equal(pushed.filter((e) => e.event === "automation.run.completed").length, 1, "notify=false 不推");

      // PATCH notify(只改它也行);GET 返回它。
      const patched = await bridge.handle(req("PATCH", `/automations/${id}`, { notify: false }));
      assert.equal(patched.status, 200, JSON.stringify(patched.body));
      assert.equal((patched.body as { automation: { notify: boolean } }).automation.notify, false);
      assert.equal(((await bridge.handle(req("GET", `/automations/${id}`))).body as { automation: { notify: boolean } }).automation.notify, false);
      assert.equal((await bridge.handle(req("PATCH", `/automations/${id}`, { notify: 1 }))).status, 400);
      await done(id, "t3");
      assert.equal(pushed.filter((e) => e.event === "automation.run.completed").length, 1);

      // 目标会话被关注:notify=false 也推。
      const followedTask = await create(bridge, dir);
      await done(quietId, followedTask);
      assert.equal(pushed.filter((e) => e.event === "automation.run.completed").length, 2);

      // 无人值守审批:notify=false 且没关注 → 不推(照样记日志、可答);30 分钟自动拒绝不受影响。
      bridge.automationRunStarted({ automationId: quietId, runId: `${quietId}:u1`, trigger: "schedule", taskId: "task-u1", workspacePath: dir });
      zcode.fire("task-u1", { type: "permission_request", requestId: "p1", description: "Bash", kind: "Bash", title: "Bash", options: [{ optionId: "allow_once", kind: "allow_once", name: "Allow", response: { decision: "allow" } }, { optionId: "deny", kind: "deny", name: "Deny", response: { decision: "deny" } }], raw: { requestId: "p1", toolName: "Bash", input: { command: "ls" } } });
      await eventually(() => zcode.named("respondPermission").length === 1, "超时自动拒绝照旧");
      assert.ok(!pushed.some((e) => e["approval_id"] === "p1"));

      // notify=true 的照样推审批卡。
      await bridge.handle(req("PATCH", `/automations/${quietId}`, { notify: true }));
      bridge.automationRunStarted({ automationId: quietId, runId: `${quietId}:u2`, trigger: "schedule", taskId: "task-u2", workspacePath: dir });
      zcode.fire("task-u2", { type: "permission_request", requestId: "p2", description: "Bash", kind: "Bash", title: "Bash", options: [{ optionId: "allow_once", kind: "allow_once", name: "Allow", response: { decision: "allow" } }, { optionId: "deny", kind: "deny", name: "Deny", response: { decision: "deny" } }], raw: { requestId: "p2", toolName: "Bash", input: { command: "ls" } } });
      await eventually(() => pushed.some((e) => e["approval_id"] === "p2"), "notify 打开的推审批");
    },
    { automations: automations.service, unattendedApprovalMs: 80 },
  );
});

test("automation notify migration: automations created via Link before the upgrade (operation receipts) default to true", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-remote-notify-"));
  try {
    const automations = fakeAutomations();
    const phoneMade = await automations.service.createAutomation({ title: "手机建的", prompt: "p", cronExpr: "0 9 * * *", workspacePath: dir } as never);
    const desktopMade = await automations.service.createAutomation({ title: "桌面建的", prompt: "p", cronExpr: "0 9 * * *", workspacePath: dir } as never);
    const receipts = path.join(dir, "journals", "operations");
    await mkdir(receipts, { recursive: true });
    await writeFile(
      path.join(receipts, "abc.json"),
      JSON.stringify({ version: 1, fingerprint: "f", state: "completed", response: { status: 201, body: { automation: { id: phoneMade.automationId } } } }),
    );
    await writeFile(path.join(receipts, "def.json"), JSON.stringify({ version: 1, fingerprint: "f", state: "completed", response: { status: 202, body: { session_id: "x" } } }));
    await withBridge(
      async ({ bridge }) => {
        await bridge.restore();
        const list = (await bridge.handle(req("GET", "/automations"))).body as { automations: { id: string; notify: boolean }[] };
        const notify = Object.fromEntries(list.automations.map((item) => [item.id, item.notify]));
        assert.deepEqual(notify, { [phoneMade.automationId]: true, [desktopMade.automationId]: false });
      },
      { dir, automations: automations.service },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// -- capabilities / 白名单 ----------------------------------------------------------------------------

test("capabilities advertise the remote-control features; models follow the model view", async () => {
  const keys = ["models", "model_switch", "effort", "compact", "rename", "attachments", "ask_user_question", "follow"];
  await withBridge(async ({ bridge }) => {
    const features = ((await bridge.handle(req("GET", "/v1/capabilities"))).body as { features: Record<string, boolean> }).features;
    assert.deepEqual(keys.map((key) => features[key]), keys.map(() => true));
  });
  await withBridge(async ({ bridge }) => {
    const features = ((await bridge.handle(req("GET", "/v1/capabilities"))).body as { features: Record<string, boolean> }).features;
    assert.deepEqual([features["models"], features["model_switch"], features["effort"], features["follow"]], [false, false, false, true]);
  }, { noModels: true });
});

test("Link whitelist admits exactly the new routes", () => {
  assert.ok(isLinkPath("/harness/models"));
  for (const action of ["model", "compact", "rename", "answer", "follow"]) assert.ok(isLinkPath(`/harness/sessions/t1/${action}`), action);
  assert.ok(!isLinkPath("/harness/sessions/t1/models"));
  assert.ok(!isLinkPath("/harness/models/x"));
  assert.ok(!isLinkPath("/harness/sessions/t1/model/x"));
  assert.ok(!isLinkPath("/v1/models"));
});
