/**
 * Worktree fleet (L3). Each parallel agent task runs in its own git worktree
 * under <project>/.leocodebox/worktrees/<slug> on branch lcb/<slug>, so N
 * sessions can run against the same repo without stepping on each other. When a
 * task is done its branch is merged back (with a no-mutation conflict preview
 * first) or discarded. All git calls go through a hardened spawn (stdin
 * ignored) to avoid the packaged-GUI EBADF race.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import spawn from 'cross-spawn';

import { worktreesDb, type StoredWorktree } from '../database/index.js';

type StatusError = Error & { statusCode?: number };
function fail(message: string, statusCode = 400): StatusError {
  const error: StatusError = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/** Hardened git runner: stdin ignored (packaged GUI has no real stdin). */
function runGit(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: { ok: boolean; stdout: string; stderr: string; code: number | null }) => {
      if (settled) return; settled = true; clearTimeout(timer); resolve(r);
    };
    let child;
    try {
      child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    } catch (error) {
      resolve({ ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error), code: null });
      return;
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish({ ok: false, stdout, stderr, code: null }); }, 60_000);
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', (error: NodeJS.ErrnoException) => finish({ ok: false, stdout, stderr, code: error.code === 'ENOENT' ? 127 : null }));
    child.on('close', (code) => finish({ ok: code === 0, stdout, stderr, code }));
  });
}

/** Slug: lowercase, path-safe AND git-refname-safe. Never contains "/" or a
 * ".." sequence (both would break `lcb/<slug>` as a branch or escape the dir). */
export function sanitizeWorktreeSlug(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')      // collapse ".." — invalid in a git refname
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
}

async function assertGitRepo(projectPath: string): Promise<void> {
  const inside = await runGit(projectPath, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') throw fail('Not a git repository.', 400);
}

async function currentBranch(cwd: string): Promise<string> {
  const res = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return res.ok ? res.stdout.trim() : 'HEAD';
}

export type WorktreeStatus = StoredWorktree & {
  exists: boolean;
  dirtyCount: number;
  ahead: number;
  behind: number;
  baseBranch: string;
};

export async function createWorktree(projectPath: string, rawSlug: string): Promise<StoredWorktree> {
  await assertGitRepo(projectPath);
  const slug = sanitizeWorktreeSlug(rawSlug);
  if (!slug) throw fail('A worktree slug is required.', 400);
  if (worktreesDb.hasSlug(projectPath, slug)) throw fail('A worktree with this slug already exists.', 409);

  const branch = `lcb/${slug}`;
  const worktreePath = path.join(projectPath, '.leocodebox', 'worktrees', slug);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });

  // Keep the worktree dir out of the parent repo's own status.
  try {
    const excludePath = path.join(projectPath, '.git', 'info', 'exclude');
    const existing = await fs.readFile(excludePath, 'utf8').catch(() => '');
    if (!existing.includes('.leocodebox/worktrees')) {
      await fs.appendFile(excludePath, `${existing.endsWith('\n') || !existing ? '' : '\n'}.leocodebox/worktrees/\n`);
    }
  } catch { /* exclude is best-effort */ }

  const add = await runGit(projectPath, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
  if (!add.ok) throw fail(`git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`, 500);

  return worktreesDb.create({ id: `wt-${slug}-${Date.now().toString(36)}`, projectPath, slug, branch, path: worktreePath });
}

export function listWorktrees(projectPath?: string): StoredWorktree[] {
  return projectPath ? worktreesDb.listByProject(projectPath) : worktreesDb.listAll();
}

export async function worktreeStatus(id: string): Promise<WorktreeStatus> {
  const wt = worktreesDb.get(id);
  if (!wt) throw fail('Unknown worktree.', 404);
  const exists = await fs.stat(wt.path).then((s) => s.isDirectory()).catch(() => false);
  if (!exists) return { ...wt, exists: false, dirtyCount: 0, ahead: 0, behind: 0, baseBranch: '' };

  const porcelain = await runGit(wt.path, ['status', '--porcelain']);
  const dirtyCount = porcelain.ok ? porcelain.stdout.split('\n').filter((line) => line.trim()).length : 0;
  const baseBranch = await currentBranch(wt.projectPath);
  const counts = await runGit(wt.path, ['rev-list', '--left-right', '--count', `${baseBranch}...HEAD`]);
  let ahead = 0; let behind = 0;
  if (counts.ok) {
    const [b, a] = counts.stdout.trim().split(/\s+/).map((n) => Number(n) || 0);
    behind = b; ahead = a;
  }
  return { ...wt, exists: true, dirtyCount, ahead, behind, baseBranch };
}

