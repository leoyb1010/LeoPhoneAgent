import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { agentProfilesDb, normalizeAgentProfile } from '@/modules/database/repositories/agent-profiles.db.js';
import { userDb } from '@/modules/database/repositories/users.js';

async function withIsolatedDatabase(runTest: (userId: number) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'agent-profiles-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    const user = userDb.createUser('profile-user', 'hash');
    await runTest(Number(user.id));
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const sample = {
  name: '代码审查员',
  emoji: '🔍',
  provider: 'claude',
  model: 'default',
  effort: 'high',
  permissionMode: 'plan',
  openingPrompt: '审查当前分支的改动',
  notes: '严格模式',
};

test('createProfile stores and returns a normalized profile with id + timestamps', async () => {
  await withIsolatedDatabase((userId) => {
    const created = agentProfilesDb.createProfile(userId, sample);
    assert.ok(created.id);
    assert.equal(created.name, '代码审查员');
    assert.equal(created.provider, 'claude');
    assert.equal(created.permissionMode, 'plan');
    assert.ok(created.createdAt);
    assert.ok(created.updatedAt);
  });
});

test('listProfiles returns a user only their own profiles', async () => {
  await withIsolatedDatabase((userId) => {
    const other = userDb.createUser('other-user', 'hash');
    agentProfilesDb.createProfile(userId, sample);
    agentProfilesDb.createProfile(Number(other.id), { ...sample, name: '别人的' });

    const mine = agentProfilesDb.listProfiles(userId);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].name, '代码审查员');
  });
});

test('updateProfile overwrites payload; unknown id returns null', async () => {
  await withIsolatedDatabase((userId) => {
    const created = agentProfilesDb.createProfile(userId, sample);
    const updated = agentProfilesDb.updateProfile(userId, created.id, { ...sample, name: '改名了', effort: 'low' });
    assert.ok(updated);
    assert.equal(updated?.name, '改名了');
    assert.equal(updated?.effort, 'low');
    assert.equal(updated?.id, created.id);

    assert.equal(agentProfilesDb.updateProfile(userId, 'does-not-exist', sample), null);
  });
});

test('deleteProfile removes only the owner row and reports success', async () => {
  await withIsolatedDatabase((userId) => {
    const created = agentProfilesDb.createProfile(userId, sample);
    assert.equal(agentProfilesDb.deleteProfile(userId, created.id), true);
    assert.equal(agentProfilesDb.getProfile(userId, created.id), null);
    assert.equal(agentProfilesDb.deleteProfile(userId, created.id), false);
  });
});

test('getProfile is owner-scoped — another user cannot read it', async () => {
  await withIsolatedDatabase((userId) => {
    const other = userDb.createUser('intruder', 'hash');
    const created = agentProfilesDb.createProfile(userId, sample);
    assert.equal(agentProfilesDb.getProfile(Number(other.id), created.id), null);
  });
});

test('importProfiles bulk-creates with fresh ids, never clobbering', async () => {
  await withIsolatedDatabase((userId) => {
    const first = agentProfilesDb.createProfile(userId, sample);
    const imported = agentProfilesDb.importProfiles(userId, [
      { ...sample, id: first.id, name: '导入A' },
      { ...sample, name: '导入B' },
    ]);
    assert.equal(imported.length, 2);
    // The colliding id in the payload is ignored — a new id is minted.
    assert.notEqual(imported[0].id, first.id);
    assert.equal(agentProfilesDb.listProfiles(userId).length, 3);
  });
});

test('normalizeAgentProfile clamps invalid provider and fills defaults', () => {
  const normalized = normalizeAgentProfile({ provider: 'nonsense-cli', name: '  x  ', extra: 'ignored' });
  assert.equal(normalized.provider, 'claude');
  assert.equal(normalized.name, 'x');
  assert.equal(normalized.emoji, '🤖');
  assert.equal(normalized.model, 'default');
  assert.equal(normalized.permissionMode, 'default');
});

test('normalizeAgentProfile preserves grok as a first-class provider', () => {
  // grok is a supported runtime provider — it must NOT be clamped to claude.
  const normalized = normalizeAgentProfile({ provider: 'grok', name: 'g' });
  assert.equal(normalized.provider, 'grok');
});

test('normalizeAgentProfile survives round-trip of malformed JSON blob', async () => {
  await withIsolatedDatabase((userId) => {
    // Persist then confirm a garbage provider never leaks through.
    const created = agentProfilesDb.createProfile(userId, { ...sample, provider: 'not-a-provider' });
    assert.equal(created.provider, 'claude');
    const reread = agentProfilesDb.getProfile(userId, created.id);
    assert.equal(reread?.provider, 'claude');
  });
});
