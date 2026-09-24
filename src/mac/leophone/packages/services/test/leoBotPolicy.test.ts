import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { botMayAllow, filterBotPermissionOptions, LEO_BOT_FORCED_MODE } from "../src/bots/leoBotPolicy.js";

const options = [
  { optionId: "allow_once", kind: "allow_once", name: "Allow", response: { decision: "allow" as const } },
  { optionId: "allow_project", kind: "allow_always", name: "Always allow in this project", response: { decision: "allow" as const } },
  { optionId: "deny", kind: "deny", name: "Deny", response: { decision: "deny" as const } },
];
const request = (toolName: string, input: unknown) => ({ kind: toolName, options, raw: { toolName, input } });

test("bot tasks run in build mode, not upstream's approval-free yolo", async () => {
  assert.equal(LEO_BOT_FORCED_MODE, "build");
  const here = dirname(fileURLToPath(import.meta.url));
  const source = await readFile(join(here, "../src/bots/botsService.ts"), "utf8");
  // 上游同步时如果把这两处改回去,这里会红。
  assert.match(source, /const BOT_FORCED_MODE = LEO_BOT_FORCED_MODE;/);
  assert.match(source, /filterBotPermissionOptions\(event, context\.workspacePath\)/);
});

test("chat approvals: read-only tools and in-workspace edits may be allowed once; everything else only denied", () => {
  const ws = "/Users/me/project";
  assert.deepEqual(filterBotPermissionOptions(request("Read", { file_path: "/etc/hosts" }), ws).map((o) => o.optionId), ["allow_once", "deny"]);
  assert.deepEqual(filterBotPermissionOptions(request("Edit", { file_path: "src/a.ts" }), ws).map((o) => o.optionId), ["allow_once", "deny"]);
  assert.deepEqual(filterBotPermissionOptions(request("Edit", { file_path: "/etc/hosts" }), ws).map((o) => o.optionId), ["deny"]);
  assert.deepEqual(filterBotPermissionOptions(request("Write", { file_path: "../escape.txt" }), ws).map((o) => o.optionId), ["deny"]);
  for (const tool of ["Bash", "WebFetch", "WebSearch", "mcp__github__create_issue", "SaveWorkflow"]) {
    assert.deepEqual(filterBotPermissionOptions(request(tool, { command: "ls" }), ws).map((o) => o.optionId), ["deny"], tool);
  }
  assert.equal(botMayAllow("Edit", {}, ws), false);
});