/** No-mutation conflict preview via `git merge-tree --write-tree`. */
export async function previewMerge(id: string): Promise<{ clean: boolean; conflicts: string[] }> {
  const wt = worktreesDb.get(id);
  if (!wt) throw fail('Unknown worktree.', 404);
  const baseBranch = await currentBranch(wt.projectPath);
  const res = await runGit(wt.projectPath, ['merge-tree', '--write-tree', '--name-only', baseBranch, wt.branch]);
  if (res.ok) return { clean: true, conflicts: [] };
  // Exit 1 = conflicts. Exit 128 (or anything else) = a hard error (unrelated
  // histories, bad ref) — surface it rather than pretending everything conflicts.
  if (res.code !== 1) throw fail(`merge preview failed: ${res.stderr.trim() || res.stdout.trim()}`, 500);
  // On conflict the output is: <tree-oid> \n <conflicted file>* \n (blank) \n
  // <informational messages>*. Take only the file section between the OID line
  // and the first blank line — do NOT strip blanks, they delimit the section.
  const lines = res.stdout.split('\n');
  const conflicts: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === '') break;
    conflicts.push(line.trim());
  }
  return { clean: false, conflicts };
}

export async function mergeWorktree(id: string, options: { squash?: boolean } = {}): Promise<{ merged: boolean; conflicts: string[] }> {
  const wt = worktreesDb.get(id);
  if (!wt) throw fail('Unknown worktree.', 404);
  const preview = await previewMerge(id);
  if (!preview.clean) return { merged: false, conflicts: preview.conflicts };

  const args = options.squash
    ? ['merge', '--squash', wt.branch]
    : ['merge', '--no-ff', '-m', `Merge ${wt.branch}`, wt.branch];
  const merge = await runGit(wt.projectPath, args);
  if (!merge.ok) throw fail(`git merge failed: ${merge.stderr.trim() || merge.stdout.trim()}`, 500);
  if (options.squash) {
    // --squash stages without committing; finalize so the merge is a real commit.
    const commit = await runGit(wt.projectPath, ['commit', '-m', `Squash-merge ${wt.branch}`]);
    if (!commit.ok && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
      throw fail(`git commit (squash) failed: ${commit.stderr.trim()}`, 500);
    }
  }
  return { merged: true, conflicts: [] };
}

export async function discardWorktree(id: string, options: { force?: boolean } = {}): Promise<{ removed: boolean; dirtyCount?: number }> {
  const wt = worktreesDb.get(id);
  if (!wt) throw fail('Unknown worktree.', 404);
  const status = await worktreeStatus(id).catch(() => null);
  if (status?.exists && status.dirtyCount > 0 && !options.force) {
    // Refuse to silently destroy uncommitted work — caller must confirm.
    throw fail(`Worktree has ${status.dirtyCount} uncommitted change(s); pass force to discard.`, 409);
  }
  if (status?.exists) {
    await runGit(wt.projectPath, ['worktree', 'remove', '--force', wt.path]);
  } else {
    // Directory already gone — prune the parent's registry so the branch can be deleted.
    await runGit(wt.projectPath, ['worktree', 'prune']);
  }
  await runGit(wt.projectPath, ['branch', '-D', wt.branch]);
  worktreesDb.delete(id);
  return { removed: true };
}

/**
 * Worktrees tracked in the DB whose directory no longer exists — surfaced for a
 * one-click cleanup rather than deleted automatically.
 */
export async function scanWorktreeOrphans(projectPath?: string): Promise<StoredWorktree[]> {
  const all = listWorktrees(projectPath);
  const orphans: StoredWorktree[] = [];
  for (const wt of all) {
    const exists = await fs.stat(wt.path).then((s) => s.isDirectory()).catch(() => false);
    if (!exists) orphans.push(wt);
  }
  return orphans;
}
