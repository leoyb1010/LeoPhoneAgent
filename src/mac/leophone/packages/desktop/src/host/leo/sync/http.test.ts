import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSyncReplica } from "./index.js";

test("HTTP chunks resume, hash-checked ACK, suffix Range and increment cursors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "leo-replica-http-"));
  const replica = await createSyncReplica(dir);
  const server = createServer((req, res) => {
    void replica.handle(req, res, { deviceId: "paired-phone" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const data = Buffer.from("asset evidence");
    const sha256 = createHash("sha256").update(data).digest("hex");
    const assetURL = `${base}/sync/v1/assets/${sha256}`;
    let response = await fetch(assetURL, {
      method: "PUT",
      body: data.subarray(0, 5),
      headers: { "Content-Range": `bytes 0-4/${data.length}` },
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    response = await fetch(assetURL, { method: "HEAD" });
    assert.equal(response.headers.get("Upload-Offset"), "5");
    response = await fetch(assetURL, {
      method: "PUT",
      body: data.subarray(5),
      headers: { "Content-Range": `bytes 5-${data.length - 1}/${data.length}` },
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    response = await fetch(assetURL, { headers: { Range: "bytes=-8" } });
    assert.equal(response.status, 206);
    assert.equal(await response.text(), "evidence");
    const record = {
      id: { type: "SessionFileV2", id: "s/file" },
      fields: { sessionId: { t: "string", v: "s" }, updatedAt: { t: "date", v: 123.5 } },
      assets: { asset: { key: "asset", sha256, size: data.length } },
      schemaVersion: 1,
      unknownFields: {},
      updatedAt: 123.5,
    };
    response = await fetch(`${base}/sync/v1/changes`, {
      method: "POST",
      body: JSON.stringify({
        changes: [
          {
            changeId: "c1",
            revision: 1,
            id: record.id,
            operation: "upsert",
            updatedAt: record.updatedAt,
            record,
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const receipt = (await response.json()) as { receipts: Array<{ cursor: number }> };
    assert.equal(receipt.receipts[0]?.cursor, 1);
    response = await fetch(`${base}/sync/v1/changes?after=0&limit=1`);
    const page = (await response.json()) as {
      changes: Array<{ senderDeviceId: string; change: { record: unknown } }>;
    };
    assert.equal(page.changes[0]?.senderDeviceId, "paired-phone");
    assert.deepEqual(page.changes[0]?.change.record, record);
    response = await fetch(`${base}/sync/v1/changes?after=999`);
    assert.equal(response.status, 409);
    await response.arrayBuffer();
    response = await fetch(assetURL, { headers: { Range: "bytes=999-1000" } });
    assert.equal(response.status, 416);
    await response.arrayBuffer();
    response = await fetch(`${base}/sync/v1/changes`, { method: "POST", body: "{" });
    assert.equal(response.status, 400);
    await response.arrayBuffer();
  } finally {
    server.close();
    await once(server, "close");
    replica.close();
    await rm(dir, { recursive: true, force: true });
  }
});
