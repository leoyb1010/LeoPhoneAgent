import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  ChangesError,
  createCheckpoint,
  DIFF_LIMIT_BYTES,
  fileDiff,
  revertChanges,
  safeRelativePath,
  workspaceChanges,
} from "./changes.js";

const run = promisify(execFile);
const gitIn = async (cwd: string, ...args: string[]) => (await run("git", args, { cwd })).stdout.trim();

async function tempRepo(commit = true): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-changes-"));
  await gitIn(dir, "init", "-q");
  await gitIn(dir, "config", "user.email", "t@example.com");
  await gitIn(dir, "config", "user.name", "t");
  await writeFile(path.join(dir, ".gitignore"), "ignored.log\n");
  await writeFile(path.join(dir, "a.txt"), "1\n");
  await writeFile(path.join(dir, "b.txt"), "b\n");
  if (commit) {
    await gitIn(dir, "add", "-A");
    await gitIn(dir, "commit", "-q", "-m", "init");
  }
  return dir;
}

const exists = (file: string) => stat(file).then(() => true, () => false);

test("two turns of checkpoints → changes / diff against HEAD and a checkpoint → revert", async () => {
  const dir = await tempRepo();
  try {
    const first = await createCheckpoint(dir, "task:1", "把 a 改一下\n第二行");
    assert.equal(first?.turn, 1);
    assert.equal(first?.label, "把 a 改一下 第二行");

    // 第 1 轮:改 a、删 b、新建 c(未跟踪)、写一个被忽略的文件
    await writeFile(path.join(dir, "a.txt"), "1\n2\n");
    await rm(path.join(dir, "b.txt"));
    await writeFile(path.join(dir, "c.txt"), "c\n");
    await writeFile(path.join(dir, "ignored.log"), "noise\n");
    const second = await createCheckpoint(dir, "task:1", "第二轮");
    assert.equal(second?.id, "2");

    // 第 2 轮:再改 a、新建 sub/d
    await writeFile(path.join(dir, "a.txt"), "1\n2\n3\n");
    await run("mkdir", ["-p", path.join(dir, "sub")]);
    await writeFile(path.join(dir, "sub", "d.txt"), "d\n");

    const changes = await workspaceChanges(dir, "task:1");
    assert.equal(changes.is_repo, true);
    assert.equal(changes.cwd, dir);
    assert.ok(changes.branch === "main" || changes.branch === "master", String(changes.branch));
    assert.deepEqual(
      changes.files.map((file) => [file.path, file.status, file.additions, file.deletions]),
      [
        ["a.txt", "M", 2, 0],
        ["b.txt", "D", 0, 1],
        ["c.txt", "?", 1, 0],
        ["sub/d.txt", "?", 1, 0],
      ],
    );
    assert.deepEqual(
      changes.checkpoints.map((cp) => [cp.id, cp.turn, cp.label]),
      [
        ["1", 1, "把 a 改一下 第二行"],
        ["2", 2, "第二轮"],
      ],
    );
    assert.match(changes.checkpoints[0]!.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    // 别的会话看不到这个会话的检查点
    assert.deepEqual((await workspaceChanges(dir, "task:2")).checkpoints, []);

    const vsHead = await fileDiff(dir, "task:1", "a.txt");
    assert.match(vsHead.diff, /^\+2$/m);
    assert.match(vsHead.diff, /^\+3$/m);
    assert.deepEqual([vsHead.path, vsHead.truncated, vsHead.binary], ["a.txt", false, false]);
    const vsTurn2 = await fileDiff(dir, "task:1", "a.txt", "2");
    assert.match(vsTurn2.diff, /^\+3$/m);
    assert.doesNotMatch(vsTurn2.diff, /^\+2$/m);
    const untracked = await fileDiff(dir, "task:1", "c.txt");
    assert.match(untracked.diff, /new file mode/);

    // 回到第 2 轮开始之前:a 回到 1\n2\n、sub/d 删掉(连空目录),c 留着(那时已有),b 仍是删掉的
    const reverted = await revertChanges(dir, "task:1", { checkpoint: "2" });
    assert.deepEqual(reverted, { reverted: ["a.txt", "sub/d.txt"], checkpoint: "2" });
    assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "1\n2\n");
    assert.equal(await exists(path.join(dir, "sub")), false);
    assert.equal(await exists(path.join(dir, "c.txt")), true);
    assert.equal(await exists(path.join(dir, "b.txt")), false);
    assert.equal(await exists(path.join(dir, "ignored.log")), true, "被忽略的文件不动");

    // 回到第 1 轮之前、只这一个文件
    assert.deepEqual(await revertChanges(dir, "task:1", { checkpoint: "1", paths: ["b.txt"] }), {
      reverted: ["b.txt"],
      checkpoint: "1",
    });
    assert.equal(await readFile(path.join(dir, "b.txt"), "utf8"), "b\n");

    // 只带 paths:恢复到 HEAD,未跟踪的新文件删除
    assert.deepEqual(await revertChanges(dir, "task:1", { paths: ["a.txt", "c.txt"] }), { reverted: ["a.txt", "c.txt"] });
    assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "1\n");
    assert.equal(await exists(path.join(dir, "c.txt")), false);

    // 用户的 index 与提交历史没被碰
    assert.equal(await gitIn(dir, "diff", "--cached", "--name-only"), "");
    assert.equal(await gitIn(dir, "rev-list", "--count", "HEAD"), "1");
    assert.equal(await gitIn(dir, "status", "--porcelain"), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("large and binary diffs are flagged; bad paths and checkpoints are rejected", async () => {
  const dir = await tempRepo();
  try {
    await writeFile(path.join(dir, "big.txt"), "line of text\n".repeat(40_000));
    await writeFile(path.join(dir, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255]));
    const big = await fileDiff(dir, "s", "big.txt");
    assert.equal(big.truncated, true);
    assert.ok(Buffer.byteLength(big.diff) <= DIFF_LIMIT_BYTES);
    assert.ok(big.diff.endsWith("\n"));
    assert.equal((await fileDiff(dir, "s", "bin.dat")).binary, true);

    for (const bad of ["../x", "/etc/passwd", ".git/config", "", "."]) {
      assert.throws(() => safeRelativePath(bad), (cause: unknown) => cause instanceof ChangesError && cause.status === 400);
    }
    await assert.rejects(fileDiff(dir, "s", "a.txt", "9"), (cause: unknown) => cause instanceof ChangesError && cause.status === 404);
    await assert.rejects(fileDiff(dir, "s", "a.txt", "x;rm"), (cause: unknown) => cause instanceof ChangesError && cause.status === 400);
    await assert.rejects(revertChanges(dir, "s", {}), (cause: unknown) => cause instanceof ChangesError && cause.status === 400);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a repo without commits diffs against the empty tree; a plain folder is not a repo", async () => {
  const repo = await tempRepo(false);
  const plain = await mkdtemp(path.join(os.tmpdir(), "leo-plain-"));
  try {
    const changes = await workspaceChanges(repo, "s");
    assert.deepEqual(
      changes.files.map((file) => [file.path, file.status]),
      [
        [".gitignore", "?"],
        ["a.txt", "?"],
        ["b.txt", "?"],
      ],
    );
    assert.ok(await createCheckpoint(repo, "s", "第一轮"));

    assert.deepEqual(await workspaceChanges(plain, "s"), { is_repo: false, cwd: plain, branch: null, files: [], checkpoints: [] });
    assert.equal(await createCheckpoint(plain, "s", "x"), null);
    await assert.rejects(fileDiff(plain, "s", "a.txt"), (cause: unknown) => cause instanceof ChangesError && cause.status === 409);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(plain, { recursive: true, force: true });
  }
});
