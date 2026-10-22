import assert from "node:assert/strict";
import test from "node:test";

import type { ZCodeAutomation, ZCodeAutomationRun } from "@zcode/shared";

import { LEO_AUTOMATION_TEMPLATES } from "@zcode/shared/leo-automation-templates";

import {
  failAutomationRun,
  onAutomationRunCompleted,
  onAutomationRunStarted,
  publishAutomationRunCompleted,
  publishAutomationRunStarted,
  takeAutomationRunFailure,
} from "./automationEvents.js";
import {
  AutomationResults,
  finalReplyText,
  plainSummary,
  RESULT_SUMMARY_MAX,
  runSummary,
} from "./automationResults.js";
import {
  automationView,
  describeSchedule,
  parseCreate,
  parsePatch,
  parseSchedule,
  patchNeedsFullAuto,
} from "./automationPayload.js";
import { isLinkPath } from "./linkPolicy.js";

// 本地时区 2026-10-22 08:30:15 星期四。
const now = new Date(2026, 9, 22, 8, 30, 15);

test("automations: link path whitelist", () => {
  for (const ok of ["/automations", "/automations/automation-1", "/automations/automation-1/run"])
    assert.equal(isLinkPath(ok), true, ok);
  for (const bad of [
    "/automations/",
    "/automations/a/b",
    "/automations/a/runs",
    "/automations/a/run/x",
    "/automationsx",
  ])
    assert.equal(isLinkPath(bad), false, bad);
});

test("automations: schedule conversion to Mac-local cron", () => {
  assert.deepEqual(parseSchedule("0 9 * * 1-5", now), { cronExpr: "0 9 * * 1-5", recurring: true });
  assert.deepEqual(parseSchedule({ cron: " */30  * * * * " }, now), {
    cronExpr: "*/30 * * * *",
    recurring: true,
  });
  assert.deepEqual(parseSchedule({ kind: "daily", time: "09:05" }, now), {
    cronExpr: "5 9 * * *",
    recurring: true,
  });
  assert.deepEqual(parseSchedule({ kind: "weekly", time: "7:00", weekday: 0 }, now), {
    cronExpr: "0 7 * * 0",
    recurring: true,
  });
  assert.deepEqual(parseSchedule({ kind: "weekly", time: "18:30", weekdays: [5, 1, 3, 1] }, now), {
    cronExpr: "30 18 * * 1,3,5",
    recurring: true,
  });
  assert.deepEqual(parseSchedule({ kind: "hourly", minute: 15 }, now), {
    cronExpr: "15 * * * *",
    recurring: true,
  });
  assert.deepEqual(parseSchedule({ kind: "hourly", time: "00:45" }, now), {
    cronExpr: "45 * * * *",
    recurring: true,
  });
  assert.deepEqual(parseSchedule({ kind: "hourly" }, now), {
    cronExpr: "0 * * * *",
    recurring: true,
  });
  assert.deepEqual(parseSchedule({ kind: "once", date: "2026-10-23", time: "09:00" }, now), {
    cronExpr: "0 9 23 10 *",
    recurring: false,
  });
  // 不带时区的 ISO 按 Mac 本地;秒截掉。
  assert.deepEqual(parseSchedule({ kind: "once", at: "2026-10-22T08:45:59" }, now), {
    cronExpr: "45 8 22 10 *",
    recurring: false,
  });
  const utc = new Date(Date.UTC(2026, 9, 25, 1, 0));
  assert.deepEqual(parseSchedule({ kind: "once", at: utc.toISOString() }, now), {
    cronExpr: `0 ${utc.getHours()} ${utc.getDate()} ${utc.getMonth() + 1} *`,
    recurring: false,
  });
});

test("automations: schedule conversion rejects bad input", () => {
  const bad: unknown[] = [
    "0 9 * *",
    "0 9 * * * *",
    "rm -rf / * * *",
    { kind: "daily", time: "24:00" },
    { kind: "daily", time: "9" },
    { kind: "daily" },
    { kind: "weekly", time: "09:00" },
    { kind: "weekly", time: "09:00", weekday: 7 },
    { kind: "weekly", time: "09:00", weekdays: [] },
    { kind: "hourly", minute: 60 },
    { kind: "once", at: "not a date" },
    { kind: "once", at: "2026-10-22T08:30:00" }, // 截到分钟后不晚于现在
    { kind: "once", at: "2027-12-01T09:00:00" }, // 超过 365 天
    { kind: "once", date: "2026-02-30", time: "09:00" },
    { kind: "monthly", time: "09:00" },
    42,
    null,
  ];
  for (const value of bad) assert.ok("error" in parseSchedule(value, now), JSON.stringify(value));
  assert.ok(
    "error" in
      parseSchedule({ kind: "once", date: "2026-10-23", time: "09:00" }, now, { allowOnce: false }),
  );
});

