import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { applyEvent, emptyView, lastLine } from './model';
import { skillNoteLabel, skillNoteTone } from './session-skill-note';

test('技能说的话会出现', () => {
  assert.equal(skillNoteLabel({ text: '这条命令被拦住了' }), '这条命令被拦住了');
  assert.equal(skillNoteLabel({ text: 'nope', level: 'error' }), '技能出错:nope');
  assert.equal(skillNoteTone('warning'), 'error');
  assert.equal(skillNoteTone('info'), 'muted');
  let view = applyEvent(emptyView(), { event: 'session.note', text: '这条命令被拦住了', level: 'warning' });
  assert.equal(view.rows.filter((row) => row.k === 'sys').at(-1)?.text, '这条命令被拦住了');
  assert.equal(view.rows.filter((row) => row.k === 'sys').at(-1)?.tone, 'error');
  view = applyEvent(view, { event: 'session.note', text: 'hook failed', level: 'error' });
  assert.equal(view.rows.filter((row) => row.k === 'sys').at(-1)?.text, '技能出错:hook failed');
  assert.equal(lastLine({
    status: 'running',
    last_event: { event: 'session.note', text: '这条命令被拦住了', timestamp: 1 },
    pending_approvals: [],
  }), '这条命令被拦住了');
});

test('2.0 技能说话不进输入栏、不弹 toast', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const model = readFileSync(fileURLToPath(new URL('./model.ts', import.meta.url)), 'utf8');
  assert.match(model, /session\.note/);
  assert.match(model, /skillNoteLabel/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /技能说|skillNoteLabel|session\.note/);
  assert.doesNotMatch(app, /showSessionNotice\(.*session\.note/);
});
