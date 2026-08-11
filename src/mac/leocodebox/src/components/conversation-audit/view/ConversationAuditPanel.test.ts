import assert from 'node:assert/strict';
import test from 'node:test';

import { matchesCategory, messageText } from './auditUtils';

test('audit replay extracts text from string and structured message content', () => {
  assert.equal(messageText({ content: 'hello' }), 'hello');
  assert.equal(messageText({ content: [{ text: 'first' }, { text: 'second' }] }), 'first\nsecond');
});

test('audit replay classifies tool, error, and permission events', () => {
  assert.equal(matchesCategory({ type: 'tool_use', name: 'read_file' }, 'tool'), true);
  assert.equal(matchesCategory({ type: 'error', message: 'failed' }, 'error'), true);
  assert.equal(matchesCategory({ type: 'permission_request', action: 'allow' }, 'permission'), true);
  assert.equal(matchesCategory({ role: 'assistant', content: 'done' }, 'tool'), false);
});

test('audit project loading respects the configured concurrency limit', async () => {
  const { mapWithConcurrency } = await import('./auditUtils');
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12]);
});
