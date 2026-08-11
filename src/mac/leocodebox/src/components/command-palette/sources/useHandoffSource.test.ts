import assert from 'node:assert/strict';
import test from 'node:test';

import { buildHandoffText, HANDOFF_TARGET_PROVIDERS } from './useHandoffSource';

test('cross-provider handoff builds a compact editable summary', () => {
  const text = buildHandoffText('claude', [
    { role: 'user', content: 'Implement the export endpoint.' },
    { role: 'assistant', content: 'Added Markdown and JSON export with tests.' },
  ]);
  assert.match(text, /Cross-provider handoff from claude/);
  assert.match(text, /Request: Implement the export endpoint/);
  assert.match(text, /Outcome: Added Markdown and JSON export/);
  assert.match(text, /Next instruction:/);
});

test('handoff targets include every supported chat provider', () => {
  assert.deepEqual(HANDOFF_TARGET_PROVIDERS, ['claude', 'codex', 'cursor', 'opencode', 'grok']);
});