function automation(overrides: Partial<ZCodeAutomation> = {}): ZCodeAutomation {
  return {
    automationId: "automation-1",
    title: "日报",
    cronExpr: "0 9 * * *",
    prompt: "汇总昨天的提交",
    workspaceKey: "/w",
    workspacePath: "/w",
    locationKind: "local",
    recurring: true,
    runCount: 2,
    enabled: true,
    lifecycleStatus: "active",
    nextRunAt: 1_761_267_600_000,
    dispatchStatus: "idle",
    dispatchAttempts: 0,
    createdAt: 1_761_000_000_000,
    updatedAt: 1_761_000_000_000,
    ...overrides,
  };
}

test("automations: human schedule description", () => {
  const describe = (cronExpr: string, recurring = true) =>
    describeSchedule({ cronExpr, recurring });
  assert.deepEqual(describe("0 9 * * *"), {
    cron: "0 9 * * *",
    recurring: true,
    kind: "daily",
    human: "每天 09:00",
    time: "09:00",
  });
  assert.equal(describe("30 18 * * 1-5").human, "工作日 18:30");
  assert.deepEqual(describe("0 7 * * 1,3").weekdays, [1, 3]);
  assert.equal(describe("0 7 * * 1,3").human, "每周一、三 07:00");
  assert.equal(describe("0 10 * * 6,7").human, "周末 10:00");
  assert.equal(describe("15 * * * *").human, "每小时第 15 分");
  assert.equal(describe("0 * * * *").human, "每小时整点");
  assert.equal(describe("0 9 23 10 *", false).human, "10月23日 09:00（一次）");
  assert.equal(describe("0 9 23 10 *", false).kind, "once");
  assert.equal(describe("*/10 * * * *").human, "每 10 分钟");
  assert.deepEqual(describe("0 9 1 * *"), {
    cron: "0 9 1 * *",
    recurring: true,
    kind: "cron",
    human: "cron：0 9 1 * *",
  });
  const custom = describeSchedule({
    cronExpr: "0 9 * * *",
    recurring: true,
    scheduleRule: { unit: "daily", interval: 2, hour: 9, minute: 0, anchorAt: 0 },
  });
  assert.deepEqual([custom.kind, custom.human], ["custom", "每 2 天 09:00"]);
});

test("automations: view picks the latest run and maps statuses", () => {
  const run = (overrides: Partial<ZCodeAutomationRun>): ZCodeAutomationRun => ({
    runId: "r",
    automationId: "automation-1",
    workspaceKey: "/w",
    trigger: "schedule",
    dispatchStatus: "dispatched",
    attempts: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });
  const view = automationView(automation({ mode: "build" }), [
    run({ runId: "old", outcome: "failed", createdAt: 1_000, updatedAt: 2_000 }),
    run({
      runId: "new",
      outcome: "succeeded",
      sessionId: "task-9",
      createdAt: 5_000,
      updatedAt: 9_000,
    }),
  ]);
  assert.deepEqual(view.last_run, {
    status: "succeeded",
    at: 9,
    task_id: "task-9",
    session_id: "task-9",
    trigger: "schedule",
    error: null,
    // 成功但没记下摘要(别的窗口 / 升级前跑的):不冷恢复会话去读,给 null。
    summary: null,
  });
  const runs = [run({ runId: "new", outcome: "succeeded", sessionId: "task-9" })];
  assert.equal(automationView(automation(), runs, "写好了日报").last_run?.summary, "写好了日报");
  assert.equal(
    automationView(automation(), [run({ outcome: "failed", error: "x".repeat(400) })]).last_run?.summary?.length,
    RESULT_SUMMARY_MAX,
    "没记下的失败按运行记录现算,同样 ≤280",
  );
  assert.equal(automationView(automation(), [run({ outcome: "stopped" })]).last_run?.summary, "运行被停止");
  assert.equal(view.next_run_at, 1_761_267_600);
  assert.equal(view.mode, "build");
  assert.equal(view.schedule.human, "每天 09:00");
  assert.equal(
    automationView(automation(), [run({ dispatchStatus: "failed_to_dispatch", error: "no model" })])
      .last_run?.status,
    "dispatch_failed",
  );
  assert.equal(
    automationView(automation(), [run({ dispatchStatus: "claimed" })]).last_run?.status,
    "pending",
  );
  assert.equal(automationView(automation(), []).last_run, null);
  // 暂停的不报下次时间。
  assert.equal(automationView(automation({ enabled: false }), []).next_run_at, null);
  assert.equal(automationView(automation(), []).mode, null);
});

