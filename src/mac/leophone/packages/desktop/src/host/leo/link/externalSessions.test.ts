import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { IZCodeTaskService } from "@zcode/services";

import { LinkBridge, type LinkRequest } from "./bridge.js";
import { listClaudeSessions, readClaudeHistory } from "./externalSessions.js";
import type { HarnessEvent } from "./journal.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const SDK = "33333333-3333-4333-8333-333333333333";
const BROKEN = "44444444-4444-4444-8444-444444444444";

const jsonl = (...lines: unknown[]) => lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n";

/** 临时 HOME 下造一个 ~/.claude/projects:两个终端会话、一个 SDK 会话、一个全是坏行的。 */
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "leo-takeover-"));
  const projects = path.join(root, ".claude", "projects");
  const cwdA = path.join(root, "work", "app");
  await mkdir(cwdA, { recursive: true });
  await mkdir(path.join(projects, "-work-app"), { recursive: true });
  await mkdir(path.join(projects, "-work-other"), { recursive: true });
  await writeFile(
    path.join(projects, "-work-app", `${A}.jsonl`),
    jsonl(
      { type: "queue-operation", operation: "enqueue" },
      "{坏行",
      { type: "user", isMeta: true, cwd: cwdA, entrypoint: "cli", message: { role: "user", content: "<command-name>/clear</command-name>" } },
      { type: "user", cwd: cwdA, entrypoint: "cli", message: { role: "user", content: "<system-reminder>别看</system-reminder>帮我把登录页的按钮改成蓝色，顺便检查一下深色模式下的对比度够不够，还有表单校验" } },
      { type: "assistant", cwd: cwdA, message: { role: "assistant", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "好的，先看看文件。" }] } },
      { type: "assistant", cwd: cwdA, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "src/login.tsx" } }] } },
      { type: "user", cwd: cwdA, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "export function Login() {}" }] } },
      { type: "assistant", isSidechain: true, cwd: cwdA, message: { role: "assistant", content: [{ type: "text", text: "子 agent 的话" }] } },
      { type: "assistant", cwd: cwdA, message: { role: "assistant", content: [{ type: "text", text: "改好了。" }] } },
      { type: "user", cwd: cwdA, message: { role: "user", content: [{ type: "text", text: "再跑一下测试" }] } },
      { type: "assistant", cwd: cwdA, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "pnpm test" } }] } },
      { type: "user", cwd: cwdA, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", is_error: true, content: [{ type: "text", text: "1 failed" }] }] } },
    ),
  );
  await writeFile(
    path.join(projects, "-work-other", `${B}.jsonl`),
    jsonl(
      { type: "user", cwd: "/work/other", entrypoint: "cli", message: { role: "user", content: "随便问问" } },
      { type: "custom-title", customTitle: "Claude 自己起的标题" },
    ),
  );
  await writeFile(
    path.join(projects, "-work-other", `${SDK}.jsonl`),
    jsonl({ type: "user", cwd: "/work/other", entrypoint: "sdk-ts", message: { role: "user", content: "LeoBot 自己开的" } }),
  );
  await writeFile(path.join(projects, "-work-other", `${BROKEN}.jsonl`), "{{{\nnot json\n");
  await writeFile(path.join(projects, "-work-other", "not-a-uuid.jsonl"), jsonl({ type: "user", cwd: "/x", message: { content: "x" } }));
  // A 最新(10 秒前写过 = 终端还开着),B 一小时前
  const now = Date.now();
  await utimes(path.join(projects, "-work-app", `${A}.jsonl`), new Date(now - 10_000), new Date(now - 10_000));
  await utimes(path.join(projects, "-work-other", `${B}.jsonl`), new Date(now - 3_600_000), new Date(now - 3_600_000));
  return { root, projects, cwdA };
}

