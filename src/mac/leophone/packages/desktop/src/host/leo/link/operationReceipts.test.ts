import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LinkRequest } from "./bridge.js";
import { OperationReceipts } from "./operationReceipts.js";
const req: LinkRequest = {
  method: "POST",
  path: "/harness/sessions",
  caller: { kind: "iphone", deviceId: "phone" },
  requestId: "stable-op",
  body: { prompt: "hello", harness: "zcode" },
};

test("one mutation across concurrent adapters, response loss, restart, and reordered JSON fields", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-receipts-"));
  try {
    let count = 0;
    const result = { status: 202, body: { session_id: "task-1" } };
    const execute = async () => {
      count += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return result;
    };
    const store = new OperationReceipts(dir);
    assert.deepEqual(
      await Promise.all([
        store.run(req, execute),
        store.run({ ...req, transport: "direct" }, execute),
      ]),
      [result, result],
    );
    const restored = new OperationReceipts(dir);
    assert.deepEqual(
      await restored.run({ ...req, body: { harness: "zcode", prompt: "hello" } }, execute),
      result,
    );
    assert.equal(count, 1);
    assert.equal(
      (await restored.run({ ...req, body: { prompt: "DIFFERENT" } }, execute)).status,
      409,
    );
    assert.equal((await restored.status(req)).status, 200);
    assert.equal(
      (await restored.status({ ...req, caller: { kind: "iphone", deviceId: "other" } })).status,
      404,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unknown side-effect outcome survives restart without re-execution; 5xx doesn't authorize another side effect", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-crash-"));
  try {
    let count = 0;
    const crash = async () => {
      count += 1;
      throw new Error("crash after runtime admission");
    };
    const store = new OperationReceipts(dir);
    assert.equal((await store.run(req, crash)).status, 409);
    assert.equal((await new OperationReceipts(dir).run(req, crash)).status, 409);
    assert.equal(count, 1);
    const failReq = { ...req, requestId: "failure" };
    const failure = async () => {
      count += 1;
      return { status: 502, body: { error: "response lost" } };
    };
    await store.run(failReq, failure);
    await new OperationReceipts(dir).run(failReq, failure);
    assert.equal(count, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
