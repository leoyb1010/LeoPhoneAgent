import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { sessionTreeNeedsRefresh } from './session-tree-live';

test('写完改完目录要跟上，读和失败的不算', () => {
  assert.equal(sessionTreeNeedsRefresh({ event: 'tool.completed', tool: 'write' }), true);
  assert.equal(sessionTreeNeedsRefresh({ event: 'tool.completed', tool: 'edit' }), true);
  assert.equal(sessionTreeNeedsRefresh({ event: 'tool.completed', tool: 'write', error: true }), false);
  assert.equal(sessionTreeNeedsRefresh({ event: 'tool.completed', tool: 'read' }), false);
  assert.equal(sessionTreeNeedsRefresh({ event: 'tool.completed', tool: 'bash' }), false);
  assert.equal(sessionTreeNeedsRefresh({ event: 'tool.started', tool: 'write' }), false);
  assert.equal(sessionTreeNeedsRefresh({ event: 'tool.delta', tool: 'write' }), false);
  assert.equal(sessionTreeNeedsRefresh(null), false);
});

test('2.0 写完刷新目录，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const tree = readFileSync(fileURLToPath(new URL('../components/file-tree/view/FileTree.tsx', import.meta.url)), 'utf8');
  const hook = readFileSync(fileURLToPath(new URL('../components/file-tree/hooks/useFileTreeData.ts', import.meta.url)), 'utf8');
  assert.match(app, /sessionTreeNeedsRefresh/);
  assert.match(app, /treeTick/);
  assert.match(app, /reloadToken=\{treeTick\}/);
  assert.match(tree, /reloadToken/);
  assert.match(hook, /reloadToken/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /目录会跟上|sessionTreeNeedsRefresh|treeTick/);
});
