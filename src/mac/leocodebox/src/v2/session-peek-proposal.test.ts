import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import type { FlowRow } from './model';
import { canShowPendingProposal, editProposalContent, pendingEditProposal } from './session-peek-proposal';

test('准之前能看见要写成什么样', () => {
  assert.equal(editProposalContent({ path: 'src/a.ts', content: 'hello' }), 'hello');
  assert.equal(editProposalContent({ path: 'src/a.ts', newText: 'next' }), 'next');
  assert.equal(editProposalContent({ command: 'ls' }), '');
  const rows: FlowRow[] = [
    {
      k: 'edit', key: '1', toolUseId: 't1', tool: 'write', file: 'src/a.ts',
      output: '', running: true, error: false, proposed: 'export const ok = 1\n',
    },
    {
      k: 'ap', key: '2', approvalId: 'a1', title: '写入', command: 'write src/a.ts',
      tool: 'write', cwd: '/tmp', host: '', choices: ['once', 'deny'],
    },
  ];
  assert.deepEqual(pendingEditProposal(rows), { file: 'src/a.ts', content: 'export const ok = 1\n' });
  assert.equal(pendingEditProposal([]), null);
  const looking = {
    machine: 'local',
    status: 'waiting_for_approval',
    dirty: false,
    focusFile: 'src/a.ts',
    pendingFile: 'src/a.ts',
    content: 'export const ok = 1\n',
  };
  assert.equal(canShowPendingProposal(looking), true);
  assert.equal(canShowPendingProposal({ ...looking, dirty: true }), false);
  assert.equal(canShowPendingProposal({ ...looking, focusFile: 'src/other.ts' }), false);
  assert.equal(canShowPendingProposal({ ...looking, content: '' }), false);
  assert.equal(canShowPendingProposal({ ...looking, status: 'running' }), false);
  assert.equal(canShowPendingProposal({ ...looking, machine: 'phone' }), false);
});

test('2.0 要写的正文不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /canShowPendingProposal/);
  assert.match(app, /pendingEditProposal/);
  assert.match(app, /peekShown/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /要写成|pendingEditProposal|canShowPendingProposal/);
  const model = readFileSync(fileURLToPath(new URL('./model.ts', import.meta.url)), 'utf8');
  assert.match(model, /proposed: editProposalContent|proposed \}/);
});
