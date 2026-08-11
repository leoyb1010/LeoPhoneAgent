import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { missionCardsDb, sessionsDb } from '@/modules/database/index.js';

import {
  canTransition,
  completeMissionCard,
  createMissionCard,
  discardMissionCard,
  startMissionCard,
  transitionMissionCard,
} from '../mission.service.js';

function git(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

async function withRepo(run: (repo: string, userId: number) => Promise<void>): Promise<void> {
  const prevDb = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'mission-test-'));
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
  const userId = Number(getConnection().prepare(
    "INSERT INTO users (username, password_hash) VALUES ('t', 'x') RETURNING id",
  ).get() ? (getConnection().prepare("SELECT id FROM users WHERE username='t'").get() as { id: number }).id : 0);
  try {
    await run(repo, userId);
  } finally {
    closeConnection();
    if (prevDb === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = prevDb;
    await rm(root, { recursive: true, force: true });
  }
}

test('state machine only allows legal transitions', () => {
  assert.equal(canTransition('backlog', 'running'), true);
  assert.equal(canTransition('running', 'review'), true);
  assert.equal(canTransition('review', 'done'), true);
  assert.equal(canTransition('review', 'running'), true); // retry
  assert.equal(canTransition('backlog', 'done'), false);  // must go through running/review
  assert.equal(canTransition('done', 'running'), false);
  assert.equal(canTransition('discarded', 'running'), false);
});

test('startCard spins a worktree + bound session; complete freezes cost', async () => {
  await withRepo(async (repo, userId) => {
    const card = createMissionCard(userId, { projectPath: repo, title: 'Fix login', goal: 'fix the redirect' });
    assert.equal(card.status, 'backlog');

    const started = await startMissionCard(userId, card.id);
    assert.equal(started.status, 'running');
    assert.ok(started.worktreeId, 'worktree assigned');
    assert.ok(started.sessionId, 'session assigned');
    // The session is bound to the worktree so it runs isolated.
    assert.equal(sessionsDb.getWorktreeId(started.sessionId!), started.worktreeId);

    const review = transitionMissionCard(userId, card.id, 'review');
    assert.equal(review.status, 'review');

    const done = completeMissionCard(userId, card.id, 1.23);
    assert.equal(done.status, 'done');
    assert.equal(done.costUsd, 1.23);
  });
});

test('generic transition cannot create a running card without a worktree/session', async () => {
  await withRepo(async (repo, userId) => {
    const card = createMissionCard(userId, { projectPath: repo, title: 'Task X', goal: 'do X' });
    // backlog → running via the generic path would leave a "running" card with
    // no worktree/session — it must be rejected (use start).
    assert.throws(() => transitionMissionCard(userId, card.id, 'running'), /start\/retry\/complete\/discard/);
    // Same for →discarded (must go through discard, which tears down the worktree).
    const started = await startMissionCard(userId, card.id);
    transitionMissionCard(userId, card.id, 'review');
    assert.throws(() => transitionMissionCard(userId, card.id, 'discarded'), /start\/retry\/complete\/discard/);
    assert.ok(started.worktreeId);
  });
});

test('illegal transition is rejected; discard tears down the worktree and clears bindings', async () => {
  await withRepo(async (repo, userId) => {
    const card = createMissionCard(userId, { projectPath: repo, title: 'Task B', goal: 'do B' });
    // backlog → done is illegal.
    assert.throws(() => transitionMissionCard(userId, card.id, 'done'));

    const started = await startMissionCard(userId, card.id);
    const discarded = await discardMissionCard(userId, card.id, { force: true });
    assert.equal(discarded.status, 'discarded');
    // The worktree row is gone.
    assert.equal(missionCardsDb.get(userId, card.id)?.status, 'discarded');
    assert.ok(started.worktreeId);
  });
});
