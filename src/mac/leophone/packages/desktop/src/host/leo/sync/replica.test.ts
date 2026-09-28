import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SyncReplicaStore } from "./replica.js";
import type { SyncChange } from "./wire.js";

const change = (changeId: string, revision: number, updatedAt = revision): SyncChange => ({
  changeId,
  revision,
  id: { type: "SessionV2", id: "s" },
  operation: "upsert",
  updatedAt,
  record: {
    id: { type: "SessionV2", id: "s" },
    fields: { title: { t: "string", v: changeId } },
    assets: {},
    schemaVersion: 2,
    unknownFields: { future: { t: "int", v: 42 } },
    updatedAt,
  },
});

test("durable receipts, duplicate integrity, revision order and restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "leo-replica-"));
  let store = await SyncReplicaStore.open(dir);
  try {
    const first = store.apply("iphone", [change("a", 2)]);
    const replicaId = store.replicaId;
    store.close();
    store = await SyncReplicaStore.open(dir);
    assert.equal(store.replicaId, replicaId);
    assert.deepEqual(store.apply("iphone", [change("a", 2)]), first);
    assert.throws(() => store.apply("iphone", [change("a", 3)]), /changeId/);
    assert.equal(store.apply("iphone", [change("old", 1, 100)])[0]?.status, "superseded");
    const page = store.changes(0, 100);
    assert.equal(page.changes.length, 1);
    assert.deepEqual(page.changes[0]?.change.record?.unknownFields, {
      future: { t: "int", v: 42 },
    });
    assert.throws(() => store.changes(100, 100), /cursor/);
    assert.equal(store.apply("iphone", [change("clock-rollback", 3, -100)])[0]?.status, "stored");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("delete wins ties and offline stale writes cannot resurrect; pagination survives restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "leo-replica-"));
  const store = await SyncReplicaStore.open(dir);
  try {
    store.apply("iphone", [change("a", 1, 10)]);
    const deletion: SyncChange = {
      changeId: "deleted",
      revision: 2,
      id: { type: "SessionV2", id: "s" },
      operation: "delete",
      updatedAt: 20,
    };
    store.apply("iphone", [deletion]);
    assert.equal(store.apply("ipad", [change("stale", 1, 20)])[0]?.status, "superseded");
    const first = store.changes(0, 1);
    assert.equal(first.hasMore, true);
    const second = store.changes(first.nextCursor, 1);
    assert.equal(second.changes[0]?.change.operation, "delete");
    assert.equal(second.hasMore, false);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("asset resume, missing assets reject batch atomically, full hash and ranges", async () => {
  const dir = await mkdtemp(join(tmpdir(), "leo-replica-"));
  let store = await SyncReplicaStore.open(dir);
  try {
    const data = Buffer.from("hello durable assets");
    const hash = createHash("sha256").update(data).digest("hex");
    const assetChange = change("asset", 1);
    assetChange.record!.assets.asset = { key: "asset", sha256: hash, size: data.length };
    assert.throws(() => store.apply("iphone", [change("first", 1), assetChange]), /asset/);
    assert.equal(store.changes(0, 100).changes.length, 0);
    store.putAsset(hash, 0, data.length, data.subarray(0, 5));
    store.close();
    store = await SyncReplicaStore.open(dir);
    assert.equal(store.assetStatus(hash)?.offset, 5);
    store.putAsset(hash, 5, data.length, data.subarray(5));
    assert.equal(store.assetStatus(hash)?.complete, true);
    assert.deepEqual(store.readAsset(hash, 2, 8), data.subarray(2, 9));
    assert.equal(store.apply("iphone", [assetChange])[0]?.status, "stored");
    const wrongHash = "0".repeat(64);
    assert.throws(() => store.putAsset(wrongHash, 0, data.length, data), /sha256/);
    assert.equal(store.assetStatus(wrongHash), undefined);
    const corrected = Buffer.from("corrected asset");
    const correctedHash = createHash("sha256").update(corrected).digest("hex");
    store.putAsset(correctedHash, 0, corrected.length, Buffer.from("bad"));
    assert.throws(
      () => store.putAsset(correctedHash, 3, corrected.length, corrected.subarray(3)),
      /sha256/,
    );
    store.putAsset(correctedHash, 0, corrected.length, corrected, true);
    assert.equal(store.assetStatus(correctedHash)?.complete, true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
