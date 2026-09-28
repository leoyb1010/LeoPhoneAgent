import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("Treasury direct adapter uses the existing store, explicit write gate and on-demand bodies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "leo-treasury-direct-"));
  process.env["LEOAGENT_HOME"] = directory;
  const { TreasuryStore } = await import("../treasuryStore.js");
  const { createTreasuryHandler } = await import("./treasury.js");
  const store = new TreasuryStore();
  const handler = createTreasuryHandler(store);
  const server = createServer((req, res) => {
    void handler(req, res, { deviceId: "paired-phone" }).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (name: string, input: unknown) => {
    const response = await fetch(`${base}/treasury/v1/call/${name}`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200);
    return (await response.json()) as Record<string, unknown>;
  };
  try {
    assert.equal(
      typeof (await call("treasury_save", { kind: "note", content: "isolated evidence" })).error,
      "string",
    );
    assert.equal(store.count(), 0);
    const saved = await call("treasury_save", {
      kind: "note",
      content: "isolated evidence",
      user_confirmed: true,
    });
    const id = (saved.saved as { id: string }).id;
    assert.equal(store.get([id])[0]?.content, "isolated evidence");
    const searched = await call("treasury_search", { query: "evidence" });
    assert.equal(searched.untrusted_content, true);
    assert.equal((searched.items as Array<{ body: unknown }>)[0]?.body, null);
    const read = await call("treasury_get", { ids: [id], include_body: true });
    assert.equal((read.items as Array<{ body: unknown }>)[0]?.body, "isolated evidence");
    const response = await fetch(`${base}/api/leo/treasury/tools`);
    assert.equal(response.status, 404);
    await response.arrayBuffer();
  } finally {
    server.close();
    await once(server, "close");
    store.close();
    delete process.env["LEOAGENT_HOME"];
    await rm(directory, { recursive: true, force: true });
  }
});
