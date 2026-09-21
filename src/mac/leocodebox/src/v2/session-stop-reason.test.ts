import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { sessionAbortedStop, sessionAbortedStopLabel } from './session-stop-reason';

test('中途停了会标停', () => {
  assert.equal(sessionAbortedStop('aborted'), true);
  assert.equal(sessionAbortedStop('stop'), false);
  assert.equal(sessionAbortedStop('length'), false);
  assert.equal(sessionAbortedStopLabel('aborted'), '中途停了');
  assert.equal(sessionAbortedStopLabel('error'), '');
});

test('2.0 中途停不进输入栏按钮', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const dialect = readFileSync(fileURLToPath(new URL('../../server/modules/leophone/harness-dialects.ts', import.meta.url)), 'utf8');
  assert.match(dialect, /sessionAbortedStopLabel/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /中途停|sessionAbortedStop|stopReason/);
});
