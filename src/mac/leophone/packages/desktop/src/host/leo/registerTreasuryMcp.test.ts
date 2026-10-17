import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import test from "node:test";

import { resolveScriptPath } from "./registerTreasuryMcp.js";

const desktop = resolve(fileURLToPath(import.meta.url), "../../../..");

test("treasury MCP script is found from both the source tree and the bundled out/host", () => {
  const expected = resolve(desktop, "leo/treasury-mcp.mjs");
  assert.ok(existsSync(expected));
  assert.equal(resolveScriptPath(resolve(desktop, "src/host/leo")), expected);
  // tsup 把 host 打成 out/host/index.js:以前从这里解析到 packages/leo/…,藏宝阁 MCP 在开发态从不登记。
  assert.equal(resolveScriptPath(resolve(desktop, "out/host")), expected);
});

test("[wp-61] treasury MCP goes to the CLI user config (what 3.15.1 sessions read), keeps a user's disable", async () => {
  const { registerTreasuryMcpServer } = await import("./registerTreasuryMcp.js");
  const saved: unknown[] = [];
  const logger = { info: () => {}, warn: () => {} };
  const script = resolve(desktop, "leo/treasury-mcp.mjs");
  const sync = {
    loadMcpFromUserDirectory: async () => ({
      servers: [
        {
          source: "zcodeagentmcp",
          scope: "user",
          location: { source: "zcode", scope: "user", directoryPath: "/h/.leophoneagent/cli" },
          name: "leo-treasury",
          enabled: false,
          config: { command: "/old/electron", args: ["/old/treasury-mcp.mjs"] },
        },
      ],
    }),
    saveMcpToUserDirectory: async (payload: unknown) => {
      saved.push(payload);
    },
  } as never;
  assert.equal(await registerTreasuryMcpServer(sync, logger, script), "registered");
  assert.deepEqual(
    saved.map((payload) => (payload as { action: string }).action),
    ["upsert", "set-enabled"],
  );
  const upsert = saved[0] as { source: string; name: string; config: { args: string[]; env: Record<string, string> } };
  assert.equal(upsert.source, "zcodeagentmcp");
  assert.equal(upsert.name, "leo-treasury");
  assert.deepEqual(upsert.config.args, [script]);
  assert.equal(upsert.config.env["ELECTRON_RUN_AS_NODE"], "1");
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