test("automations: create payload validation and defaults", () => {
  const ok = parseCreate(
    {
      prompt: "  每天汇总一下\n昨天的提交，然后发给我看看有没有问题  ",
      schedule: { kind: "daily", time: "09:00" },
    },
    now,
  );
  assert.ok(!("error" in ok));
  assert.equal(ok.name, "每天汇总一下 昨天的提交，然后发给我看看有没有问题".slice(0, 30));
  assert.deepEqual([ok.workspace, ok.harness, ok.mode], ["", "zcode", "build"]);
  const full = parseCreate(
    { prompt: "x", name: "N", schedule: "0 9 * * *", cwd: " /tmp ", full_auto: true },
    now,
  );
  assert.ok(!("error" in full));
  assert.deepEqual([full.name, full.workspace, full.mode], ["N", "/tmp", "yolo"]);
  // 显式 mode 优先于 full_auto。
  const explicit = parseCreate(
    { prompt: "x", schedule: "0 9 * * *", full_auto: true, mode: "plan" },
    now,
  );
  assert.ok(!("error" in explicit) && explicit.mode === "plan");
  for (const body of [
    { schedule: "0 9 * * *" },
    { prompt: "   ", schedule: "0 9 * * *" },
    { prompt: "x" },
    { prompt: "x", schedule: "0 9 * * *", mode: "ask" },
    { prompt: "x", schedule: "0 9 * * *", workspace: 3 },
    { prompt: "x", schedule: "0 9 * * *", name: "n".repeat(101) },
    { prompt: "x".repeat(20_001), schedule: "0 9 * * *" },
    "not an object",
  ])
    assert.ok("error" in parseCreate(body, now), JSON.stringify(body).slice(0, 80));
});

test("automations: patch payload validation", () => {
  assert.deepEqual(parsePatch({ enabled: false }, now), { enabled: false });
  assert.deepEqual(parsePatch({ name: " 新名字 ", schedule: { kind: "hourly", minute: 5 } }, now), {
    name: "新名字",
    schedule: { cronExpr: "5 * * * *", recurring: true },
  });
  for (const body of [
    {},
    { enabled: "yes" },
    { mode: "auto" },
    { schedule: { kind: "once", date: "2026-10-23", time: "09:00" } },
    { name: "" },
  ])
    assert.ok("error" in parsePatch(body, now), JSON.stringify(body));
});

test("automations: full-auto caller rule for patches", () => {
  assert.equal(patchNeedsFullAuto("build", { mode: "yolo" }), true);
  assert.equal(patchNeedsFullAuto("yolo", { prompt: "x" }), true);
  assert.equal(
    patchNeedsFullAuto("yolo", { schedule: { cronExpr: "0 9 * * *", recurring: true } }),
    true,
  );
  assert.equal(patchNeedsFullAuto("yolo", { enabled: true }), true);
  // 改名、停用、降级模式只会更安全。
  assert.equal(patchNeedsFullAuto("yolo", { name: "x" }), false);
  assert.equal(patchNeedsFullAuto("yolo", { enabled: false }), false);
  assert.equal(patchNeedsFullAuto("yolo", { mode: "build", prompt: "x" }), false);
  assert.equal(patchNeedsFullAuto(undefined, { prompt: "x", enabled: true }), false);
});

test("automations: run-completed broadcast survives a throwing subscriber and stops after unsubscribe", () => {
  const seen: string[] = [];
  const offBad = onAutomationRunCompleted(() => {
    throw new Error("subscriber bug");
  });
  const offGood = onAutomationRunCompleted((run) => seen.push(run.runId));
  const run = {
    automationId: "a",
    runId: "a:1",
    trigger: "schedule",
    outcome: "succeeded",
    taskId: "t",
    workspacePath: "/w",
  } as const;
  publishAutomationRunCompleted(run);
  offGood();
  offBad();
  publishAutomationRunCompleted({ ...run, runId: "a:2" });
  assert.deepEqual(seen, ["a:1"]);
});

