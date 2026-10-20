/**
 * [leo-link] 改动面板:会话工作区相对 HEAD / 某轮检查点的改动、单文件 diff、回滚,以及每轮开始的检查点。
 * 接口见 docs/specs/leo-link-changes.md。全部走异步 git 子进程,cwd 是会话工作区所在仓库的根。
 *
 * 「现在的工作区」用临时 index 拍成一个树对象(复制真 index 再 `git add -A` + `write-tree`):
 * 含未跟踪文件、遵守 .gitignore,不碰用户的 index 和提交历史。检查点就是这样一棵树,
 * 包成一个无父提交挂在 refs/leobot/checkpoints/<会话>/<轮次> 上(防 gc,也带上时间和标题)。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DIFF_LIMIT_BYTES = 256 * 1024;
const GIT_TIMEOUT_MS = 60_000;
const GIT_OUTPUT_LIMIT = 64 * 1024 * 1024;
const REF_ROOT = "refs/leobot/checkpoints";
const LABEL_LIMIT = 80;
/** 检查点提交的作者:用户没配 user.name / user.email 时 commit-tree 也不能失败。 */
const CHECKPOINT_IDENTITY = {
  GIT_AUTHOR_NAME: "LeoBot",
  GIT_AUTHOR_EMAIL: "leobot@localhost",
  GIT_COMMITTER_NAME: "LeoBot",
  GIT_COMMITTER_EMAIL: "leobot@localhost",
};

export type FileStatus = "M" | "A" | "D" | "R" | "?";
export type ChangedFile = { path: string; status: FileStatus; additions: number; deletions: number; old_path?: string };
export type Checkpoint = { id: string; turn: number; created_at: string; label: string };
export type ChangesBody = { is_repo: boolean; cwd: string; branch: string | null; files: ChangedFile[]; checkpoints: Checkpoint[] };
export type DiffBody = { path: string; diff: string; truncated: boolean; binary: boolean };

/** 给路由映射 HTTP 状态用:不是仓库 409、没有这个检查点 404、路径不合法 400。 */
export class ChangesError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "ChangesError";
  }
}

type GitOptions = { env?: Record<string, string>; input?: string; limit?: number };

async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<{ stdout: Buffer; truncated: boolean }> {
  const limit = options.limit ?? GIT_OUTPUT_LIMIT;
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.quotepath=off", "--literal-pathspecs", ...args], {
      cwd,
      env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...options.env },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), GIT_TIMEOUT_MS);
    child.stdout!.on("data", (chunk: Buffer) => {
      if (truncated) return;
      chunks.push(chunk);
      size += chunk.length;
      if (size > limit) {
        // 输出够用了(diff 只要前 256KB):不等 git 写完。
        truncated = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    child.once("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 || truncated) resolve({ stdout: Buffer.concat(chunks), truncated });
      else reject(new Error(`git ${args[0]} 失败（${signal ?? code}）：${stderr.trim().slice(0, 300)}`));
    });
    if (options.input !== undefined) {
      child.stdin!.on("error", () => undefined); // git 不读 stdin 就退出时的 EPIPE
      child.stdin!.end(options.input);
    }
  });
}

async function gitText(cwd: string, args: string[], options?: GitOptions): Promise<string> {
  return (await git(cwd, args, options)).stdout.toString("utf8").trim();
}

/** 会话工作区所在仓库的根;不是 git 仓库(或目录不存在、没装 git)返回 null。 */
export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    return (await gitText(cwd, ["rev-parse", "--show-toplevel"])) || null;
  } catch {
    return null;
  }
}

async function requireRoot(cwd: string): Promise<string> {
  const root = await repoRoot(cwd);
  if (!root) throw new ChangesError(409, "这个工作区不是 git 仓库");
  return root;
}

/** 手机传来的相对路径(相对仓库根):挡掉绝对路径、`..` 越界和 .git 里面的东西。 */
export function safeRelativePath(input: unknown): string {
  if (typeof input !== "string" || !input.trim() || input.includes("\0")) throw new ChangesError(400, "path 不合法");
  const normalized = path.posix.normalize(input.trim().replace(/\\/g, "/"));
  if (
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized === "." ||
    normalized === ".git" ||
    normalized.startsWith(".git/")
  ) {
    throw new ChangesError(400, `path 不合法：${input}`);
  }
  return normalized;
}

