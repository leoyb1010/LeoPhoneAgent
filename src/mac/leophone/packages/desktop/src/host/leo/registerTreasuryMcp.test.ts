import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { leoTreasuryKey, LEO_HTTP_PORT } from "./leoPaths.js";
import { registerTreasuryMcpServer } from "./registerTreasuryMcp.js";

const logger = { info: () => {}, warn: () => {} };

function fakeSync(servers: unknown[]) {
  const saved: Array<{ action: string; source?: string; name?: string; config?: any; enabled?: boolean }> = [];
  const sync = {
    loadMcpFromUserDirectory: async () => ({ servers }),
    saveMcpToUserDirectory: async (payload: unknown) => {
      saved.push(payload as (typeof saved)[number]);
    },
  } as never;
  return { sync, saved };
}

test("[up-d-mac] an old stdio leo-treasury entry is replaced by the shared host HTTP endpoint; a user's disable survives", async () => {
  const { sync, saved } = fakeSync([
    {
      source: "zcodeagentmcp",
      scope: "user",
      location: { source: "zcode", scope: "user", directoryPath: "/h/.leophoneagent/cli" },
      name: "leo-treasury",
      enabled: false,
      config: {
        command: "/old/electron",
        args: ["/old/treasury-mcp.mjs"],
        env: { ELECTRON_RUN_AS_NODE: "1", LEOAGENT_KEY: "k" },
        enabled: false,
      },
    },
  ]);
  assert.equal(await registerTreasuryMcpServer(sync, logger), "registered");
  assert.deepEqual(
    saved.map((payload) => payload.action),
    ["upsert", "set-enabled"],
  );
  const upsert = saved[0]!;
  assert.equal(upsert.source, "zcodeagentmcp");
  assert.equal(upsert.name, "leo-treasury");
  // strict schema:http 条目不能夹带 command / args / env。
  assert.deepEqual(upsert.config, {
    type: "http",
    url: `http://127.0.0.1:${LEO_HTTP_PORT}/api/leo/treasury/mcp`,
    headers: { Authorization: `Bearer ${leoTreasuryKey()}` },
  });
  assert.equal(saved[1]!.enabled, false);
});

test("[up-d-mac] leo-treasury already on the HTTP endpoint is left alone", async () => {
  const { sync, saved } = fakeSync([
    {
      source: "zcodeagentmcp",
      scope: "user",
      name: "leo-treasury",
      enabled: true,
      config: {
        type: "http",
        url: `http://127.0.0.1:${LEO_HTTP_PORT}/api/leo/treasury/mcp`,
        headers: { Authorization: `Bearer ${leoTreasuryKey()}` },
      },
    },
  ]);
  assert.equal(await registerTreasuryMcpServer(sync, logger), "unchanged");
  assert.equal(saved.length, 0);
});

test("[wp-61] legacy ~/.agents entry is removed only when it is ours", async () => {
  const { removeLegacyAgentsEntry } = await import("./registerTreasuryMcp.js");
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const home = mkdtempSync(resolve(tmpdir(), "leo-agents-"));
  const logger = { info: () => {}, warn: () => {} };
  try {
    mkdirSync(resolve(home, ".agents"));
    const file = resolve(home, ".agents/mcp.json");
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          "leo-treasury": { command: "x", args: ["/a/leo/treasury-mcp.mjs"] },
          other: { command: "y" },
        },
      }),
    );
    assert.equal(removeLegacyAgentsEntry(logger, home), true);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).mcpServers), ["other"]);
    writeFileSync(file, JSON.stringify({ mcpServers: { "leo-treasury": { command: "mine", args: [] } } }));
    assert.equal(removeLegacyAgentsEntry(logger, home), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
