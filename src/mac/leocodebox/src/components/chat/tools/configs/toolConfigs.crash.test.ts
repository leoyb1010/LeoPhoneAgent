import assert from 'node:assert/strict';
import test from 'node:test';

import { TOOL_CONFIGS } from './toolConfigs';

test('Edit/Write/AskUserQuestion titles survive null or malformed input', () => {
  assert.doesNotThrow(() => TOOL_CONFIGS.Edit.input.title?.(null));
  assert.doesNotThrow(() => TOOL_CONFIGS.Write.input.title?.(undefined));
  assert.doesNotThrow(() => TOOL_CONFIGS.ApplyPatch.input.title?.('not-an-object'));
  assert.doesNotThrow(() => TOOL_CONFIGS.AskUserQuestion.input.title?.(null));
  assert.doesNotThrow(() => TOOL_CONFIGS.AskUserQuestion.input.title?.({ questions: 'oops' }));
  assert.equal(TOOL_CONFIGS.Edit.input.title?.(null), 'file');
});
