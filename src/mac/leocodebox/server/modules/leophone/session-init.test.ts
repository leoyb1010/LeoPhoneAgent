import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { initSessionRepo } from './session-init.js';

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('本机目录能做成仓库，已经是仓库不会重来，穿越目录会被拦', async () => {
  await assert.rejects(() => initSessionRepo('/'), /不能做成仓库/);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'leo-init-'));
  try {
    await fsp.writeFile(path.join(dir, 'notes.txt'), 'hello\n');
    const created = await initSessionRepo(dir);
    assert.equal(created.created, true);
    assert.equal(await fsp.realpath(created.root), await fsp.realpath(dir));
    assert.ok(fs.existsSync(path.join(dir, '.git')));
    const again = await initSessionRepo(dir);
    assert.equal(again.created, false);
    assert.equal(await fsp.realpath(again.root), await fsp.realpath(dir));
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'test']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    git(dir, ['add', 'notes.txt']);
    git(dir, ['commit', '-m', 'first']);
    const afterCommit = await initSessionRepo(dir);
    assert.equal(afterCommit.created, false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('路由挂在本机 init', () => {
  const routes = fs.readFileSync(fileURLToPath(new URL('./workbench.routes.ts', import.meta.url)), 'utf8');
  assert.match(routes, /\/leophone\/local\/sessions\/:sessionId\/init/);
  assert.match(routes, /initSessionRepo/);
});
