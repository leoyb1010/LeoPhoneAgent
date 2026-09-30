import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DirectGrants } from "./directGrants.js";

test("direct credentials persist, bind target, expire, and revoke across restart without plaintext storage", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-grants-"));
  let now = Date.now();
  try {
    const file = path.join(dir, "grants.json");
    const grants = new DirectGrants(file, "target", () => now);
    await grants.restore();
    await assert.rejects(grants.issue({ kind: "unknown" }));
    const caller = { kind: "iphone" as const, deviceId: "phone" };
    const issued = await grants.issue(caller);
    assert.deepEqual(grants.authenticate(issued.token, "target"), caller);
    assert.equal(grants.authenticate(issued.token, "other"), null);
    assert.equal(grants.authenticate("invalid", "target"), null);
    assert.equal((await readFile(file, "utf8")).includes(issued.token), false);
    await assert.rejects(new DirectGrants(file, "wrong-target").restore());
    const reopened = new DirectGrants(file, "target", () => now);
    await reopened.restore();
    assert.deepEqual(reopened.authenticate(issued.token, "target"), caller);
    await reopened.revoke("phone");
    const revoked = new DirectGrants(file, "target", () => now);
    await revoked.restore();
    assert.equal(revoked.authenticate(issued.token, "target"), null);
    await assert.rejects(revoked.issue(caller));
    const other = await revoked.issue({ kind: "legacy", deviceId: "tablet" });
    now = (other.expiresAt + 1) * 1000;
    assert.equal(revoked.authenticate(other.token, "target"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("local pairing is one-use, target-bound, short-lived, and accepts no caller-selected identity", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-pair-"));
  let now = Date.now();
  try {
    const grants = new DirectGrants(path.join(dir, "grants.json"), "target", () => now);
    await grants.restore();
    const code = grants.createPairingCode();
    assert.equal(await grants.redeem(code.join, "wrong", "phone"), null);
    const results = await Promise.all([
      grants.redeem(code.join, "target", "phone"),
      grants.redeem(code.join, "target", "phone"),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.match(grants.authenticate(results[0]!.token, "target")!.deviceId!, /^direct-/);
    const expired = grants.createPairingCode();
    now += 301_000;
    assert.equal(await grants.redeem(expired.join, "target", "phone"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("a failed revocation remains denied and a retry persists it across restart", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-grant-retry-"));
  const file = path.join(dir, "grants.json");
  try {
    const grants = new DirectGrants(file, "target");
    await grants.restore();
    const issued = await grants.issue({ kind: "iphone", deviceId: "phone" });
    await mkdir(`${file}.tmp`); // Inject a real write failure without changing filesystem permissions.
    await assert.rejects(grants.revoke("phone"));
    assert.equal(grants.authenticate(issued.token, "target"), null);
    await rm(`${file}.tmp`, { recursive: true });
    await grants.revoke("phone");
    const restored = new DirectGrants(file, "target");
    await restored.restore();
    assert.equal(restored.authenticate(issued.token, "target"), null);
    const registry = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(registry.revokedDeviceIds, ["phone"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
