import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { registerBrainMcpServer, resolveBrainScriptPath } from "./registerBrainMcp.js";

const desktop = resolve(fileURLToPath(import.meta.url), "../../../..");
const script = resolve(desktop, "leo/brain-mcp.mjs");
const logger = { info: () => {}, warn: () => {} };

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

test("brain MCP script is found from both the source tree and the bundled out/host", () => {
  assert.ok(existsSync(script));
  assert.equal(resolveBrainScriptPath(resolve(desktop, "src/host/leo")), script);
  assert.equal(resolveBrainScriptPath(resolve(desktop, "out/host")), script);
});

test(
  "leo-brain is registered in the CLI user config with the key file path, never the key",
  withKeyFile(async (keyFile) => {
    const { sync, saved } = fakeSync([]);
    assert.equal(await registerBrainMcpServer(sync, logger, { script, keyFile }), "registered");
    assert.deepEqual(
      saved.map((payload) => payload.action),
      ["upsert"],
    );
    const upsert = saved[0]!;
    assert.equal(upsert.source, "zcodeagentmcp");
    assert.equal(upsert.name, "leo-brain");
    assert.equal(upsert.config.command, process.execPath);
    assert.deepEqual(upsert.config.args, [script]);
    assert.deepEqual(upsert.config.env, { ELECTRON_RUN_AS_NODE: "1", LEO_BRAIN_KEY_FILE: keyFile });
    assert.ok(!JSON.stringify(upsert).includes("test-key"));
  }),
);

test(
  "leo-brain is left alone when already registered with the same command, args and env",
  withKeyFile(async (keyFile) => {
    const { sync, saved } = fakeSync([
      {
        source: "zcodeagentmcp",
        scope: "user",
        location: { source: "zcode", scope: "user", directoryPath: "/h/.leophoneagent/cli" },
        name: "leo-brain",
        enabled: true,
        config: {
          command: process.execPath,
          args: [script],
          env: { ELECTRON_RUN_AS_NODE: "1", LEO_BRAIN_KEY_FILE: keyFile },
        },
      },
    ]);
    assert.equal(await registerBrainMcpServer(sync, logger, { script, keyFile }), "unchanged");
    assert.equal(saved.length, 0);
  }),
);

test("leo-brain is skipped on a Mac without a provisioned key file", async () => {
  const { sync, saved } = fakeSync([]);
  const keyFile = resolve(tmpdir(), "leo-brain-missing", "leobot-mac.key");
  assert.equal(await registerBrainMcpServer(sync, logger, { script, keyFile }), "no-key");
  assert.equal(saved.length, 0);
});

test(
  "leo-brain keeps a user's disable and extra env when the app path changes",
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
          env: { LEO_BRAIN_URL: "https://example.test" },
        },
      },
    ]);
    assert.equal(await registerBrainMcpServer(sync, logger, { script, keyFile }), "registered");
    assert.deepEqual(
      saved.map((payload) => payload.action),
      ["upsert", "set-enabled"],
    );
    assert.equal(saved[1]!.enabled, false);
    assert.deepEqual(saved[0]!.config.env, {
      LEO_BRAIN_URL: "https://example.test",
      ELECTRON_RUN_AS_NODE: "1",
      LEO_BRAIN_KEY_FILE: keyFile,
    });
  }),
);
