import assert from "node:assert/strict";
import test from "node:test";

import type { ZCodeTaskMeta } from "@zcode/shared";

import { classifyLeoStatusRows } from "../src/leo/leoStatusRows.js";
import { attachTaskListRowActivity } from "../src/v4/taskListRowActivity.js";

function task(taskId: string, extra: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId,
    title: taskId,
    workspacePath: "/tmp/p",
    createdAt: 1,
    updatedAt: 1,
    status: "completed",
    ...extra,
  } as ZCodeTaskMeta;
}

test("home status list: needs-you first, then running, then finished-unread; read idle tasks stay off", () => {
  const idle = task("idle");
  const unread = task("unread", { unreadAt: 5 } as Partial<ZCodeTaskMeta>);
  const running = attachTaskListRowActivity(task("running"), {
    phase: "running",
    lastActivityAt: 9,
    hasBackgroundWork: false,
  });
  const background = attachTaskListRowActivity(task("background"), {
    phase: "completedSuccess",
    lastActivityAt: 8,
    hasBackgroundWork: true,
  });
  const approval = attachTaskListRowActivity(task("approval"), {
    phase: "running",
    lastActivityAt: 7,
    hasBackgroundWork: false,
    pendingInteractions: { permissionCount: 1, userInputCount: 0 },
  } as never);
  const question = attachTaskListRowActivity(task("question"), {
    phase: "running",
    lastActivityAt: 6,
    hasBackgroundWork: false,
    pendingInteractions: { permissionCount: 0, userInputCount: 1 },
  } as never);

  const rows = classifyLeoStatusRows([idle, unread, running, background, approval, question]);
  assert.deepEqual(
    rows.map((row) => [row.task.taskId, row.state, row.label]),
    [
      ["approval", "attention", "等你确认"],
      ["question", "attention", "等你回答"],
      ["running", "running", "在跑"],
      ["background", "running", "在跑"],
      ["unread", "done", "做完待看"],
    ],
  );
});

test("home status list is empty when nothing needs attention", () => {
  assert.deepEqual(classifyLeoStatusRows([task("a"), task("b")]), []);
});
