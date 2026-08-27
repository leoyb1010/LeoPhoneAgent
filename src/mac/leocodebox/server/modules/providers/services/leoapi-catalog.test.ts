import assert from 'node:assert/strict';
import test from 'node:test';

import { extrasFromActiveLeoapi, mergeLeoapiOptions } from './leoapi-catalog.js';

const catalog = {
  OPTIONS: [{ value: 'sonnet', label: 'Sonnet' }],
  DEFAULT: 'sonnet',
};

test('extrasFromActiveLeoapi returns the live node model and discovered ids', () => {
  const { extras, label } = extrasFromActiveLeoapi('claude', {
    activeByTarget: { claude: 'p1' },
    providers: [{
      id: 'p1',
      name: 'Kimi',
      model: 'kimi-k2',
      discoveredModels: ['kimi-k2', 'kimi-k2-thinking'],
    }],
  });
  assert.equal(label, 'Kimi');
  assert.deepEqual(extras, ['kimi-k2', 'kimi-k2-thinking']);
});

test('extrasFromActiveLeoapi is empty when the target has no live node', () => {
  assert.deepEqual(
    extrasFromActiveLeoapi('claude', { activeByTarget: {}, providers: [] }).extras,
    [],
  );
});

test('mergeLeoapiOptions prepends unknown ids and skips duplicates', () => {
  const merged = mergeLeoapiOptions(catalog, ['kimi-k2', 'sonnet', 'kimi-k2'], 'Kimi');
  assert.deepEqual(merged.OPTIONS.map((option) => option.value), ['kimi-k2', 'sonnet']);
  assert.equal(merged.OPTIONS[0]?.description, 'Kimi');
  assert.equal(merged.DEFAULT, 'sonnet');
});
