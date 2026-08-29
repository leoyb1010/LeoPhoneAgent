import assert from 'node:assert/strict';
import test from 'node:test';

import { TOOL_CONFIGS } from './toolConfigs';

function resolveTitle(value: string | ((input: any) => string) | undefined, input: unknown): string | undefined {
  return typeof value === 'function' ? value(input) : value;
}

test('Edit/Write/AskUserQuestion titles survive null or malformed input', () => {
  assert.doesNotThrow(() => resolveTitle(TOOL_CONFIGS.Edit.input.title, null));
  assert.doesNotThrow(() => resolveTitle(TOOL_CONFIGS.Write.input.title, undefined));
  assert.doesNotThrow(() => resolveTitle(TOOL_CONFIGS.ApplyPatch.input.title, 'not-an-object'));
  assert.doesNotThrow(() => resolveTitle(TOOL_CONFIGS.AskUserQuestion.input.title, null));
  assert.doesNotThrow(() => resolveTitle(TOOL_CONFIGS.AskUserQuestion.input.title, { questions: 'oops' }));
  assert.equal(resolveTitle(TOOL_CONFIGS.Edit.input.title, null), 'file');
});
