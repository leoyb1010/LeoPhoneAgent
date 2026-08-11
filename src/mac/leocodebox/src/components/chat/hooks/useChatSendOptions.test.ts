import assert from 'node:assert/strict';
import test from 'node:test';

import { getNotificationSessionSummary } from './useChatSendOptions';

test('notification summaries prefer and normalize the persisted session title', () => {
  assert.equal(
    getNotificationSessionSummary({ id: 'session-1', summary: '  A   useful title  ' } as any, 'fallback'),
    'A useful title',
  );
});

test('notification summaries fall back to the input and cap the visible length', () => {
  const result = getNotificationSessionSummary(null, `  ${'x'.repeat(100)}  `);
  assert.equal(result?.length, 80);
  assert.equal(result?.endsWith('...'), true);
  assert.equal(getNotificationSessionSummary(null, '   '), null);
});