test("automations: run summary strips markdown, collapses whitespace and caps at 280 chars", () => {
  assert.equal(
    plainSummary("# 早报\n\n- **完成** 了 `lint` 修复\n- 见 [PR](https://x/1)\n\n> 引用  内容\n1. 第一 *条*"),
    "早报 完成 了 lint 修复 见 PR 引用 内容 第一 条",
  );
  assert.equal(plainSummary("snake_case_name 和 a*b 不动"), "snake_case_name 和 a*b 不动");
  assert.equal(plainSummary("```ts\nconst a = 1;\n```\n| a | b |"), "const a = 1; a b");
  const long = plainSummary("字".repeat(500));
  assert.equal(Array.from(long).length, RESULT_SUMMARY_MAX);
  assert.ok(long.endsWith("…"));
  // 按字符截:不把 emoji 劈成半个代理对。
  const emoji = plainSummary("😀".repeat(300));
  assert.equal(Array.from(emoji).length, RESULT_SUMMARY_MAX);
  assert.ok(!emoji.includes("\uFFFD"));
  assert.equal(plainSummary("短的"), "短的");

  assert.equal(runSummary("succeeded", undefined, "**今天** 要做 3 件事"), "今天 要做 3 件事");
  assert.equal(runSummary("succeeded", undefined, null), "已在 Mac 上跑完");
  assert.equal(runSummary("stopped", "ignored", "ignored"), "运行被停止");
  assert.equal(runSummary("failed", "  ", null), "运行失败");
  assert.equal(Array.from(runSummary("failed", "e".repeat(1000), null)).length, RESULT_SUMMARY_MAX);
});

test("automations: final reply is the text after the last tool call of the last assistant message", () => {
  const msg = (overrides: Record<string, unknown>) =>
    ({ role: "assistant", content: "", timestamp: 1, ...overrides }) as never;
  assert.equal(
    finalReplyText([
      msg({ role: "user", content: "跑一下" }),
      msg({
        content: "先看看 读到了 结论",
        parts: [
          { type: "content", content: "先看看" },
          { type: "tool-call", toolIndex: 0 },
          { type: "thought", content: "思考不算" },
          { type: "content", content: "结论：一切正常" },
        ],
        tools: [{ output: "SECRET=1" }],
      }),
    ]),
    "结论：一切正常",
  );
  // 最后一次工具调用之后没正文(被打断):退回最后一段正文。
  assert.equal(
    finalReplyText([
      msg({ parts: [{ type: "content", content: "中间说明" }, { type: "tool-call", toolIndex: 0 }] }),
    ]),
    "中间说明",
  );
  assert.equal(finalReplyText([msg({ content: " 老格式整条 " })]), "老格式整条");
  assert.equal(finalReplyText([msg({}), msg({ role: "user", content: "还没回复" })]), null);
  assert.equal(finalReplyText([]), null);
  assert.equal(finalReplyText([msg({ parts: [{ type: "tool-call", toolIndex: 0 }] })]), null);
});

test("automations: results are remembered per run and survive a restart", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-results-"));
  try {
    const file = path.join(dir, "automation-results.json");
    const first = new AutomationResults(file);
    await first.set("a:1", "摘要一");
    await first.set("a:2", "摘要二");
    const reopened = new AutomationResults(file);
    assert.equal(await reopened.get("a:1"), "摘要一");
    assert.equal(await reopened.get("a:2"), "摘要二");
    assert.equal(await reopened.get("a:3"), undefined);
    for (let index = 0; index < 205; index += 1) await reopened.set(`b:${index}`, "x");
    assert.equal(await reopened.get("a:1"), undefined, "只留最近 200 次");
    assert.equal(await reopened.get("b:204"), "x");
    assert.equal(await new AutomationResults(null).get("a:1"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("automations: run-started broadcast and the one-shot failure override", () => {
  const seen: string[] = [];
  const off = onAutomationRunStarted((run) => seen.push(run.runId));
  publishAutomationRunStarted({
    automationId: "a",
    runId: "a:1",
    trigger: "manual",
    taskId: "t",
    workspacePath: "/w",
  });
  off();
  publishAutomationRunStarted({ automationId: "a", runId: "a:2", trigger: "manual", taskId: "t", workspacePath: "/w" });
  assert.deepEqual(seen, ["a:1"]);

  assert.equal(takeAutomationRunFailure("a:1"), undefined);
  failAutomationRun("a:1", "审批超时");
  assert.equal(takeAutomationRunFailure("a:1"), "审批超时");
  assert.equal(takeAutomationRunFailure("a:1"), undefined, "取一次就清掉");
});

test("automations: built-in templates use editor-friendly cron and the brief uses leo-brain read-only", () => {
  const brief = LEO_AUTOMATION_TEMPLATES.find((template) => template.id === "leo-daily-brief");
  assert.ok(brief);
  assert.equal(brief.title.cn, "每日早报");
  assert.equal(brief.mode, "plan");
  for (const text of [brief.prompt.cn, brief.prompt.en]) {
    assert.match(text, /brain_brief/);
    assert.match(text, /brain_search/);
    assert.match(text, /3–5/);
  }
  assert.match(brief.prompt.cn, /不读日历/, "日历要系统授权(TCC),早报不碰");
  for (const template of LEO_AUTOMATION_TEMPLATES)
    assert.equal(describeSchedule({ cronExpr: template.cronExpr, recurring: true }).kind === "cron", false);
});
