import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { unpackSessionZip } from './session-unpack.js';

function zip(cwd: string, name: string, files: string[]) {
  const result = spawnSync('/usr/bin/zip', ['-q', '-X', name, '--', ...files], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('本机 zip 能解回会话目录，穿越路径被拦', async () => {
  await assert.rejects(() => unpackSessionZip('/', { name: 'a.zip' }), /不能解开/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leo-unpack-'));
  try {
    await fs.writeFile(path.join(dir, 'kept.txt'), 'hello\n');
    zip(dir, 'pack.zip', ['kept.txt']);
    await fs.unlink(path.join(dir, 'kept.txt'));

    const unpacked = await unpackSessionZip(dir, { name: 'pack.zip' });
    assert.equal(unpacked.name, 'pack.zip');
    assert.deepEqual(unpacked.files, ['kept.txt']);
    assert.equal(await fs.readFile(path.join(dir, 'kept.txt'), 'utf8'), 'hello\n');

    const evil = path.join(dir, 'evil.zip');
    const script = [
      'import zipfile',
      `z = zipfile.ZipFile(${JSON.stringify(evil)}, "w")`,
      'z.writestr("../escape.txt", "nope")',
      'z.close()',
    ].join('\n');
    const made = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr || made.stdout);
    const escapePath = path.join(path.dirname(dir), 'escape.txt');
    const existed = await fs.access(escapePath).then(() => true).catch(() => false);
    await assert.rejects(() => unpackSessionZip(dir, { name: 'evil.zip' }), /目录外面/);
    const after = await fs.access(escapePath).then(() => true).catch(() => false);
    assert.equal(after, existed);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
