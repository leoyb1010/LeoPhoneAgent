import assert from 'node:assert/strict';
import test from 'node:test';

import { asDisplayText } from './chatFormatting';

test('asDisplayText keeps strings and never returns a non-string', () => {
  assert.equal(asDisplayText('hello'), 'hello');
  assert.equal(asDisplayText(null), '');
  assert.equal(asDisplayText(undefined), '');
  assert.equal(asDisplayText({ question: 'pick?' }).includes('pick?'), true);
});

test('asDisplayText lets interactive prompts split without throwing', () => {
  assert.doesNotThrow(() => asDisplayText({ questions: [{ question: '?' }] }).split('\n'));
});
