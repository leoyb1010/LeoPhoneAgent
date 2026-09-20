import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { applyEvent, emptyView } from './model';
import { canApproveOnEnter } from './session-approve-enter';
import { askChoices, askRespondedLabel, isAskMethod } from './session-ask';

test('问你的时候能直接答', () => {
  assert.equal(isAskMethod('input'), true);
  assert.equal(isAskMethod('editor'), true);
  assert.equal(isAskMethod('select'), false);
  assert.deepEqual(askChoices(), ['reply', 'deny']);
  assert.equal(askRespondedLabel('reply', '用 vitest'), '已回答:用 vitest');
  assert.equal(askRespondedLabel('deny'), null);
  let view = applyEvent(emptyView(), {
    event: 'approval.request',
    request_id: 'ask-1',
    title: '测哪个文件',
    command: 'src/…',
    method: 'input',
    placeholder: '路径',
    choices: askChoices(),
  });
  assert.equal(view.status, 'waiting_for_approval');
  const card = view.rows.find((row) => row.k === 'ap');
  assert.equal(card && card.k === 'ap' ? card.method : '', 'input');
  assert.equal(canApproveOnEnter({
    machine: 'local', status: 'waiting_for_approval', pendingCount: 1, askFirst: true,
  }), false);
  view = applyEvent(view, { event: 'approval.responded', approval_id: 'ask-1', choice: 'reply', reason: '用 vitest' });
  assert.equal(view.rows.filter((row) => row.k === 'sys').at(-1)?.text, '已回答:用 vitest · src/…');
});

test('2.0 问答不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const flow = readFileSync(fileURLToPath(new URL('./flow.tsx', import.meta.url)), 'utf8');
  assert.match(flow, /isAskMethod/);
  assert.match(app, /askFirst/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /回答|isAskMethod|askFirst/);
});
