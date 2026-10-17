// [leo][WP-27] 并行任务组的 git worktree 操作（参照 Paseo 的目录与生命周期约定）：
//   ~/.leophoneagent/worktrees/<repoHash>/<slug>，分支 leo/<slug>；
//   仓库根 leo.json 的 {"worktree": {"setup": [...], "teardown": [...]}} 在建 / 删时执行，
//   环境变量 LEO_SOURCE_CHECKOUT_PATH / LEO_ROOT_PATH / LEO_WORKTREE_PATH / LEO_BRANCH_NAME。
// 采纳方案不要求 agent 提交：把 worktree 相对基线提交的全部改动（含未跟踪文件）打成补丁，
// 在原仓库用 git apply 落地（只改工作区、不碰暂存区；先 --check，整份补丁要么全部落地要么不动），
// 冲突时原仓库保持不变并报错。
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const LIFECYCLE_TIMEOUT_MS = 10 * 60_000;

export class WorktreeError extends Error {}

function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        maxBuffer: GIT_MAX_BUFFER,
        timeout: options.timeoutMs ?? 120_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new WorktreeError(`${command} ${args.join(" ")} 失败：${String(stderr || error.message).trim()}`));
          return;
        }
        resolvePromise(String(stdout));
      },
    );
  });
}

export function git(cwd: string, args: string[]): Promise<string> {
  return run("git", args, { cwd });
}

export function leoWorktreesRoot(env: NodeJS.ProcessEnv = process.env): string {
  const dataRoot = env.ZCODE_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".leophoneagent");
  return join(dataRoot, "worktrees");
}

export async function resolveRepoRoot(path: string): Promise<string> {
  try {
    return (await git(path, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    throw new WorktreeError("这个项目不是 git 仓库：并行任务组需要 git 来隔离各方案的改动");
  }
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "agent"
  );
}

interface LifecycleConfig {
  setup?: string[];
  teardown?: string[];
}

function readLifecycle(repoRoot: string): LifecycleConfig {
  const file = join(repoRoot, "leo.json");
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { worktree?: LifecycleConfig };
    const config = parsed.worktree ?? {};
    const commands = (value: unknown) =>
      Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
    return { setup: commands(config.setup), teardown: commands(config.teardown) };
  } catch {
    throw new WorktreeError("leo.json 不是合法的 JSON");
  }
}

async function runLifecycle(
  phase: "setup" | "teardown",
  input: { repoRoot: string; worktreePath: string; branch: string },
): Promise<void> {
  const commands = readLifecycle(input.repoRoot)[phase] ?? [];
  const env = {
    ...process.env,
    LEO_SOURCE_CHECKOUT_PATH: input.repoRoot,
    LEO_ROOT_PATH: input.repoRoot,
    LEO_WORKTREE_PATH: input.worktreePath,
    LEO_BRANCH_NAME: input.branch,
  };
  for (const command of commands) {
    await run("/bin/sh", ["-c", command], { cwd: input.worktreePath, env, timeoutMs: LIFECYCLE_TIMEOUT_MS });
  }
}

export interface CreatedWorktree {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
}

export async function createLeoWorktree(input: {
  repoPath: string;
  slug: string;
  baseCommit?: string;
  root?: string;
}): Promise<CreatedWorktree> {
  const repoRoot = await resolveRepoRoot(input.repoPath);
  const baseCommit = input.baseCommit ?? (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
  const repoHash = createHash("sha1").update(resolve(repoRoot)).digest("hex").slice(0, 12);
  const worktreePath = join(input.root ?? leoWorktreesRoot(), repoHash, input.slug);
  const branch = `leo/${input.slug}`;
  mkdirSync(join(worktreePath, ".."), { recursive: true });
  await git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, baseCommit]);
  try {
    await runLifecycle("setup", { repoRoot, worktreePath, branch });
  } catch (error) {
    await removeLeoWorktree({ repoRoot, worktreePath, branch, skipTeardown: true }).catch(() => undefined);
    throw error;
  }
  return { repoRoot, worktreePath, branch, baseCommit };
}

export interface WorktreeDiff {
  files: Array<{ status: string; path: string }>;
  patch: string;
}

/** worktree 相对基线提交的全部改动（已提交 + 未提交 + 未跟踪）。 */
export async function worktreeDiff(worktreePath: string, baseCommit: string): Promise<WorktreeDiff> {
  // intent-to-add：让未跟踪的新文件也出现在 diff 里（只动这个 worktree 自己的索引）。
  await git(worktreePath, ["add", "--all", "--intent-to-add"]);
  const [nameStatus, patch] = await Promise.all([
    git(worktreePath, ["diff", "--name-status", baseCommit]),
    git(worktreePath, ["diff", "--binary", baseCommit]),
  ]);
  const files = nameStatus
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status: status ?? "M", path: rest.at(-1) ?? "" };
    });
  return { files, patch };
}

/** 把方案落到原仓库：补丁 + git apply；失败时原仓库不变。 */
export async function applyWorktreeToRepo(input: {
  repoRoot: string;
  worktreePath: string;
  baseCommit: string;
}): Promise<{ files: number }> {
  const diff = await worktreeDiff(input.worktreePath, input.baseCommit);
  if (!diff.patch.trim()) throw new WorktreeError("这个方案没有任何改动");
  const dir = mkdtempSync(join(tmpdir(), "leo-group-patch-"));
  const patchFile = join(dir, "change.patch");
  try {
    writeFileSync(patchFile, diff.patch);
    await git(input.repoRoot, ["apply", "--check", "--whitespace=nowarn", patchFile]);
    await git(input.repoRoot, ["apply", "--whitespace=nowarn", patchFile]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { files: diff.files.length };
}

export async function removeLeoWorktree(input: {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  skipTeardown?: boolean;
}): Promise<void> {
  if (!input.skipTeardown && existsSync(input.worktreePath)) {
    await runLifecycle("teardown", input).catch(() => undefined);
  }
  await git(input.repoRoot, ["worktree", "remove", "--force", input.worktreePath]).catch(() => undefined);
  await git(input.repoRoot, ["worktree", "prune"]).catch(() => undefined);
  await git(input.repoRoot, ["branch", "-D", input.branch]).catch(() => undefined);
  rmSync(input.worktreePath, { recursive: true, force: true });
}
