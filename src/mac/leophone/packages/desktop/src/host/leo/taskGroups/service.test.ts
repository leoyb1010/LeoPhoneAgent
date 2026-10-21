import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createLeoTaskGroups, parseTaskGroupAgents, TaskGroupError, type TaskGroupTaskPort } from "./service.js";

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Leo Test", "-c", "user.email=leo@test.local", ...args], {
    cwd,
    encoding: "utf8",
  });
}

function makeRepo(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "leo-group-repo-")));
  gitIn(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "app.txt"), "one\ntwo\nthree\n");
  mkdirSync(join(repo, "sub"));
  writeFileSync(join(repo, "sub", "keep.txt"), "keep\n");
  writeFileSync(
    join(repo, "leo.json"),
    JSON.stringify({ worktree: { setup: ['echo "$LEO_BRANCH_NAME" > .leo-setup'], teardown: ['echo bye > "$LEO_ROOT_PATH/.leo-teardown"'] } }),
  );
  writeFileSync(join(repo, ".gitignore"), ".leo-setup\n.leo-teardown\n");
  gitIn(repo, "add", ".");
  gitIn(repo, "commit", "-q", "-m", "init");
  return repo;
}

function fakeTasks() {
  const created: Array<{ workspacePath: string; modelSelection?: { providerId: string; modelId: string } }> = [];
  const prompts: Array<{ taskId: string; content: string }> = [];
  const port: TaskGroupTaskPort = {
    async createTask(input) {
      created.push(input);
      return { taskId: `task-${created.length}`, traceId: `trace-${created.length}` };
    },
    async sendPrompt(input) {
      prompts.push({ taskId: input.taskId, content: input.content });
    },
  };
  return { port, created, prompts };
}

test("agents list is validated", () => {
  assert.deepEqual(parseTaskGroupAgents([{ kind: "leo" }, { kind: "acp", agentId: "codex" }]), [
    { kind: "leo" },
    { kind: "acp", agentId: "codex" },
  ]);
  assert.throws(() => parseTaskGroupAgents([]), TaskGroupError);
  assert.throws(() => parseTaskGroupAgents([{ kind: "acp", agentId: "rm -rf" }]), TaskGroupError);
  assert.throws(() => parseTaskGroupAgents(Array.from({ length: 5 }, () => ({ kind: "leo" }))), TaskGroupError);
});

test("task group: worktree per agent, diff incl. untracked, merge one, cleanup all", async () => {
  const repo = makeRepo();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "leo-group-root-")));
  const tasks = fakeTasks();
  const groups = createLeoTaskGroups({ tasks: tasks.port, workspaces: async () => [repo, join(repo, "sub")], root });

  await assert.rejects(
    groups.create({ workspacePath: "/etc", prompt: "x", agents: [{ kind: "leo" }] }),
    (error: unknown) => error instanceof TaskGroupError && error.status === 400,
  );

  const group = await groups.create({
    workspacePath: join(repo, "sub"),
    prompt: "改一下 app.txt",
    agents: [{ kind: "leo" }, { kind: "acp", agentId: "claude-code" }],
  });
  assert.equal(group.members.length, 2);
  assert.equal(group.repoRoot, repo);
  // 任务开在各自 worktree 里用户所在的子目录;外部 agent 带上 ACP 模型选择。
  assert.equal(tasks.created[0]!.workspacePath, join(group.members[0]!.worktreePath, "sub"));
  assert.equal(group.members[0]!.taskWorkspacePath, tasks.created[0]!.workspacePath);
  assert.equal(tasks.created[0]!.modelSelection, undefined);
  assert.deepEqual(
    { providerId: tasks.created[1]!.modelSelection?.providerId, modelId: tasks.created[1]!.modelSelection?.modelId },
    { providerId: "acp", modelId: "claude-code" },
  );
  assert.deepEqual(tasks.prompts.map((prompt) => prompt.content), ["改一下 app.txt", "改一下 app.txt"]);
  for (const member of group.members) {
    assert.ok(member.worktreePath.startsWith(root));
    assert.ok(member.branch.startsWith("leo/"));
    // leo.json setup 跑在 worktree 里,拿到 LEO_* 环境变量。
    assert.equal(readFileSync(join(member.worktreePath, ".leo-setup"), "utf8").trim(), member.branch);
  }

  const [first, second] = group.members;
  writeFileSync(join(first!.worktreePath, "app.txt"), "one\nTWO\nthree\n");
  writeFileSync(join(first!.worktreePath, "new.txt"), "brand new\n");
  writeFileSync(join(second!.worktreePath, "app.txt"), "uno\n");

  const diff = await groups.diff({ groupId: group.id, memberId: first!.id });
  assert.deepEqual(
    diff.files.map((file) => file.path).sort(),
    ["app.txt", "new.txt"],
  );
  assert.match(diff.patch, /\+TWO/);
  assert.equal(diff.truncated, false);

  const merged = await groups.merge({ groupId: group.id, memberId: first!.id });
  assert.equal(merged.files, 2);
  assert.equal(readFileSync(join(repo, "app.txt"), "utf8"), "one\nTWO\nthree\n");
  assert.equal(readFileSync(join(repo, "new.txt"), "utf8"), "brand new\n");
  await assert.rejects(
    groups.merge({ groupId: group.id, memberId: second!.id }),
    (error: unknown) => error instanceof TaskGroupError && error.status === 409,
  );

  const closed = await groups.cleanup({ groupId: group.id });
  assert.equal(closed.state, "closed");
  assert.deepEqual(closed.members.map((member) => member.state), ["merged", "removed"]);
  for (const member of group.members) assert.equal(existsSync(member.worktreePath), false);
  assert.equal(gitIn(repo, "branch", "--list", "leo/*").trim(), "");
  assert.equal(readFileSync(join(repo, ".leo-teardown"), "utf8").trim(), "bye");

  const listed = await groups.list();
  assert.equal(listed.groups[0]!.id, group.id);
  assert.equal(listed.groups[0]!.state, "closed");
});