test("listing: newest first, titles skip meta / commands / reminders, SDK sessions and bad files are left out", async () => {
  const { root, projects, cwdA } = await fixture();
  try {
    const listed = await listClaudeSessions(projects);
    assert.deepEqual(
      listed.map((s) => [s.id, s.cwd, s.title, s.running]),
      [
        [A, cwdA, "帮我把登录页的按钮改成蓝色，顺便检查一下深色模式下的对比度够不够，还有表单校验".slice(0, 60), true],
        [B, "/work/other", "Claude 自己起的标题", false],
      ],
    );
    assert.equal(listed[0]?.agent, "claude");
    assert.match(listed[0]!.updated_at, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(await listClaudeSessions(path.join(root, "missing")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("history: turns become user.message / deltas / tool events / run.completed; sidechain skipped", async () => {
  const { root, projects } = await fixture();
  try {
    const { events, truncated } = await readClaudeHistory(path.join(projects, "-work-app", `${A}.jsonl`));
    assert.equal(truncated, false);
    assert.deepEqual(
      events.map((e) => e.event),
      ["user.message", "message.delta", "tool.started", "tool.completed", "message.delta", "run.completed", "user.message", "tool.started", "tool.completed", "run.completed"],
    );
    assert.equal(events[0]?.["text"], "帮我把登录页的按钮改成蓝色，顺便检查一下深色模式下的对比度够不够，还有表单校验");
    assert.deepEqual(events[2]?.["input"], { file_path: "src/login.tsx" });
    assert.equal(events[2]?.["preview"], "src/login.tsx");
    assert.equal(events[3]?.["output"], "export function Login() {}");
    assert.equal(events[8]?.["error"], true);
    assert.equal(events[8]?.["output"], "1 failed");
    assert.ok(!events.some((e) => String(e["delta"] ?? "").includes("子 agent")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fakeTasks() {
  const calls: [string, Record<string, unknown>][] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  let next = 0;
  const service = {
    async createTask(params: Record<string, unknown>) {
      calls.push(["createTask", params]);
      next += 1;
      return { taskId: `task-${next}` };
    },
    async setMode(params: Record<string, unknown>) {
      calls.push(["setMode", params]);
    },
    async sendPrompt(params: Record<string, unknown>) {
      calls.push(["sendPrompt", params]);
    },
    async listTaskList() {
      return { items: [], total: 0, hasMore: false };
    },
    onDynamicTaskEvent(params: { taskId: string }) {
      return (listener: (event: unknown) => void) => {
        listeners.set(params.taskId, listener);
        return { dispose: () => listeners.delete(params.taskId) };
      };
    },
  };
  const fire = (taskId: string, event: Record<string, unknown>) => listeners.get(taskId)?.({ taskId, traceId: "t", ...event });
  return { service: service as unknown as IZCodeTaskService, calls, fire };
}

const iphone = { kind: "iphone" as const, deviceId: "dev-iphone" };
const req = (method: string, pathname: string, body?: unknown): LinkRequest => ({ method, path: pathname, body, caller: iphone });

test("takeover routes: list, uuid / agent validation, ACP resume seeded, history replayed, repeat returns the same task", async () => {
  const { root, projects, cwdA } = await fixture();
  const acpSessionsPath = path.join(root, ".leophoneagent", "cli", "acp-sessions.json");
  await mkdir(path.dirname(acpSessionsPath), { recursive: true });
  await writeFile(acpSessionsPath, JSON.stringify({ "sess_other": { agentId: "codex", acpSessionId: "keep-me" } }));
  const tasks = fakeTasks();
  const bridge = new LinkBridge({
    taskService: tasks.service,
    logger: { info() {}, warn() {} },
    push: () => undefined,
    appVersion: "test",
    journalDir: path.join(root, "journals"),
    leoagent: { url: "http://127.0.0.1:2", key: () => null },
    sshHostKeys: async () => [],
    acpAgents: () => [{ id: "claude-code", name: "Claude Code", harnessKey: "claude", available: true }],
    claudeProjectsDir: projects,
    acpSessionsPath,
  });
  try {
    const listed = await bridge.handle(req("GET", "/harness/external-sessions"));
    assert.equal(listed.status, 200);
    const sessions = (listed.body as { sessions: Record<string, unknown>[] }).sessions;
    assert.deepEqual(sessions.map((s) => s["id"]), [A, B]);
    assert.equal(sessions[0]?.["file"], undefined, "不把 Mac 上的文件路径发给手机");
    assert.equal((await bridge.handle(req("POST", "/harness/external-sessions"))).status, 405);

    const bad = (session_id: unknown, agent = "claude") =>
      bridge.handle(req("POST", "/harness/sessions", { resume_external: { agent, session_id } }));
    assert.equal((await bad("../../etc/passwd")).status, 400);
    assert.equal((await bad(A.toUpperCase().replace("1", "Z"))).status, 400);
    assert.equal((await bad(A, "gemini")).status, 501);
    assert.equal((await bad(A, "codex")).status, 409, "这台 Mac 上 Codex 用不了");
    assert.equal((await bad(SDK)).status, 404, "SDK 会话不能接管");
    assert.equal((await bad("55555555-5555-4555-8555-555555555555")).status, 404);
    assert.equal(tasks.calls.filter(([name]) => name === "createTask").length, 0);

    // 同时来两次只开一个任务
    const [first, second] = await Promise.all([bad(A), bad(A)]);
    assert.equal(first.status, 202, JSON.stringify(first.body));
    assert.deepEqual(first, second);
    const body = first.body as Record<string, unknown>;
    assert.equal(body["harness"], "claude");
    assert.equal(body["cwd"], cwdA);
    assert.equal(body["warning"], "terminal_running");
    assert.equal(body["external_session_id"], A);
    const created = tasks.calls.filter(([name]) => name === "createTask");
    assert.equal(created.length, 1);
    assert.equal(created[0]![1]["workspacePath"], cwdA);
    assert.deepEqual(created[0]![1]["modelSelection"], { providerId: "acp", modelId: "claude-code", options: { reasoningLevel: "default" } });

    // ACP 映射预置了 session/load 用的 Claude 会话 id,别的任务的映射原样保留
    const state = JSON.parse(await readFile(acpSessionsPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(state["task-1"], { agentId: "claude-code", acpSessionId: A });
    assert.deepEqual(state["sess_other"], { agentId: "codex", acpSessionId: "keep-me" });

    // 事件流先回放历史
    const events: HarnessEvent[] = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    await bridge.stream(
      req("GET", "/harness/sessions/task-1/events?after=0"),
      (data) => {
        const frame = JSON.parse(data) as HarnessEvent;
        if (frame["type"] !== "resume") events.push(frame);
        if (events.filter((e) => e.event === "session.note").length >= 2) controller.abort();
      },
      controller.signal,
    );
    clearTimeout(timer);
    assert.deepEqual(
      events.map((e) => e.event).slice(0, 4),
      ["session.created", "session.note", "user.message", "message.delta"],
    );
    assert.match(String(events.at(-1)?.["text"]), /终端里这个会话还开着/);
    assert.deepEqual(events.map((e) => e["seq"]), events.map((_, index) => index + 1));

    // 再接管一次:回同一个任务,不再建
    const again = await bad(A);
    assert.equal((again.body as Record<string, unknown>)["session_id"], "task-1");
    assert.equal((again.body as Record<string, unknown>)["reused"], true);
    assert.equal(tasks.calls.filter(([name]) => name === "createTask").length, 1);
    const relisted = (await bridge.handle(req("GET", "/harness/external-sessions"))).body as { sessions: Record<string, unknown>[] };
    assert.equal(relisted.sessions[0]?.["leobot_session_id"], "task-1");

    // 第一条消息照常发给这个任务(CLI 拉起 claude 时按映射 session/load)
    assert.equal((await bridge.handle(req("POST", "/harness/sessions/task-1/send", { text: "继续" }))).status, 200);
    assert.equal(tasks.calls.filter(([name]) => name === "sendPrompt").at(-1)?.[1]["content"], "继续");
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("takeover is remembered across a Mac restart (session index)", async () => {
  const { root, projects } = await fixture();
  const make = () =>
    new LinkBridge({
      taskService: fakeTasks().service,
      logger: { info() {}, warn() {} },
      push: () => undefined,
      appVersion: "test",
      journalDir: path.join(root, "journals"),
      leoagent: { url: "http://127.0.0.1:2", key: () => null },
      sshHostKeys: async () => [],
      acpAgents: () => [{ id: "claude-code", name: "Claude Code", harnessKey: "claude", available: true }],
      claudeProjectsDir: projects,
      acpSessionsPath: path.join(root, "acp-sessions.json"),
    });
  const body = { resume_external: { agent: "claude", session_id: B } };
  try {
    const before = make();
    const created = await before.handle(req("POST", "/harness/sessions", body));
    assert.equal(created.status, 202);
    assert.equal((created.body as Record<string, unknown>)["warning"], undefined);
    await before.close();
    const after = make();
    await after.restore();
    const again = await after.handle(req("POST", "/harness/sessions", body));
    assert.equal((again.body as Record<string, unknown>)["reused"], true);
    assert.equal((again.body as Record<string, unknown>)["title"], "Claude 自己起的标题");
    await after.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("takeover: when ACP could not session/load (CLI started a new session) the stream says so and the summary carries resume_failed", async () => {
  const { root, projects } = await fixture();
  const acpSessionsPath = path.join(root, "acp-sessions.json");
  const tasks = fakeTasks();
  const bridge = new LinkBridge({
    taskService: tasks.service,
    logger: { info() {}, warn() {} },
    push: () => undefined,
    appVersion: "test",
    journalDir: path.join(root, "journals"),
    leoagent: { url: "http://127.0.0.1:2", key: () => null },
    sshHostKeys: async () => [],
    acpAgents: () => [{ id: "claude-code", name: "Claude Code", harnessKey: "claude", available: true }],
    claudeProjectsDir: projects,
    acpSessionsPath,
  });
  const takeOver = async (id: string) => {
    const created = await bridge.handle(req("POST", "/harness/sessions", { resume_external: { agent: "claude", session_id: id } }));
    return (created.body as { session_id: string }).session_id;
  };
  const summary = async (id: string) =>
    ((await bridge.handle(req("GET", "/harness/sessions"))).body as { sessions: Record<string, unknown>[] }).sessions.find((s) => s["session_id"] === id);
  const notes = async (id: string, wait: (events: HarnessEvent[]) => boolean) => {
    const events: HarnessEvent[] = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    await bridge.stream(req("GET", `/harness/sessions/${id}/events?after=0`), (data) => {
      const frame = JSON.parse(data) as HarnessEvent;
      if (frame["type"] !== "resume") events.push(frame);
      if (wait(events)) controller.abort();
    }, controller.signal);
    clearTimeout(timer);
    return events.filter((e) => e["kind"] === "resume_failed");
  };
  try {
    // 接上了:CLI 写回的还是终端那个 id → 不提示
    const ok = await takeOver(B);
    tasks.fire(ok, { type: "tool_call", toolId: "x", toolName: "Read", kind: "Read", title: "Read", input: {} });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(await notes(ok, (events) => events.some((e) => e.event === "tool.started" && e["tool_use_id"] === "x")), []);
    assert.equal((await summary(ok))?.["resume_failed"], undefined);

    // load 失败:CLI 新开了会话、把映射改成别的 id → 事件流一条提示、摘要带 resume_failed;只提示一次
    const lost = await takeOver(A);
    const state = JSON.parse(await readFile(acpSessionsPath, "utf8")) as Record<string, unknown>;
    state[lost] = { agentId: "claude-code", acpSessionId: "99999999-9999-4999-8999-999999999999" };
    await writeFile(acpSessionsPath, JSON.stringify(state));
    tasks.fire(lost, { type: "tool_call", toolId: "y", toolName: "Read", kind: "Read", title: "Read", input: {} });
    tasks.fire(lost, { type: "tool_call", toolId: "z", toolName: "Read", kind: "Read", title: "Read", input: {} });
    const failed = await notes(lost, (events) => events.some((e) => e["kind"] === "resume_failed"));
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.event, "session.note");
    assert.match(String(failed[0]?.["text"]), /没能接上终端里的那个会话.*Claude Code 看不到/);
    assert.equal((await summary(lost))?.["resume_failed"], true);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});
