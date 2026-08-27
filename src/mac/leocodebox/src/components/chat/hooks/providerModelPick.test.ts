import assert from 'node:assert/strict';
import test from 'node:test';

import { pickStoredOrCurrent } from './providerModelPick';

const catalog = {
  OPTIONS: [{ value: 'sonnet' }, { value: 'opus' }],
  DEFAULT: 'sonnet',
};

test('keeps a stored API-key model that is not in the CLI catalog', () => {
  assert.equal(
    pickStoredOrCurrent('deepseek-chat', 'sonnet', catalog),
    'deepseek-chat',
  );
});

test('keeps a stored official model', () => {
  assert.equal(pickStoredOrCurrent('opus', 'sonnet', catalog), 'opus');
});

test('falls back to DEFAULT only when nothing is remembered', () => {
  assert.equal(pickStoredOrCurrent(null, '', catalog), 'sonnet');
  assert.equal(pickStoredOrCurrent('   ', '', catalog), 'sonnet');
});