/** 当前工作区拍成的树(含未跟踪、遵守 .gitignore);用临时 index,不动用户的 index。 */
async function worktreeTree(root: string): Promise<string> {
  const indexFile = path.join(os.tmpdir(), `leobot-index-${randomUUID()}`);
  try {
    const realIndex = path.resolve(root, await gitText(root, ["rev-parse", "--git-path", "index"]));
    // 从真 index 起步:没改过的文件 stat 一致,add -A 不用重新读内容。新仓库还没有 index 就从空的起步。
    await fsp.copyFile(realIndex, indexFile).catch(() => undefined);
    const env = { GIT_INDEX_FILE: indexFile };
    await git(root, ["add", "-A", "--", "."], { env });
    return await gitText(root, ["write-tree"], { env });
  } finally {
    await fsp.rm(indexFile, { force: true });
  }
}

async function headTree(root: string): Promise<string> {
  try {
    return await gitText(root, ["rev-parse", "--verify", "-q", "HEAD^{tree}"]);
  } catch {
    // 还没有提交:相对空树。
    return gitText(root, ["hash-object", "-t", "tree", "--stdin"], { input: "" });
  }
}

/** 会话 id 只用安全字符拼进 ref 名(ref 不许有 `..`、`:`、`*`、`.lock` 之类)。 */
function refPrefix(sessionId: string): string {
  return `${REF_ROOT}/${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function isoSeconds(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z") : value;
}

export async function listCheckpoints(root: string, sessionId: string): Promise<Checkpoint[]> {
  const out = await gitText(root, [
    "for-each-ref",
    "--format=%(refname)%00%(creatordate:iso-strict)%00%(contents:subject)",
    `${refPrefix(sessionId)}/`,
  ]);
  const checkpoints: Checkpoint[] = [];
  for (const line of out ? out.split("\n") : []) {
    const [ref = "", createdAt = "", label = ""] = line.split("\0");
    const turn = Number(ref.slice(ref.lastIndexOf("/") + 1));
    if (!Number.isSafeInteger(turn) || turn <= 0) continue;
    checkpoints.push({ id: String(turn), turn, created_at: isoSeconds(createdAt), label });
  }
  return checkpoints.sort((a, b) => a.turn - b.turn);
}

async function checkpointTree(root: string, sessionId: string, id: unknown): Promise<string> {
  if (typeof id !== "string" || !/^\d{1,9}$/.test(id)) throw new ChangesError(400, "checkpoint 不合法");
  try {
    return await gitText(root, ["rev-parse", "--verify", "-q", `${refPrefix(sessionId)}/${id}^{tree}`]);
  } catch {
    throw new ChangesError(404, `没有这个检查点：${id}`);
  }
}

/** 每轮开始时调用:非 git 目录返回 null。轮次接着这个会话已有的检查点往下编。调用方负责同一会话串行。 */
export async function createCheckpoint(cwd: string, sessionId: string, label: string): Promise<Checkpoint | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;
  const tree = await worktreeTree(root);
  const existing = await listCheckpoints(root, sessionId);
  const turn = (existing.at(-1)?.turn ?? 0) + 1;
  const subject = label.replace(/\s+/g, " ").trim().slice(0, LABEL_LIMIT) || `第 ${turn} 轮`;
  const commit = await gitText(root, ["commit-tree", tree, "-m", subject], { env: CHECKPOINT_IDENTITY });
  await git(root, ["update-ref", `${refPrefix(sessionId)}/${turn}`, commit]);
  return { id: String(turn), turn, created_at: isoSeconds(new Date().toISOString()), label: subject };
}

function splitZ(buffer: Buffer): string[] {
  const parts = buffer.toString("utf8").split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

function fileStatus(code: string): Exclude<FileStatus, "?"> {
  if (code === "A" || code === "D" || code === "R") return code;
  if (code === "C") return "A";
  return "M";
}

async function diffFiles(root: string, from: string, to: string): Promise<ChangedFile[]> {
  const [names, numstat, untracked] = await Promise.all([
    git(root, ["diff-tree", "-r", "-z", "-M", "--name-status", from, to]),
    git(root, ["diff-tree", "-r", "-z", "-M", "--numstat", from, to]),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const counts = new Map<string, { additions: number; deletions: number }>();
  const stats = splitZ(numstat.stdout);
  for (let i = 0; i < stats.length; i++) {
    // "增\t删\t路径" 或改名时 "增\t删\t" 后跟 旧路径、新路径 两段。
    const [added = "0", deleted = "0", inlinePath = ""] = stats[i]!.split("\t");
    const file = inlinePath || ((i += 2), stats[i] ?? "");
    counts.set(file, { additions: Number(added) || 0, deletions: Number(deleted) || 0 });
  }
  const untrackedSet = new Set(splitZ(untracked.stdout));
  const files: ChangedFile[] = [];
  const entries = splitZ(names.stdout);
  for (let i = 0; i < entries.length; i++) {
    const code = entries[i]!.charAt(0);
    const status = fileStatus(code);
    const oldPath = code === "R" || code === "C" ? entries[++i] : undefined;
    const file = entries[++i] ?? "";
    const count = counts.get(file) ?? { additions: 0, deletions: 0 };
    files.push({
      path: file,
      status: status === "A" && untrackedSet.has(file) ? "?" : status,
      ...count,
      ...(status === "R" && oldPath ? { old_path: oldPath } : {}),
    });
  }
  return files;
}

async function currentBranch(root: string): Promise<string | null> {
  try {
    return (await gitText(root, ["symbolic-ref", "--short", "-q", "HEAD"])) || null;
  } catch {
    return null;
  }
}

/** GET /harness/sessions/:id/changes */
export async function workspaceChanges(cwd: string, sessionId: string): Promise<ChangesBody> {
  const root = await repoRoot(cwd);
  if (!root) return { is_repo: false, cwd, branch: null, files: [], checkpoints: [] };
  const [base, now, branch, checkpoints] = await Promise.all([
    headTree(root),
    worktreeTree(root),
    currentBranch(root),
    listCheckpoints(root, sessionId),
  ]);
  return { is_repo: true, cwd, branch, files: await diffFiles(root, base, now), checkpoints };
}

/** GET /harness/sessions/:id/diff?path=…[&checkpoint=…] */
export async function fileDiff(cwd: string, sessionId: string, file: unknown, checkpoint?: string): Promise<DiffBody> {
  const relative = safeRelativePath(file);
  const root = await requireRoot(cwd);
  const [base, now] = await Promise.all([
    checkpoint === undefined ? headTree(root) : checkpointTree(root, sessionId, checkpoint),
    worktreeTree(root),
  ]);
  const out = await git(
    root,
    ["diff", "--no-color", "--no-ext-diff", "--no-textconv", base, now, "--", relative],
    { limit: DIFF_LIMIT_BYTES },
  );
  const truncated = out.truncated || out.stdout.length > DIFF_LIMIT_BYTES;
  let bytes = out.stdout.subarray(0, DIFF_LIMIT_BYTES);
  // 截断时停在整行上,别切出半个 UTF-8 字符。
  if (truncated) bytes = bytes.subarray(0, bytes.lastIndexOf(10) + 1);
  const diff = bytes.toString("utf8");
  return { path: relative, diff, truncated, binary: /^Binary files .* differ$/m.test(diff) || diff.includes("GIT binary patch") };
}

async function pruneEmptyDirs(root: string, file: string): Promise<void> {
  for (let dir = path.dirname(file); dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
    try {
      await fsp.rmdir(dir);
    } catch {
      return; // 不空或已不在
    }
  }
}

/**
 * POST /harness/sessions/:id/revert:把工作区(paths 为空 = 全部)恢复到检查点那棵树,只带 paths 时恢复到 HEAD。
 * 那时没有、现在有的文件删掉;其余从目标树写回。只动工作区:用户的 index、提交历史都不碰。
 */
export async function revertChanges(
  cwd: string,
  sessionId: string,
  options: { checkpoint?: string; paths?: unknown[] },
): Promise<{ reverted: string[]; checkpoint?: string }> {
  const paths = (options.paths ?? []).map(safeRelativePath);
  if (options.checkpoint === undefined && paths.length === 0) throw new ChangesError(400, "需要 checkpoint 或 paths");
  const root = await requireRoot(cwd);
  const [target, now] = await Promise.all([
    options.checkpoint === undefined ? headTree(root) : checkpointTree(root, sessionId, options.checkpoint),
    worktreeTree(root),
  ]);
  const changed = splitZ(
    (await git(root, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", target, now, "--", ...paths])).stdout,
  );
  const remove: string[] = [];
  const restore: string[] = [];
  for (let i = 0; i + 1 < changed.length; i += 2) {
    (changed[i] === "A" ? remove : restore).push(changed[i + 1]!);
  }
  for (const file of remove) {
    const absolute = path.resolve(root, file);
    if (!absolute.startsWith(root + path.sep)) continue;
    await fsp.rm(absolute, { force: true });
    await pruneEmptyDirs(root, absolute);
  }
  if (restore.length) {
    const indexFile = path.join(os.tmpdir(), `leobot-index-${randomUUID()}`);
    try {
      const env = { GIT_INDEX_FILE: indexFile };
      await git(root, ["read-tree", target], { env });
      await git(root, ["checkout-index", "-f", "-z", "--stdin"], { env, input: restore.join("\0") });
    } finally {
      await fsp.rm(indexFile, { force: true });
    }
  }
  return {
    reverted: [...remove, ...restore].sort(),
    ...(options.checkpoint === undefined ? {} : { checkpoint: options.checkpoint }),
  };
}
