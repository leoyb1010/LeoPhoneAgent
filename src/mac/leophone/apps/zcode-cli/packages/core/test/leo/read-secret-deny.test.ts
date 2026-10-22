// [leo] Read 不读 LeoBot 凭据文件（第二大脑 key、主钥匙、藏宝阁钥匙），符号链接和相对路径也挡住。

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { NodeFileSystemAdapter } from "../../../adapters/src/fs/index.js";
import { readToolEntry } from "../../src/tool/handlers/read.js";
import type { ToolExecutionContext } from "../../src/tool/types.js";

function context(dir: string): ToolExecutionContext {
  return {
    toolCallId: "call-secret",
    traceId: "trace-secret" as ToolExecutionContext["traceId"],
    abortSignal: new AbortController().signal,
    fileSystemPort: new NodeFileSystemAdapter(),
    workingDirectory: dir,
    workspaceRoot: dir,
    sessionId: "session-secret" as ToolExecutionContext["sessionId"],
    readFileState: new Map(),
  };
}

test("Read refuses LeoBot credential files and links to them, and still reads neighbours", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "leo-secret-home-"));
  const work = await mkdtemp(path.join(os.tmpdir(), "leo-secret-work-"));
  const previousHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    await mkdir(path.join(home, ".leoagent"), { recursive: true });
    await mkdir(path.join(home, ".config", "leo-brain"), { recursive: true });
    const secrets = [
      path.join(home, ".leoagent", "key"),
      path.join(home, ".leoagent", "treasury.key"),
      path.join(home, ".config", "leo-brain", "leobot-mac.key"),
    ];
    for (const file of secrets) await writeFile(file, "super-secret-key\n");
    await writeFile(path.join(home, ".leoagent", "notes.txt"), "plain notes\n");
    await symlink(secrets[0]!, path.join(work, "innocent.txt"));

    const attempts = [
      ...secrets.map((file) => ({ dir: work, file_path: file })),
      { dir: work, file_path: path.join(work, "innocent.txt") },
      { dir: path.join(home, ".leoagent"), file_path: "treasury.key" },
      ...(process.platform === "darwin"
        ? [{ dir: work, file_path: path.join(home, ".LeoAgent", "KEY") }]
        : []),
    ];
    for (const { dir, file_path } of attempts) {
      await assert.rejects(
        readToolEntry.handler({ file_path }, context(dir)),
        (error: Error) => {
          assert.match(error.message, /LeoBot credential/);
          assert.doesNotMatch(error.message, /super-secret-key/);
          return true;
        },
        file_path,
      );
    }

    const allowed = await readToolEntry.handler(
      { file_path: path.join(home, ".leoagent", "notes.txt") },
      context(work),
    );
    assert.match(JSON.stringify(allowed), /plain notes/);
  } finally {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});
