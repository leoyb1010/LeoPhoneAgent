import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertRealPathWithinRoot,
  getFileTree,
  validatePathInProject,
} from '../files.service.js';

test('file path validation rejects lexical traversal and accepts descendants', () => {
  const root = path.resolve('/tmp/workspace-root');
  assert.equal(validatePathInProject(root, 'src/index.ts').valid, true);
  assert.equal(validatePathInProject(root, '../secret.txt').valid, false);
  assert.equal(validatePathInProject(root, root).valid, false);
});

test('realpath validation rejects symlink escapes and permits missing descendants', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'leocodebox-files-security-'));
  const root = path.join(temp, 'root');
  const outside = path.join(temp, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
  await fs.symlink(outside, path.join(root, 'escape'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));

  const escaped = await assertRealPathWithinRoot(root, path.join(root, 'escape', 'secret.txt'));
  assert.equal(escaped.valid, false);
  const missing = await assertRealPathWithinRoot(root, path.join(root, 'new', 'file.txt'), { allowMissing: true });
  assert.equal(missing.valid, true);
  assert.equal(missing.realPath, path.join(await fs.realpath(root), 'new', 'file.txt'));
});

test('file tree skips dependency and VCS directories', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leocodebox-file-tree-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.mkdir(path.join(root, '.git'));
  await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export {};');
  const tree = await getFileTree(root, 2);
  assert.deepEqual(tree.map((entry) => entry.name), ['src']);
  assert.equal(tree[0]!.children![0]!.name, 'index.ts');
});
