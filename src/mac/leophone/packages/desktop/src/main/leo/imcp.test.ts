import assert from "node:assert/strict";
import { test } from "node:test";

import { detectImcp, IMCP_INSTALL_COMMAND, IMCP_SERVER_PATH } from "./imcpCore.js";

test("not installed: no server shim → install command, nothing to register", () => {
  assert.deepEqual(
    detectImcp(() => false, "darwin"),
    {
      platform: "darwin",
      installed: false,
      installCommand: IMCP_INSTALL_COMMAND,
      appFound: false,
    },
  );
});

test("an old iMCP.app without the stdio shim is treated as not installed (upgrade)", () => {
  const status = detectImcp((path) => path === "/Applications/iMCP.app", "darwin");
  assert.equal(status.platform === "darwin" && !status.installed && status.appFound, true);
});

test("installed: registers the stdio shim under the name imcp", () => {
  assert.deepEqual(
    detectImcp((path) => path === IMCP_SERVER_PATH, "darwin"),
    {
      platform: "darwin",
      installed: true,
      serverName: "imcp",
      config: { command: "/Applications/iMCP.app/Contents/MacOS/imcp-server" },
    },
  );
});

test("other platforms never offer iMCP", () => {
  assert.deepEqual(
    detectImcp(() => true, "linux"),
    { platform: "other" },
  );
});

test("registering goes through the settings page write path: user scope ~/.leophoneagent/cli/config.json, ~/.agents untouched", async () => {
  const { mkdtemp, mkdir, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = await mkdtemp(join(tmpdir(), "leo-imcp-"));
  const previousHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(
      join(home, ".agents", "mcp.json"),
      JSON.stringify({
        mcpServers: { "leo-treasury": { command: "/x/node", args: ["/x/treasury.mjs"] } },
      }),
    );
    const { saveCliMcpToUserDirectory } = await import("../mcpUserDirectory/index.js");
    const status = detectImcp((path) => path === IMCP_SERVER_PATH, "darwin");
    assert.ok(status.platform === "darwin" && status.installed);
    await saveCliMcpToUserDirectory({
      action: "upsert",
      source: "zcodeagentmcp",
      name: status.serverName,
      config: status.config,
    });
    const written = JSON.parse(
      await readFile(join(home, ".leophoneagent", "cli", "config.json"), "utf8"),
    ) as {
      mcp: { servers: Record<string, { command: string }> };
    };
    assert.equal(written.mcp.servers["imcp"]?.command, IMCP_SERVER_PATH);
    // 藏宝阁登记在 ~/.agents/mcp.json,不能被这次写入动到。
    const agents = JSON.parse(await readFile(join(home, ".agents", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string }>;
    };
    assert.deepEqual(Object.keys(agents.mcpServers), ["leo-treasury"]);
  } finally {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
