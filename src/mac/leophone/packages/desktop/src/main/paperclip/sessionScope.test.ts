import assert from "node:assert/strict";
import { test } from "node:test";
import { PAPERCLIP_DOWNLOAD_TIMEOUT_MS, PaperclipSessionScope } from "./sessionScope.js";

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

function identityProbe(userId = "human") {
  let calls = 0;
  const pending: Array<(value: string | null) => void> = [];
  return {
    calls: () => calls,
    probe: () => {
      calls += 1;
      return new Promise<string | null>((resolve) => pending.push(resolve));
    },
    settle: () => {
      for (const resolve of pending.splice(0)) resolve(userId);
    },
  };
}

test("five concurrent reads share one identity query and reuse it within the TTL", async () => {
  let now = 1_000;
  const scope = new PaperclipSessionScope(() => now);
  const identity = identityProbe();
  const reads = Array.from({ length: 5 }, () => scope.currentUser(identity.probe, false));
  identity.settle();
  assert.deepEqual(await Promise.all(reads), Array(5).fill("human"));
  assert.equal(identity.calls(), 1);
  now += 1_999;
  assert.equal(await scope.currentUser(identity.probe, false), "human");
  assert.equal(identity.calls(), 1);
  now += 1;
  const expired = scope.currentUser(identity.probe, false);
  identity.settle();
  assert.equal(await expired, "human");
  assert.equal(identity.calls(), 2, "expired confirmation must ask the server again");
});

test("writes always confirm identity freshly but may join an in-flight query", async () => {
  const scope = new PaperclipSessionScope(() => 0);
  const identity = identityProbe();
  const read = scope.currentUser(identity.probe, false);
  identity.settle();
  await read;
  const write = scope.currentUser(identity.probe, true);
  identity.settle();
  await write;
  assert.equal(identity.calls(), 2, "cached confirmation must not authorize a write");
  const firstWrite = scope.currentUser(identity.probe, true);
  const joinedWrite = scope.currentUser(identity.probe, true);
  const cachedRead = scope.currentUser(identity.probe, false);
  assert.equal(
    identity.calls(),
    3,
    "a second write joins the in-flight query instead of a new one",
  );
  identity.settle();
  assert.deepEqual(await Promise.all([firstWrite, joinedWrite, cachedRead]), [
    "human",
    "human",
    "human",
  ]);
  const another = scope.currentUser(identity.probe, true);
  assert.equal(identity.calls(), 4, "a later write never reuses the cached confirmation");
  identity.settle();
  await another;
});

test("invalidation and logout force a new identity query, even mid-flight", async () => {
  const scope = new PaperclipSessionScope(() => 0);
  const identity = identityProbe();
  const first = scope.currentUser(identity.probe, false);
  scope.invalidateIdentity();
  const second = scope.currentUser(identity.probe, false);
  assert.equal(identity.calls(), 2, "a query started before invalidation cannot be joined");
  identity.settle();
  await Promise.all([first, second]);
  const cached = scope.currentUser(identity.probe, false);
  assert.equal(identity.calls(), 2);
  await cached;
  scope.invalidateIdentity();
  const afterInvalidate = scope.currentUser(identity.probe, false);
  assert.equal(identity.calls(), 3);
  identity.settle();
  await afterInvalidate;
  await scope.beginSignOut();
  scope.finishSignOut();
  const afterLogout = scope.currentUser(identity.probe, false);
  assert.equal(identity.calls(), 4, "logout must drop the cached identity");
  identity.settle();
  await afterLogout;
});

test("an identity query started before invalidation does not refill the cache", async () => {
  const scope = new PaperclipSessionScope(() => 0);
  const identity = identityProbe("old-human");
  const stale = scope.currentUser(identity.probe, false);
  scope.invalidateIdentity();
  identity.settle();
  assert.equal(await stale, "old-human");
  const next = scope.currentUser(identity.probe, false);
  assert.equal(identity.calls(), 2);
  identity.settle();
  await next;
});

test("downloads get a longer timeout than ordinary API requests", async () => {
  const scope = new PaperclipSessionScope();
  assert.ok(PAPERCLIP_DOWNLOAD_TIMEOUT_MS >= 10 * 60_000);
  await assert.rejects(
    scope.run(
      (signal) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
      false,
      5,
    ),
    /timeout|TimeoutError|aborted/i,
  );
});
