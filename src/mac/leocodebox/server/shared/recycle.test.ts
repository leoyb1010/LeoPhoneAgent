import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { listRecycled, pruneExpiredRecycled, recyclePath, restoreRecycled } from './recycle.js';

const withTrash = async (fn: (ctx: { dir: string; trash: string }) => Promise<void>) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'leocodebox-recycle-'));
  const trash = path.join(dir, 'trash');
  const prev = process.env.LEOCODEBOX_TRASH_DIR;
  process.env.LEOCODEBOX_TRASH_DIR = trash;
  try {
    await fn({ dir, trash });
  } finally {
    if (prev === undefined) delete process.env.LEOCODEBOX_TRASH_DIR;
    else process.env.LEOCODEBOX_TRASH_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
};

const makeSkillDir = async (root: string, name: string) => {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), '# demo skill\n', 'utf8');
  return dir;
};

test('recyclePath moves a directory out of place and records a manifest', async () => {
  await withTrash(async ({ dir }) => {
    const skill = await makeSkillDir(dir, 'my-skill');
    const entry = await recyclePath(skill, { reason: 'test' });
    assert.equal(existsSync(skill), false, 'source directory should be gone');
    assert.equal(existsSync(entry.trashPath), true, 'content should be in trash');
    assert.equal(await readFile(path.join(entry.trashPath, 'SKILL.md'), 'utf8'), '# demo skill\n');
    const listed = await listRecycled();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].originalPath, path.resolve(skill));
  });
});

test('restoreRecycled puts the directory back at its original path', async () => {
  await withTrash(async ({ dir }) => {
    const skill = await makeSkillDir(dir, 'restore-me');
    const entry = await recyclePath(skill);
    const result = await restoreRecycled(entry.id);
    assert.equal(result.restored, true);
    assert.equal(existsSync(skill), true, 'skill should be back');
    assert.equal(await readFile(path.join(skill, 'SKILL.md'), 'utf8'), '# demo skill\n');
    assert.equal((await listRecycled()).length, 0, 'manifest consumed on restore');
  });
});

test('restoreRecycled throws a clean 404 (no raw fs path) for an unknown/already-restored id', async () => {
  await withTrash(async () => {
    await assert.rejects(
      () => restoreRecycled('1784000000000-gone-deadbeef'),
      (error: Error & { statusCode?: number }) => {
        assert.equal(error.statusCode, 404);
        assert.doesNotMatch(error.message, /\//, 'must not leak an absolute path');
        return true;
      },
    );
  });
});

test('restoreRecycled refuses to clobber an existing path', async () => {
  await withTrash(async ({ dir }) => {
    const skill = await makeSkillDir(dir, 'conflict');
    const entry = await recyclePath(skill);
    await makeSkillDir(dir, 'conflict'); // something new took the original path
    const result = await restoreRecycled(entry.id);
    assert.equal(result.restored, false, 'should not overwrite the new content');
  });
});

test('pruneExpiredRecycled deletes entries older than the retention window', async () => {
  await withTrash(async ({ trash }) => {
    const skill = await makeSkillDir(await mkdtemp(path.join(os.tmpdir(), 'src-')), 'old');
    const entry = await recyclePath(skill);
    // Backdate the manifest well beyond the 30-day window.
    const manifest = path.join(trash, `${entry.id}.json`);
    const aged = { ...JSON.parse(await readFile(manifest, 'utf8')), recycledAt: '2000-01-01T00:00:00.000Z' };
    await writeFile(manifest, JSON.stringify(aged), 'utf8');
    await pruneExpiredRecycled();
    assert.equal(existsSync(manifest), false, 'aged manifest pruned');
    assert.equal(existsSync(entry.trashPath), false, 'aged content pruned');
  });
});
