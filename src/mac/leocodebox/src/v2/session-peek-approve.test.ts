import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { shouldDropDirtyPeekOnApprove } from './session-peek-approve';

test('准完会换上刚批的那份', () => {
  const looking = {
    machine: 'local',
    sameSession: true,
    choice: 'once',
    dirty: true,
    focusFile: 'src/v2/App2.tsx',
    pendingFile: 'src/v2/App2.tsx',
  };
  assert.equal(shouldDropDirtyPeekOnApprove(looking), true);
  assert.equal(shouldDropDirtyPeekOnApprove({ ...looking, choice: 'always' }), true);
  assert.equal(shouldDropDirtyPeekOnApprove({ ...looking, choice: 'deny' }), false);
  assert.equal(shouldDropDirtyPeekOnApprove({ ...looking, dirty: false }), false);
  assert.equal(shouldDropDirtyPeekOnApprove({ ...looking, pendingFile: 'src/other.ts' }), false);
  assert.equal(shouldDropDirtyPeekOnApprove({ ...looking, sameSession: false }), false);
  assert.equal(shouldDropDirtyPeekOnApprove({ ...looking, machine: 'phone' }), false);
});

test('2.0 准完换预览不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /shouldDropDirtyPeekOnApprove/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /刚批的那份|shouldDropDirtyPeekOnApprove/);
});
