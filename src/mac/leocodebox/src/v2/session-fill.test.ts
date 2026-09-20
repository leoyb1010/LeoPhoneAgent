import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { applyEvent, emptyView } from './model';
import { canFillComposerDraft, composerFillFromSkill, sessionFillLabel } from './session-fill';

test('技能会把字填进输入栏', () => {
  assert.equal(composerFillFromSkill('  接着跑测试  '), '  接着跑测试  ');
  assert.equal(sessionFillLabel(), '技能写进了输入栏。');
  assert.equal(canFillComposerDraft({ machine: 'local', fillId: 1 }), true);
  assert.equal(canFillComposerDraft({ machine: 'phone', fillId: 1 }), false);
  assert.equal(canFillComposerDraft({ machine: 'local', fillId: 0 }), false);
  let view = applyEvent(emptyView(), { event: 'session.draft_fill', text: '接着跑测试' });
  assert.equal(view.composerFill, '接着跑测试');
  assert.equal(view.fillId, 1);
  assert.equal(view.rows.filter((row) => row.k === 'sys').at(-1)?.text, '技能写进了输入栏。');
  view = applyEvent(view, { event: 'session.draft_fill', text: '换一句' });
  assert.equal(view.fillId, 2);
  assert.equal(view.composerFill, '换一句');
});

test('2.0 填字不进输入栏按钮', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /canFillComposerDraft/);
  assert.match(app, /composerFillFromSkill/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /填进|sessionFillLabel|composerFillFromSkill/);
});
