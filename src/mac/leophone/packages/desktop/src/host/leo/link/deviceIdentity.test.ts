import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadDeviceIdentity } from "./deviceIdentity.js";

test("simultaneous startup creates exactly one durable device identity", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-device-"));
  const file = path.join(dir, "device.json");
  try {
    const ids = await Promise.all(Array.from({ length: 20 }, () => loadDeviceIdentity(file)));
    assert.equal(new Set(ids).size, 1);
    assert.equal(await loadDeviceIdentity(file), ids[0]);
    assert.equal(JSON.parse(await readFile(file, "utf8")).deviceId, ids[0]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupt identity is not silently replaced or repaired", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-device-"));
  const file = path.join(dir, "device.json");
  try {
    await writeFile(file, "incomplete identity");
    await assert.rejects(loadDeviceIdentity(file));
    assert.equal(await readFile(file, "utf8"), "incomplete identity");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
