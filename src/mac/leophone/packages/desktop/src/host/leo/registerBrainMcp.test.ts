import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { leoTreasuryKey, LEO_HTTP_PORT } from "./leoPaths.js";
import { registerBrainMcpServer } from "./registerBrainMcp.js";

const logger = { info: () => {}, warn: () => {} };
const endpoint = {
  type: "http",
  url: `http://127.0.0.1:${LEO_HTTP_PORT}/api/leo/brain/mcp`,
  headers: { Authorization: `Bearer ${leoTreasuryKey()}` },
};

function withKeyFile(run: (keyFile: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "leo-brain-"));
    const keyFile = resolve(dir, "leobot-mac.key");
    writeFileSync(keyFile, "test-key\n", { mode: 0o600 });
    try {
      await run(keyFile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function fakeSync(servers: unknown[]) {
  const saved: Array<{
    action: string;
    source?: string;
    name?: string;
    config?: any;
    enabled?: boolean;
  }> = [];
  const sync = {
    loadMcpFromUserDirectory: async () => ({ servers }),
    saveMcpToUserDirectory: async (payload: unknown) => {
      saved.push(payload as (typeof saved)[number]);
    },
  } as never;
  return { sync, saved };
}

test(
  "leo-brain is registered as the host HTTP endpoint; the brain key never enters the config",
  withKeyFile(async (keyFile) => {
    const { sync, saved } = fakeSync([]);
    assert.equal(await registerBrainMcpServer(sync, logger, { keyFile }), "registered");
    assert.deepEqual(
      saved.map((payload) => payload.action),
      ["upsert"],
    );
    const upsert = saved[0]!;
    assert.equal(upsert.source, "zcodeagentmcp");
    assert.equal(upsert.name, "leo-brain");
    assert.deepEqual(upsert.config, endpoint);
    assert.ok(!JSON.stringify(upsert).includes("test-key"));
  }),
);

test(
  "leo-brain is left alone when already on the HTTP endpoint",
  withKeyFile(async (keyFile) => {
    const { sync, saved } = fakeSync([
      {
        source: "zcodeagentmcp",
        scope: "user",
        location: { source: "zcode", scope: "user", directoryPath: "/h/.leophoneagent/cli" },
        name: "leo-brain",
        enabled: true,
        config: endpoint,
      },
    ]);
    assert.equal(await registerBrainMcpServer(sync, logger, { keyFile }), "unchanged");
    assert.equal(saved.length, 0);
  }),
);

test("leo-brain is skipped on a Mac without a provisioned key file", async () => {
  const { sync, saved } = fakeSync([]);
  const keyFile = resolve(tmpdir(), "leo-brain-missing", "leobot-mac.key");
  assert.equal(await registerBrainMcpServer(sync, logger, { keyFile }), "no-key");
  assert.equal(saved.length, 0);
});

test(
  "[up-d-mac] an old stdio leo-brain entry is migrated and a user's disable is kept",
  withKeyFile(async (keyFile) => {
    const { sync, saved } = fakeSync([
      {
        source: "zcodeagentmcp",
        scope: "user",
        location: { source: "zcode", scope: "user", directoryPath: "/h/.leophoneagent/cli" },
        name: "leo-brain",
        enabled: false,
        config: {
          command: "/old/LeoBot",
          args: ["/old/brain-mcp.mjs"],
          env: { LEO_BRAIN_KEY_FILE: keyFile },
          enabled: false,
        },
      },
    ]);
    assert.equal(await registerBrainMcpServer(sync, logger, { keyFile }), "registered");
    assert.deepEqual(
      saved.map((payload) => payload.action),
      ["upsert", "set-enabled"],
    );
    assert.deepEqual(saved[0]!.config, endpoint);
    assert.equal(saved[1]!.enabled, false);
  }),
);
