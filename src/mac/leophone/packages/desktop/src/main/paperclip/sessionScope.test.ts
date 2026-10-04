import assert from "node:assert/strict";
import { test } from "node:test";
import { PaperclipSessionScope } from "./sessionScope.js";

test("logout waits for late response and rejects it before cookies are cleared", async () => {
  const scope = new PaperclipSessionScope();
  let release!: () => void;
  const events: string[] = [];
  const response = scope.run(async (signal) => {
    signal.addEventListener("abort", () => events.push("aborted"));
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    events.push("late-response");
    return "stale-session";
  });
  const rejected = assert.rejects(response, /会话已更改/);
  const logout = scope.beginSignOut().then(() => events.push("safe-to-clear-cookies"));
  assert.equal(scope.generation, 1);
  assert.deepEqual(events, ["aborted"]);
  await assert.rejects(
    scope.run(async () => "new-request"),
    /正在退出/,
  );
  release();
  await Promise.all([rejected, logout]);
  assert.deepEqual(events, ["aborted", "late-response", "safe-to-clear-cookies"]);
  await scope.run(async () => "server-signout", true);
  scope.finishSignOut();
  assert.equal(await scope.run(async () => "new-session"), "new-session");
});

test("one origin logout does not cancel another origin and duplicate logout is rejected", async () => {
  const a = new PaperclipSessionScope();
  const b = new PaperclipSessionScope();
  await a.beginSignOut();
  await assert.rejects(a.beginSignOut(), /正在退出/);
  assert.equal(await b.run(async () => "unaffected"), "unaffected");
  a.finishSignOut();
});
