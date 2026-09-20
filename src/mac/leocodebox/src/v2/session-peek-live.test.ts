import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canPeekLiveEdit } from './session-peek-live';

test('正在写的会打开', () => {
  const looking = {
    machine: 'local',
    status: 'running',
    dirty: false,
    focusFile: null as string | null,
    liveFile: 'src/a.ts',
  };
  assert.equal(canPeekLiveEdit(looking), true);
  assert.equal(canPeekLiveEdit({ ...looking, status: 'starting' }), true);
  assert.equal(canPeekLiveEdit({ ...looking, status: 'waiting_for_approval' }), false);
  assert.equal(canPeekLiveEdit({ ...looking, dirty: true }), false);
  assert.equal(canPeekLiveEdit({ ...looking, focusFile: 'src/a.ts' }), false);
  assert.equal(canPeekLiveEdit({ ...looking, liveFile: '' }), false);
  assert.equal(canPeekLiveEdit({ ...looking, machine: 'phone' }), false);
});

test('2.0 正在写的不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /canPeekLiveEdit/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /正在写|canPeekLiveEdit/);
});
