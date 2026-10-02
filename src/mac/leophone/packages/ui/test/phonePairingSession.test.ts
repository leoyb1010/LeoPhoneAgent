import assert from "node:assert/strict";
import test from "node:test";
import { createPhonePairingSession, type PairingResult } from "../src/leo/phonePairingSession.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const code = (payload = "synthetic"): PairingResult => ({
  ok: true,
  data: { payload, machine: "fixture", exp: 1_900_000_000 },
});
function fixture() {
  const request = deferred<PairingResult>();
  const rendered = deferred<string>();
  const revoked: string[] = [],
    pending: boolean[] = [],
    errors: Array<string | null> = [];
  const shown: unknown[] = [],
    warnings: unknown[] = [];
  let issues = 0,
    failRevoke = false;
  const session = createPhonePairingSession({
    issue: async () => {
      issues++;
      return request.promise;
    },
    revoke: async (payload) => {
      if (failRevoke) return { ok: false, error: "offline" };
      revoked.push(payload);
      return { ok: true, data: null };
    },
    render: () => rendered.promise,
    onCode: (value) => shown.push(value),
    onPending: (value) => pending.push(value),
    onError: (value) => errors.push(value),
    onCleanupError: () => warnings.push("cleanup failed"),
  });
  return {
    session,
    request,
    rendered,
    revoked,
    pending,
    errors,
    shown,
    warnings,
    get issues() {
      return issues;
    },
    failRevoke() {
      failRevoke = true;
    },
    recover() {
      failRevoke = false;
    },
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("closing while issuance is pending revokes the late code without publishing", async () => {
  const f = fixture();
  const done = f.session.generate(false);
  await tick();
  f.session.dispose();
  f.request.resolve(code());
  await done;
  assert.deepEqual(f.revoked, ["synthetic"]);
  assert.deepEqual(f.shown, [null]);
  assert.deepEqual(f.pending, [true]);
});

test("closing during QR rendering revokes the issued code and ignores the late image", async () => {
  const f = fixture();
  const done = f.session.generate(true);
  f.request.resolve(code());
  await tick();
  f.session.dispose();
  f.rendered.resolve("data:image/synthetic");
  await done;
  await tick();
  assert.ok(f.revoked.includes("synthetic"));
  assert.deepEqual(f.shown, [null]);
});

test("repeated clicks share one issuance before React can render disabled state", async () => {
  const f = fixture();
  const first = f.session.generate(false);
  const second = f.session.generate(true);
  f.request.resolve(code());
  f.rendered.resolve("image");
  await Promise.all([first, second]);
  assert.equal(f.issues, 1);
  assert.equal(f.shown.length, 2);
  assert.deepEqual(f.pending, [true, false]);
});

test("QR rendering failure revokes invisible credential and permits retry", async () => {
  const f = fixture();
  const done = f.session.generate(false);
  f.request.resolve(code());
  f.rendered.reject(new Error("QR failure"));
  await done;
  assert.deepEqual(f.revoked, ["synthetic"]);
  assert.equal(f.shown.length, 1);
  assert.ok(f.errors.at(-1));
  assert.equal(f.pending.at(-1), false);
});

test("replacement clears old image and stops issuance until failed revocation retries", async () => {
  const f = fixture();
  f.request.resolve(code());
  f.rendered.resolve("image");
  await f.session.generate(false);
  f.failRevoke();
  await f.session.generate(false);
  assert.equal(f.issues, 1);
  assert.equal(f.shown.at(-1), null);
  assert.match(f.errors.at(-1)!, /撤销/);
  f.recover();
  await f.session.generate(false);
  assert.equal(f.issues, 2);
  assert.deepEqual(f.revoked, ["synthetic"]);
});

test("closed owner cannot publish into a reopened panel", async () => {
  const old = fixture(),
    fresh = fixture();
  const stale = old.session.generate(false);
  await tick();
  old.session.dispose();
  fresh.request.resolve(code("new"));
  fresh.rendered.resolve("new-image");
  await fresh.session.generate(true);
  old.request.resolve(code("old"));
  await stale;
  assert.deepEqual(old.revoked, ["old"]);
  assert.equal((fresh.shown.at(-1) as { image: string }).image, "new-image");
});

test("issuance errors clear pending and surface the existing IPC error", async () => {
  const f = fixture();
  f.request.resolve({ ok: false, error: "not connected" });
  await f.session.generate(false);
  assert.equal(f.errors.at(-1), "not connected");
  assert.deepEqual(f.pending, [true, false]);
  assert.deepEqual(f.revoked, []);
});

test("cleanup errors are contained after panel close", async () => {
  const f = fixture();
  f.request.resolve(code());
  f.rendered.resolve("image");
  await f.session.generate(false);
  f.failRevoke();
  f.session.dispose();
  await tick();
  assert.equal(f.warnings.length, 1);
  assert.equal(f.errors.at(-1), null);
});

test("legacy bridges without revoke retain issuance and expiry compatibility", async () => {
  let shown: unknown;
  const session = createPhonePairingSession({
    issue: async () => code(),
    render: async () => "image",
    onCode: (value) => {
      shown = value;
    },
    onPending: () => {},
    onError: () => {},
    onCleanupError: () => {},
  });
  await session.generate(false);
  assert.equal((shown as { image: string }).image, "image");
  session.dispose();
});

test("close while replacement revoke is pending prevents a second issuance", async () => {
  const revocation = deferred<{ ok: true; data: unknown }>();
  let issues = 0;
  const shown: unknown[] = [];
  const session = createPhonePairingSession({
    issue: async () => {
      issues++;
      return code();
    },
    revoke: () => revocation.promise,
    render: async () => "image",
    onCode: (value) => shown.push(value),
    onPending: () => {},
    onError: () => {},
    onCleanupError: () => {},
  });
  await session.generate(false);
  const replacement = session.generate(true);
  session.dispose();
  revocation.resolve({ ok: true, data: null });
  await replacement;
  assert.equal(issues, 1);
  assert.equal(shown.at(-1), null);
});
