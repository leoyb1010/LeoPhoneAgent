import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { IZCodeTaskService } from "@zcode/services";

import { LinkBridge, type LinkRequest } from "./bridge.js";
import { findCodexSession, listCodexSessions, readCodexHistory } from "./codexSessions.js";
import type { HarnessEvent } from "./journal.js";

const DESKTOP = "01a1638d-f2b7-7fa2-8957-4335c0663a63";
const SEGMENT = "01a163a3-3b38-7170-8f4c-1c72e1f94fe3";
const CLI = "019a0000-0000-7000-8000-000000000001";
const EXEC = "019a0000-0000-7000-8000-000000000002";
const SUB = "019a0000-0000-7000-8000-000000000003";
const OWN = "019a0000-0000-7000-8000-000000000004";

const jsonl = (...lines: unknown[]) => lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n";
const meta = (id: string, cwd: string, extra: Record<string, unknown> = {}) => ({
  type: "session_meta",
  payload: { id, session_id: id, cwd, originator: "Codex Desktop", source: "vscode", thread_source: "user", base_instructions: { text: "很长的系统提示" }, ...extra },
});
const user = (...texts: string[]) => ({ type: "response_item", payload: { type: "message", role: "user", content: texts.map((text) => ({ type: "input_text", text })) } });
const assistant = (text: string) => ({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
const event = (type: string) => ({ type: "event_msg", payload: { type, turn_id: "t" } });

/** 临时 CODEX_HOME:桌面版会话(两段,第二段正在跑)、终端 codex 会话、exec / 子 agent / LeoBot 自己的(都不列)、坏文件。 */
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "leo-codex-"));
  const home = path.join(root, ".codex");
  const day1 = path.join(home, "sessions", "2026", "10", "21");
  const day2 = path.join(home, "sessions", "2026", "10", "22");
  await mkdir(day1, { recursive: true });
  await mkdir(day2, { recursive: true });
  const cwd = path.join(root, "work", "cho");
  await mkdir(cwd, { recursive: true });
  const first = path.join(day2, `rollout-2026-10-22T20-20-09-${DESKTOP}.jsonl`);
  const second = path.join(day2, `rollout-2026-10-22T20-43-24-${DESKTOP}_${SEGMENT}.jsonl`);
  await writeFile(
    first,
    jsonl(
      meta(DESKTOP, cwd),
      { type: "turn_context", payload: { cwd } },
      event("task_started"),
      user("# AGENTS.md instructions for /x\n<INSTRUCTIONS>别看</INSTRUCTIONS>"),
      user("<environment_context>\n  <cwd>/x</cwd>\n</environment_context>", "查一下重置卡几点过期，北京时间"),
      { type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "先看看文件" }], encrypted_content: "xxx" } },
      { type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "ls -la" }), call_id: "call_1" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output: "total 0" } },
      assistant("看完了。"),
      event("task_complete"),
    ),
  );
  await writeFile(
    second,
    jsonl(
      meta(DESKTOP, cwd, { history_base: { thread_id: DESKTOP } }),
      "{坏行",
      event("task_started"),
      user("\n# Files mentioned by the user:\n\n## a.png: /tmp/a.png\n\n## My request for Codex:\n再跑一下测试"),
      { type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** End Patch", call_id: "call_2" } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_2", output: [{ type: "input_text", text: "1 failed" }] } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "call_unknown", output: "没见过调用的结果" } },
    ),
  );
  await writeFile(
    path.join(day1, `rollout-2026-10-21T08-00-00-${CLI}.jsonl`),
    jsonl(meta(CLI, "/work/cli", { source: "cli", originator: "codex_cli_rs" }), user("随便问问"), assistant("好"), event("task_complete")),
  );
  await writeFile(path.join(day1, `rollout-2026-10-21T08-10-00-${EXEC}.jsonl`), jsonl(meta(EXEC, "/work/x", { source: "exec" }), user("codex exec 跑的")));
  await writeFile(path.join(day1, `rollout-2026-10-21T08-20-00-${SUB}.jsonl`), jsonl(meta(SUB, "/work/x", { source: { subagent: "x" }, thread_source: "subagent" }), user("子 agent")));
  await writeFile(path.join(day1, `rollout-2026-10-21T08-30-00-${OWN}.jsonl`), jsonl(meta(OWN, "/work/x", { originator: "LeoBot" }), user("LeoBot 开的")));
  await writeFile(path.join(day1, "rollout-2026-10-21T08-40-00-not-a-uuid.jsonl"), jsonl(meta("x", "/x"), user("x")));
  await writeFile(path.join(day1, `rollout-2026-10-21T08-50-00-${"019a0000-0000-7000-8000-000000000005"}.jsonl`), "{{{\nnot json\n");
  await writeFile(
    path.join(home, "session_index.jsonl"),
    jsonl({ id: DESKTOP, thread_name: "旧名字" }, { id: DESKTOP, thread_name: "查询重置卡过期时间" }, "{坏行"),
  );
  // 第二段 30 秒前写过且这一轮没完 = 正在跑;第一段与 CLI 会话都更早
  const now = Date.now();
  await utimes(first, new Date(now - 7_200_000), new Date(now - 7_200_000));
  await utimes(second, new Date(now - 90_000), new Date(now - 90_000));
  for (const id of [CLI, EXEC, SUB, OWN]) {
    const name = `rollout-2026-10-21T08-${{ [CLI]: "00", [EXEC]: "10", [SUB]: "20", [OWN]: "30" }[id]}-00-${id}.jsonl`;
    await utimes(path.join(day1, name), new Date(now - 86_400_000), new Date(now - 86_400_000));
  }
  return { root, home, cwd, first, second };
}

