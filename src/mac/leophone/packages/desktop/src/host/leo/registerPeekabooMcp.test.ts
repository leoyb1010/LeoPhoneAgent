import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import type { NativeMcpServerRecord, SaveCliMcpToUserDirectoryRequest } from "@zcode/shared";

import { registerPeekabooMcpServer, resolvePeekabooPath } from "./registerPeekabooMcp.js";

const logger = { info: () => {}, warn: () => {} };

function fakeSync(servers: NativeMcpServerRecord[]) {
  const saved: SaveCliMcpToUserDirectoryRequest[] = [];
  return {
    saved,
    sync: {
      loadMcpFromUserDirectory: async () => ({ servers }),
      saveMcpToUserDirectory: async (payload: SaveCliMcpToUserDirectoryRequest) => {
        saved.push(payload);
      },
    },
  };
}

test("registers peekaboo mcp as leo-screen in the user scope", async () => {
  const { sync, saved } = fakeSync([]);
  assert.equal(
    await registerPeekabooMcpServer(sync, logger, "/App/Resources/leo/bin/peekaboo"),
    "registered",
  );
  assert.deepEqual(saved, [
    {
      action: "upsert",
      source: "zcodeagentmcp",
      name: "leo-screen",
      config: { command: "/App/Resources/leo/bin/peekaboo", args: ["mcp"] },
    },
  ]);
});

test("same path → no write; moved app → only command/args updated, user fields and disabled state kept", async () => {
  const same = fakeSync([
    {
      source: "zcodeagentmcp",
      scope: "user",
      name: "leo-screen",
      config: { command: "/a/peekaboo", args: ["mcp"] },
    },
  ]);
  assert.equal(await registerPeekabooMcpServer(same.sync, logger, "/a/peekaboo"), "unchanged");
  assert.equal(same.saved.length, 0);

  const moved = fakeSync([
    {
      source: "zcodeagentmcp",
      scope: "user",
      name: "leo-screen",
      enabled: false,
      config: { command: "/old/peekaboo", args: ["mcp"], env: { PEEKABOO_LOG_LEVEL: "debug" } },
    },
  ]);
  assert.equal(await registerPeekabooMcpServer(moved.sync, logger, "/new/peekaboo"), "registered");
  assert.deepEqual(moved.saved[0]?.config, {
    command: "/new/peekaboo",
    args: ["mcp"],
    env: { PEEKABOO_LOG_LEVEL: "debug" },
  });
  assert.deepEqual(moved.saved[1], {
    action: "set-enabled",
    source: "zcodeagentmcp",
    name: "leo-screen",
    enabled: false,
  });
});

test("missing binary skips registration; dev path resolves from out/host and src/host/leo", async () => {
  const { sync, saved } = fakeSync([]);
  assert.equal(await registerPeekabooMcpServer(sync, logger, null), "missing");
  assert.equal(saved.length, 0);
  const desktop = resolve(import.meta.dirname, "../../..");
  const expected = resolve(desktop, "leo/bin/peekaboo");
  const exists = (path: string) => path === expected;
  assert.equal(resolvePeekabooPath(resolve(desktop, "out/host"), exists), expected);
  assert.equal(resolvePeekabooPath(resolve(desktop, "src/host/leo"), exists), expected);
});
