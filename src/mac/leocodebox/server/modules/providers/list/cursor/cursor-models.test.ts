import assert from 'node:assert/strict';
import test from 'node:test';

import { withoutUnsupportedCursorModels } from './cursor-models.provider.js';

const def = (values: string[], DEFAULT: string) => ({
  OPTIONS: values.map((value) => ({ value, label: value, description: value })),
  DEFAULT,
});

test('drops grok-build models (they fail in cursor-agent headless mode) but keeps others', () => {
  const result = withoutUnsupportedCursorModels(
    def(['auto', 'grok-build-0.1', 'claude-4.5-sonnet', 'grok-4.3'], 'auto'),
  );
  const values = result.OPTIONS.map((option) => option.value);
  assert.ok(!values.includes('grok-build-0.1'), 'grok-build must be removed');
  // grok-4.3 is a general model, not the build agent — leave it.
  assert.deepEqual(values, ['auto', 'claude-4.5-sonnet', 'grok-4.3']);
});

test('returns the same object when nothing is filtered', () => {
  const input = def(['auto', 'claude-4.5-sonnet'], 'auto');
  assert.equal(withoutUnsupportedCursorModels(input), input);
});

test('repoints DEFAULT to the first survivor if the default was filtered out', () => {
  const result = withoutUnsupportedCursorModels(def(['grok-build-0.1', 'auto'], 'grok-build-0.1'));
  assert.equal(result.DEFAULT, 'auto');
  assert.deepEqual(result.OPTIONS.map((o) => o.value), ['auto']);
});