test("codex listing: threads merged across segments, index names win, exec / subagent / LeoBot / broken files left out, busy turn = running", async () => {
  const { root, home, cwd } = await fixture();
  try {
    const listed = await listCodexSessions(home);
    assert.deepEqual(
      listed.map((s) => [s.id, s.agent, s.cwd, s.title, s.running, s.busy]),
      [
        [DESKTOP, "codex", cwd, "查询重置卡过期时间", true, true],
        [CLI, "codex", "/work/cli", "随便问问", false, false],
      ],
    );
    assert.equal(listed[0]?.files?.length, 2);
    assert.match(listed[0]!.file, new RegExp(`${SEGMENT}\\.jsonl$`));
    // 线程打开着(写锁文件在):还开着,但这一轮没在跑
    await mkdir(path.join(home, "thread-writer-locks"), { recursive: true });
    await writeFile(path.join(home, "thread-writer-locks", `${CLI}.lock`), "");
    const cli = await findCodexSession(home, CLI);
    assert.equal(cli?.running, true);
    assert.equal(cli?.busy, false);
    assert.equal(await findCodexSession(home, EXEC), null, "exec 会话不能接管");
    assert.equal(await findCodexSession(home, "../../etc/passwd"), null);
    assert.deepEqual(await listCodexSessions(path.join(root, "missing")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codex listing: title falls back to the first real user message (context blocks skipped)", async () => {
  const { root, home } = await fixture();
  try {
    await rm(path.join(home, "session_index.jsonl"));
    const [desktop] = await listCodexSessions(home);
    assert.equal(desktop?.title, "查一下重置卡几点过期，北京时间");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codex listing: a long turn whose task_started is beyond the 64KB tail still counts as busy", async () => {
  const { root, home } = await fixture();
  try {
    const id = "019a0000-0000-7000-8000-000000000009";
    const output = { type: "response_item", payload: { type: "function_call_output", call_id: "c", output: "x".repeat(4096) } };
    const file = path.join(home, "sessions", "2026", "10", "22", `rollout-2026-10-22T21-00-00-${id}.jsonl`);
    await writeFile(file, jsonl(meta(id, "/work/long"), event("task_started"), user("跑个大测试"), ...Array.from({ length: 40 }, () => output)));
    const found = await findCodexSession(home, id);
    assert.equal(found?.busy, true);
    assert.equal(found?.running, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codex history: segments read in order, context blocks skipped, tools paired, orphan outputs dropped", async () => {
  const { root, first, second } = await fixture();
  try {
    const { events, truncated } = await readCodexHistory([first, second]);
    assert.equal(truncated, false);
    assert.deepEqual(
      events.map((e) => e.event),
      ["user.message", "reasoning.available", "tool.started", "tool.completed", "message.delta", "run.completed", "user.message", "tool.started", "tool.completed", "run.completed"],
    );
    assert.equal(events[0]?.["text"], "查一下重置卡几点过期，北京时间");
    assert.equal(events[1]?.["text"], "先看看文件");
    assert.equal(events[2]?.["tool"], "exec_command");
    assert.equal(events[2]?.["preview"], "ls -la");
    assert.deepEqual(events[2]?.["input"], { cmd: "ls -la" });
    assert.equal(events[3]?.["output"], "total 0");
    assert.equal(events[6]?.["text"], "再跑一下测试");
    assert.equal(events[7]?.["preview"], "*** Begin Patch");
    assert.equal(events[8]?.["output"], "1 failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fakeTasks() {
  const calls: [string, Record<string, unknown>][] = [];
  let next = 0;
  const service = {
    async createTask(params: Record<string, unknown>) {
      calls.push(["createTask", params]);
      next += 1;
      return { taskId: `task-${next}` };
    },
    async setMode() {},
    async sendPrompt() {},
    async listTaskList() {
      return { items: [], total: 0, hasMore: false };
    },
    onDynamicTaskEvent() {
      return () => ({ dispose: () => undefined });
    },
  };
  return { service: service as unknown as IZCodeTaskService, calls };
}

const req = (method: string, pathname: string, body?: unknown): LinkRequest => ({ method, path: pathname, body, caller: { kind: "iphone", deviceId: "dev" } });

test("codex takeover: listed beside Claude, ACP codex seeded with the thread id, history replayed, refused while Codex holds the writer lock", async () => {
  const { root, home, cwd } = await fixture();
  const acpSessionsPath = path.join(root, "acp-sessions.json");
  const tasks = fakeTasks();
  let held = true;
  const bridge = new LinkBridge({
    taskService: tasks.service,
    logger: { info() {}, warn() {} },
    push: () => undefined,
    appVersion: "test",
    journalDir: path.join(root, "journals"),
    leoagent: { url: "http://127.0.0.1:2", key: () => null },
    sshHostKeys: async () => [],
    acpAgents: () => [{ id: "codex", name: "Codex", harnessKey: "codex", available: true }],
    claudeProjectsDir: path.join(root, ".claude", "projects"),
    codexHome: home,
    codexLockHeld: async () => held,
    acpSessionsPath,
  });
  try {
    const caps = await bridge.handle(req("GET", "/v1/capabilities"));
    assert.equal((caps.body as { features: Record<string, unknown> }).features["external_sessions_codex"], true);
    const listed = (await bridge.handle(req("GET", "/harness/external-sessions"))).body as { sessions: Record<string, unknown>[] };
    assert.deepEqual(listed.sessions.map((s) => [s["id"], s["agent"], s["busy"]]), [[DESKTOP, "codex", true], [CLI, "codex", false]]);
    assert.equal(listed.sessions[0]?.["file"], undefined);
    assert.equal(listed.sessions[0]?.["files"], undefined, "不把 Mac 上的文件路径发给手机");

    const takeOver = (id: string) => bridge.handle(req("POST", "/harness/sessions", { resume_external: { agent: "codex", session_id: id } }));
    assert.equal((await bridge.handle(req("POST", "/harness/sessions", { resume_external: { agent: "gemini", session_id: CLI } }))).status, 501);
    assert.equal((await takeOver("nope")).status, 400);
    assert.equal((await takeOver(EXEC)).status, 404);

    // Codex 开着这个线程(写锁有人持有):拦下,不建任务
    await mkdir(path.join(home, "thread-writer-locks"), { recursive: true });
    await writeFile(path.join(home, "thread-writer-locks", `${DESKTOP}.lock`), "");
    const locked = await takeOver(DESKTOP);
    assert.equal(locked.status, 409);
    assert.match(JSON.stringify(locked.body), /先在 Mac 上退出 Codex/);
    assert.equal(tasks.calls.length, 0);

    // 锁是崩溃残留(没人持有):照常接管
    held = false;
    const created = await takeOver(DESKTOP);
    assert.equal(created.status, 202, JSON.stringify(created.body));
    const body = created.body as Record<string, unknown>;
    assert.equal(body["harness"], "codex");
    assert.equal(body["name"], "Codex");
    assert.equal(body["cwd"], cwd);
    assert.equal(body["title"], "查询重置卡过期时间");
    assert.equal(body["external_session_id"], DESKTOP);
    assert.deepEqual(tasks.calls[0]![1]["modelSelection"], { providerId: "acp", modelId: "codex", options: { reasoningLevel: "default" } });
    const state = JSON.parse(await readFile(acpSessionsPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(state["task-1"], { agentId: "codex", acpSessionId: DESKTOP });

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
    assert.deepEqual(events.map((e) => e.event).slice(0, 4), ["session.created", "session.note", "user.message", "reasoning.available"]);
    assert.match(String(events[1]?.["text"]), /Codex 会话/);
    assert.match(String(events.at(-1)?.["text"]), /先在 Mac 上退出 Codex/);

    const again = await takeOver(DESKTOP);
    assert.equal((again.body as Record<string, unknown>)["reused"], true);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});
