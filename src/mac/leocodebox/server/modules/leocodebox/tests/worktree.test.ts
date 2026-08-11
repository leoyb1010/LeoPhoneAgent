import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';

import {
  createWorktree,
  discardWorktree,
  listWorktrees,
  mergeWorktree,
  previewMerge,
  sanitizeWorktreeSlug,
  worktreeStatus,
} from '../worktree.service.js';

function git(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

/** Temp git repo + isolated DB. */
async function withRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const prevDb = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'wt-test-'));
  const repo = path.join(root, 'repo');
  await mkdir(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@t.dev']);
  git(repo, ['config', 'user.name', 'T']);
  await writeFile(path.join(repo, 'README.md'), '# base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'base']);

  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  try {
    await run(repo);
  } finally {
    closeConnection();
    if (prevDb === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = prevDb;
    await rm(root, { recursive: true, force: true });
  }
}

test('slug sanitization strips path traversal and unsafe chars', () => {
  assert.equal(sanitizeWorktreeSlug('../../etc/passwd'), 'etc-passwd');
  assert.equal(sanitizeWorktreeSlug('Fix Login Bug!'), 'fix-login-bug');
  assert.equal(sanitizeWorktreeSlug(''), '');
});

test('create → status → clean merge back to main', async () => {
  await withRepo(async (repo) => {
    const wt = await createWorktree(repo, 'feature-a');
    assert.equal(wt.branch, 'lcb/feature-a');
    assert.ok(await stat(wt.path).then((s) => s.isDirectory()));
    assert.equal(listWorktrees(repo).length, 1);

    // Commit a change inside the worktree.
    await writeFile(path.join(wt.path, 'a.txt'), 'from worktree\n');
    git(wt.path, ['add', '.']);
    git(wt.path, ['commit', '-q', '-m', 'add a']);

    const status = await worktreeStatus(wt.id);
    assert.equal(status.exists, true);
    assert.equal(status.ahead, 1);

    const preview = await previewMerge(wt.id);
    assert.equal(preview.clean, true);

    const merged = await mergeWorktree(wt.id);
    assert.equal(merged.merged, true);
    // The change is now on main.
    assert.equal(await readFile(path.join(repo, 'a.txt'), 'utf8'), 'from worktree\n');
  });
});

test('preview lists ONLY conflicted files (not clean files or info messages)', async () => {
  await withRepo(async (repo) => {
    const wt = await createWorktree(repo, 'feature-b');
    // README.md conflicts; shared.txt is added only on the worktree side (merges clean).
    await writeFile(path.join(repo, 'README.md'), '# main side\n');
    git(repo, ['commit', '-q', '-am', 'main change']);
    await writeFile(path.join(wt.path, 'README.md'), '# worktree side\n');
    await writeFile(path.join(wt.path, 'shared.txt'), 'clean add\n');
    git(wt.path, ['add', '.']);
    git(wt.path, ['commit', '-q', '-m', 'worktree change']);

    const preview = await previewMerge(wt.id);
    assert.equal(preview.clean, false);
    // Exactly the conflicted file — the cleanly-merged shared.txt and any
    // "Auto-merging ..." info lines must NOT appear.
    assert.deepEqual(preview.conflicts, ['README.md']);

    const merged = await mergeWorktree(wt.id);
    assert.equal(merged.merged, false);
  });
});

test('discard refuses dirty worktree without force, then removes with force', async () => {
  await withRepo(async (repo) => {
    const wt = await createWorktree(repo, 'feature-c');
    await writeFile(path.join(wt.path, 'dirty.txt'), 'uncommitted\n');

    await assert.rejects(() => discardWorktree(wt.id), /uncommitted/i);
    const removed = await discardWorktree(wt.id, { force: true });
    assert.equal(removed.removed, true);
    assert.equal(listWorktrees(repo).length, 0);
    assert.equal(await stat(wt.path).then(() => true).catch(() => false), false);
  });
});
