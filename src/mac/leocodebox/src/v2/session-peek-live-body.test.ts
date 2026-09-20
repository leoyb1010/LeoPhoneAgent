import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canShowLiveProposal } from './session-peek-live-body';
import { canShowPendingProposal } from './session-peek-proposal';

test('写着也能看见新的', () => {
  const looking = {
    machine: 'local',
    status: 'running',
    dirty: false,
    focusFile: 'src/a.ts',
    liveFile: 'src/a.ts',
    content: 'export const ok = 1\n',
  };
  assert.equal(canShowLiveProposal(looking), true);
  assert.equal(canShowLiveProposal({ ...looking, status: 'starting' }), true);
  assert.equal(canShowLiveProposal({ ...looking, status: 'waiting_for_approval' }), false);
  assert.equal(canShowLiveProposal({ ...looking, dirty: true }), false);
  assert.equal(canShowLiveProposal({ ...looking, focusFile: 'src/other.ts' }), false);
  assert.equal(canShowLiveProposal({ ...looking, liveFile: '' }), false);
  assert.equal(canShowLiveProposal({ ...looking, content: '' }), false);
  assert.equal(canShowLiveProposal({ ...looking, machine: 'phone' }), false);
  assert.equal(canShowPendingProposal({
    machine: 'local',
    status: 'running',
    dirty: false,
    focusFile: 'src/a.ts',
    pendingFile: 'src/a.ts',
    content: 'export const ok = 1\n',
  }), false);
});

test('2.0 写着看见新的不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /canShowLiveProposal/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /写着也能|canShowLiveProposal/);
});
