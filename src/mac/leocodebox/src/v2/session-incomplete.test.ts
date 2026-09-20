import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { sessionIncompleteLabel, sessionIncompleteReason } from './session-incomplete';

test('没说完会停住', () => {
  assert.equal(sessionIncompleteReason('max_tokens'), true);
  assert.equal(sessionIncompleteReason('length'), true);
  assert.equal(sessionIncompleteReason('MAX_TOKENS'), true);
  assert.equal(sessionIncompleteReason('stop'), false);
  assert.equal(sessionIncompleteReason('error'), false);
  assert.equal(sessionIncompleteReason('tool_use'), false);
  assert.equal(sessionIncompleteLabel('max_tokens'), '模型没说完');
  assert.equal(sessionIncompleteLabel('stop'), '');
});

test('2.0 截断不停在输入栏按钮', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const dialect = readFileSync(fileURLToPath(new URL('../../server/modules/leophone/harness-dialects.ts', import.meta.url)), 'utf8');
  assert.match(dialect, /sessionIncompleteLabel/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /没说完|sessionIncompleteLabel/);
});
