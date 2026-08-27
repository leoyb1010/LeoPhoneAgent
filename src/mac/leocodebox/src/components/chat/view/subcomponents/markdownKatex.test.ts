import assert from 'node:assert/strict';
import test from 'node:test';

import katex from 'katex';

// Mid-task Claude replies often contain `$PATH` / half-closed `$$`. KaTeX
// throws by default; Markdown must pass throwOnError: false so one formula
// cannot blank the session (Reload remounted the same message and died again).
test('invalid TeX throws unless throwOnError is false', () => {
  assert.throws(() => katex.renderToString('\\notamacro', { throwOnError: true }));
  assert.doesNotThrow(() => katex.renderToString('\\notamacro', { throwOnError: false }));
});