test("merge conflict leaves the source repo untouched", async () => {
  const repo = makeRepo();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "leo-group-root-")));
  const groups = createLeoTaskGroups({ tasks: fakeTasks().port, workspaces: async () => [repo], root });
  const group = await groups.create({ workspacePath: repo, prompt: "x", agents: [{ kind: "leo" }] });
  writeFileSync(join(group.members[0]!.worktreePath, "app.txt"), "worktree\n");
  // 用户同时在原仓库改了同一行。
  writeFileSync(join(repo, "app.txt"), "user edit\n");
  await assert.rejects(
    groups.merge({ groupId: group.id, memberId: "1" }),
    (error: unknown) => error instanceof TaskGroupError && error.status === 409,
  );
  assert.equal(readFileSync(join(repo, "app.txt"), "utf8"), "user edit\n");
  await groups.cleanup({ groupId: group.id });
});

test("non-git workspace is refused", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "leo-group-plain-")));
  const groups = createLeoTaskGroups({ tasks: fakeTasks().port, workspaces: async () => [dir], root: join(dir, "wt") });
  await assert.rejects(
    groups.create({ workspacePath: dir, prompt: "x", agents: [{ kind: "leo" }] }),
    (error: unknown) => error instanceof TaskGroupError && error.status === 409,
  );
});

test("LeoBot member is pinned to a LeoBot model, never silently to an external agent", async () => {
  const repo = makeRepo();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "leo-group-root-")));
  const tasks = fakeTasks();
  const groups = createLeoTaskGroups({
    tasks: tasks.port,
    workspaces: async () => [repo],
    root,
    leoModelSelection: async () => ({ providerId: "openai", modelId: "gpt-5" }),
  });
  const group = await groups.create({ workspacePath: repo, prompt: "x", agents: [{ kind: "leo" }] });
  assert.deepEqual(tasks.created[0]!.modelSelection, { providerId: "openai", modelId: "gpt-5" });
  await groups.cleanup({ groupId: group.id });

  const none = fakeTasks();
  const noModel = createLeoTaskGroups({ tasks: none.port, workspaces: async () => [repo], root, leoModelSelection: async () => null });
  const failed = await noModel.create({
    workspacePath: repo,
    prompt: "x",
    agents: [{ kind: "leo" }, { kind: "acp", agentId: "codex" }],
  });
  assert.match(failed.members[0]!.error ?? "", /LeoBot 还没有可用的模型/);
  assert.equal(failed.members[0]!.taskId, undefined);
  assert.equal(none.created.length, 1);
  assert.equal(none.created[0]!.modelSelection?.modelId, "codex");
  await noModel.cleanup({ groupId: failed.id });
});

test("corrupt group index is preserved, not silently overwritten", async () => {
  const repo = makeRepo();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "leo-group-root-")));
  writeFileSync(join(root, "groups.json"), '{"version":1,"groups":[{"id":"x"');
  const { port } = fakeTasks();
  const groups = createLeoTaskGroups({ tasks: port, workspaces: async () => [repo], root });
  await assert.rejects(groups.list(), (error: unknown) => error instanceof TaskGroupError && error.status === 503);
  await assert.rejects(
    groups.create({ prompt: "p", agents: [{ kind: "leo" }], workspacePath: repo }),
    (error: unknown) => error instanceof TaskGroupError && error.status === 503,
  );
  assert.equal(readFileSync(join(root, "groups.json"), "utf8"), '{"version":1,"groups":[{"id":"x"');
});

test("model selection failure stops the LeoBot member instead of dispatching", async () => {
  const repo = makeRepo();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "leo-group-root-")));
  const { port, created } = fakeTasks();
  const groups = createLeoTaskGroups({
    tasks: port,
    workspaces: async () => [repo],
    root,
    leoModelSelection: async () => {
      throw new Error("boom");
    },
  });
  const group = await groups.create({ prompt: "p", agents: [{ kind: "leo" }], workspacePath: repo });
  assert.equal(created.length, 0);
  assert.match(group.members[0]!.error ?? "", /读取 LeoBot 模型失败/);
});

test("cleanup stops running members and keeps a patch of unadopted work", async () => {
  const repo = makeRepo();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "leo-group-root-")));
  const { port } = fakeTasks();
  const stopped: string[] = [];
  port.stopTask = async (input) => {
    stopped.push(input.taskId);
  };
  const groups = createLeoTaskGroups({ tasks: port, workspaces: async () => [repo], root });
  const group = await groups.create({ prompt: "p", agents: [{ kind: "leo" }], workspacePath: repo });
  writeFileSync(join(group.members[0]!.worktreePath, "app.txt"), "changed\n");
  await groups.cleanup({ groupId: group.id });
  assert.deepEqual(stopped, ["task-1"]);
  const snapshot = join(root, "snapshots", group.id, "1-leobot.patch");
  assert.ok(existsSync(snapshot));
  assert.match(readFileSync(snapshot, "utf8"), /changed/);
});
