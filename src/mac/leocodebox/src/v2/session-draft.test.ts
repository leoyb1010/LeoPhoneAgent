import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { DRAFT_KEYS_MAX, clipDraftText, readPersistedDrafts, writePersistedDrafts } from './session-draft';

test('没发出去的话能收成可落盘的草稿', () => {
  assert.equal(clipDraftText('改登录'), '改登录');
  assert.match(clipDraftText('x'.repeat(20_010)), /后面还有/);
  assert.deepEqual(readPersistedDrafts(null), {});
  assert.deepEqual(readPersistedDrafts('nope'), {});
  const raw = writePersistedDrafts({ 'local:hs_1': '改登录', 'fold:hs_2': '   ', 'bad': 'x' });
  assert.deepEqual(readPersistedDrafts(raw), { 'local:hs_1': '改登录' });
  const many: Record<string, string> = {};
  for (let i = 0; i < DRAFT_KEYS_MAX + 5; i += 1) many[`local:hs_${i}`] = `第${i}句`;
  const kept = readPersistedDrafts(writePersistedDrafts(many));
  assert.equal(Object.keys(kept).length, DRAFT_KEYS_MAX);
  assert.equal(kept['local:hs_0'], undefined);
  assert.equal(kept['local:hs_4'], undefined);
  assert.equal(kept[`local:hs_${DRAFT_KEYS_MAX + 4}`], `第${DRAFT_KEYS_MAX + 4}句`);
});

test('2.0 壳接上了草稿落盘，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /readPersistedDrafts/);
  assert.match(app, /writePersistedDrafts/);
  assert.match(app, /DRAFTS_KEY/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /没发出去的话/);
});
