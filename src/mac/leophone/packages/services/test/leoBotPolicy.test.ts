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
  assert.deepEqual(filterBotPermissionOptions(request("Read", { file_path: "src/a.ts" }), ws).map((o) => o.optionId), ["allow_once", "deny"]);
  // 只读也只限工作区:聊天里批一下就能把 ~/.ssh 的内容读回聊天。
  assert.deepEqual(filterBotPermissionOptions(request("Read", { file_path: "/etc/hosts" }), ws).map((o) => o.optionId), ["deny"]);
  assert.deepEqual(filterBotPermissionOptions(request("Edit", { file_path: "src/a.ts" }), ws).map((o) => o.optionId), ["allow_once", "deny"]);
  assert.deepEqual(filterBotPermissionOptions(request("Edit", { file_path: "/etc/hosts" }), ws).map((o) => o.optionId), ["deny"]);
  assert.deepEqual(filterBotPermissionOptions(request("Write", { file_path: "../escape.txt" }), ws).map((o) => o.optionId), ["deny"]);
  for (const tool of ["Bash", "WebFetch", "WebSearch", "mcp__github__create_issue", "SaveWorkflow"]) {
    assert.deepEqual(filterBotPermissionOptions(request(tool, { command: "ls" }), ws).map((o) => o.optionId), ["deny"], tool);
  }
  assert.equal(botMayAllow("Edit", {}, ws), false);
});

test("chat approvals cannot reach outside the workspace or into executable config", async () => {
  const { mkdtemp, mkdir, symlink, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const root = await mkdtemp(join(os.tmpdir(), "leo-bot-"));
  try {
    const ws = join(root, "ws");
    await mkdir(join(ws, "src"), { recursive: true });
    await symlink(os.tmpdir(), join(ws, "out-link"));
    assert.equal(botMayAllow("Glob", { pattern: "**/*.ts" }, ws), true);
    assert.equal(botMayAllow("Glob", { pattern: "/Users/me/.ssh/*" }, ws), false);
    assert.equal(botMayAllow("Grep", { pattern: "key", path: "~/.aws" }, ws), false);
    assert.equal(botMayAllow("Write", { file_path: "src/new.ts" }, ws), true);
    // 改了就能执行命令的位置
    for (const file of [".git/hooks/pre-commit", ".zcode/config.json", ".agents/mcp.json", ".envrc", "sub/.mcp.json"]) {
      assert.equal(botMayAllow("Write", { file_path: file }, ws), false, file);
    }
    // 符号链接指出工作区
    assert.equal(botMayAllow("Write", { file_path: "out-link/x.txt" }, ws), false);
    // 幌子参数:每个路径都要在工作区内
    assert.equal(botMayAllow("NotebookEdit", { file_path: "src/a.ipynb", notebook_path: "/etc/x.ipynb" }, ws), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
