import assert from "node:assert/strict";
import test from "node:test";

import type { ZCodeAutomation, ZCodeAutomationRun } from "@zcode/shared";

import { onAutomationRunCompleted, publishAutomationRunCompleted } from "./automationEvents.js";
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
    trigger: "schedule",
    error: null,
  });
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
