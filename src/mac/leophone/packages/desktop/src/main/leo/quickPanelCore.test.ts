import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildQuickTrayMenu,
  computeQuickPanelBounds,
  DEFAULT_QUICK_ACCELERATOR,
  formatAcceleratorLabel,
  nextSummaryPollDelay,
  parseQuickEntrySettings,
  trayTitle,
  validateQuickAccelerator,
  type QuickSummaryView,
} from "./quickPanelCore.js";

test("accelerators are normalized to Electron's modifier order", () => {
  assert.deepEqual(validateQuickAccelerator("alt+space"), { ok: true, accelerator: "Alt+Space" });
  assert.deepEqual(validateQuickAccelerator("Shift + Ctrl + Option + l"), {
    ok: true,
    accelerator: "Control+Alt+Shift+L",
  });
  assert.deepEqual(validateQuickAccelerator("Cmd+Shift+Alt+K"), { ok: true, accelerator: "Command+Alt+Shift+K" });
  assert.deepEqual(validateQuickAccelerator("F5"), { ok: true, accelerator: "F5" });
  assert.deepEqual(validateQuickAccelerator("Alt+Plus"), { ok: true, accelerator: "Alt+Plus" });
  assert.deepEqual(validateQuickAccelerator("Control+/"), { ok: true, accelerator: "Control+/" });
});

test("accelerators that would swallow normal typing or are malformed are rejected", () => {
  for (const raw of ["", "   ", "Space", "Shift+A", "A", "Alt", "Alt+A+B", "Alt++", "Alt+Ä", "Hyper+A", 42, null]) {
    assert.equal(validateQuickAccelerator(raw).ok, false, String(raw));
  }
  assert.equal(validateQuickAccelerator("Command+CommandOrControl+A").ok, false);
});

test("system shortcuts and plain ⌘-letter combos are refused even though globalShortcut would take them", () => {
  for (const raw of ["Cmd+Space", "Ctrl+Space", "Command+Tab", "Command+Shift+4", "Command+Control+Space", "Cmd+C", "Cmd+Shift+N", "CmdOrCtrl+K"]) {
    assert.equal(validateQuickAccelerator(raw).ok, false, raw);
  }
  assert.deepEqual(validateQuickAccelerator("Cmd+Alt+K"), { ok: true, accelerator: "Command+Alt+K" });
  assert.deepEqual(validateQuickAccelerator("Cmd+Shift+F5"), { ok: true, accelerator: "Command+Shift+F5" });
});

test("labels use macOS symbols", () => {
  assert.equal(formatAcceleratorLabel("Alt+Space"), "⌥Space");
  assert.equal(formatAcceleratorLabel("Control+Alt+L"), "⌃⌥L");
  assert.equal(formatAcceleratorLabel("Command+Shift+Plus"), "⌘⇧Plus");
});

test("settings default on and fall back to ⌥Space when the stored accelerator is invalid", () => {
  assert.deepEqual(parseQuickEntrySettings(undefined), {
    menuBarEnabled: true,
    quickPanelEnabled: true,
    accelerator: DEFAULT_QUICK_ACCELERATOR,
  });
  assert.deepEqual(parseQuickEntrySettings({ menuBarEnabled: false, accelerator: "Shift+A" }), {
    menuBarEnabled: false,
    quickPanelEnabled: true,
    accelerator: DEFAULT_QUICK_ACCELERATOR,
  });
  assert.equal(parseQuickEntrySettings({ accelerator: "ctrl+alt+l" }).accelerator, "Control+Alt+L");
});

const primary = { bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 38, width: 1512, height: 944 } };
const external = {
  bounds: { x: 1512, y: -200, width: 2560, height: 1440 },
  workArea: { x: 1512, y: -175, width: 2560, height: 1415 },
};

test("panel goes to the display under the mouse, centered, in the upper third", () => {
  const onPrimary = computeQuickPanelBounds({ x: 100, y: 500 }, [primary, external]);
  assert.deepEqual(onPrimary, { x: 436, y: 289, width: 640, height: 128 });
  const onExternal = computeQuickPanelBounds({ x: 3000, y: 900 }, [primary, external]);
  assert.equal(onExternal.x, 1512 + (2560 - 640) / 2);
  assert.equal(onExternal.y, Math.round(-175 + 1415 / 3 - 64));
});

test("panel falls back to the nearest display and never leaves the work area", () => {
  // 鼠标在两块屏之间的缝里(外接屏顶部之上)。
  const gap = computeQuickPanelBounds({ x: 2000, y: -500 }, [primary, external]);
  assert.ok(gap.x >= 1512);
  const tiny = { bounds: { x: 0, y: 0, width: 500, height: 100 }, workArea: { x: 0, y: 20, width: 500, height: 80 } };
  assert.deepEqual(computeQuickPanelBounds({ x: 10, y: 10 }, [tiny]), { x: 0, y: 20, width: 500, height: 80 });
  assert.deepEqual(computeQuickPanelBounds({ x: 1, y: 1 }, []), { x: 0, y: 0, width: 640, height: 128 });
});

const row = (taskId: string, state: "waiting" | "running" | "done" | "idle", title = `任务 ${taskId}`) => ({
  taskId,
  title,
  workspacePath: "/Users/me/code/leophone-mac",
  state,
  updatedAt: 1,
});

test("tray title and poll cadence follow running / waiting work", () => {
  const busy: QuickSummaryView = { waiting: [], running: [row("a", "running"), row("b", "running")], recent: [], workspaces: [] };
  const quiet: QuickSummaryView = { waiting: [], running: [], recent: [row("c", "done")], workspaces: [] };
  assert.equal(trayTitle(busy), "2");
  assert.equal(trayTitle(quiet), "");
  assert.equal(trayTitle(null), "");
  assert.equal(nextSummaryPollDelay(busy), 8_000);
  assert.equal(nextSummaryPollDelay({ ...quiet, waiting: [row("w", "waiting")] }), 8_000);
  assert.equal(nextSummaryPollDelay(quiet), 15_000);
  assert.equal(nextSummaryPollDelay(null), 10_000);
});

test("tray menu: approvals first, running, then recent without duplicates", () => {
  const summary: QuickSummaryView = {
    waiting: [row("w", "waiting")],
    running: [row("r", "running", "一个非常非常长的任务标题，用来确认菜单里会被截断而不是撑满整块屏幕宽度的那种")],
    recent: [row("r", "running"), row("d", "done"), row("w", "waiting")],
    workspaces: [],
  };
  const menu = buildQuickTrayMenu(summary, { accelerator: "Alt+Space", quickPanelEnabled: true });
  assert.deepEqual(
    menu.map((item) => (item.kind === "task" ? `task:${item.taskId}` : item.kind === "header" ? item.label : item.kind)),
    ["待审批 1", "task:w", "运行中 1", "task:r", "最近", "task:d", "separator", "new-task", "open-app", "separator", "quit"],
  );
  const waitingRow = menu[1];
  assert.ok(waitingRow?.kind === "task" && waitingRow.label.endsWith("leophone-mac · 等你确认"));
  const longRow = menu[3];
  assert.ok(longRow?.kind === "task" && longRow.label.includes("…"));
});

test("tray menu without host data shows one line, and hides 新任务 when the panel is off", () => {
  const menu = buildQuickTrayMenu(null, { quickPanelEnabled: false, hostError: "本机 Leo 服务还没启动" });
  assert.deepEqual(menu[0], { kind: "info", label: "读不到任务：本机 Leo 服务还没启动" });
  assert.equal(menu.some((item) => item.kind === "new-task"), false);
});
