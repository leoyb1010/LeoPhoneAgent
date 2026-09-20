import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { sessionAssistantBlocks, sessionAssistantNeedsText } from './session-assistant-text';

test('没流出来的字也会出现', () => {
  assert.deepEqual(sessionAssistantBlocks({
    role: 'assistant',
    content: [{ type: 'text', text: '先改登录' }, { type: 'thinking', thinking: '要想一下' }],
  }), { text: '先改登录', thinking: '要想一下' });
  assert.equal(sessionAssistantNeedsText({ streamed: false, role: 'assistant', text: '先改登录' }), true);
  assert.equal(sessionAssistantNeedsText({ streamed: true, role: 'assistant', text: '先改登录' }), false);
  assert.equal(sessionAssistantNeedsText({ streamed: false, role: 'user', text: '你好' }), false);
  assert.equal(sessionAssistantNeedsText({ streamed: false, role: 'assistant', text: '' }), false);
});

test('2.0 成文不进输入栏按钮', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const dialect = readFileSync(fileURLToPath(new URL('../../server/modules/leophone/harness-dialects.ts', import.meta.url)), 'utf8');
  assert.match(dialect, /sessionAssistantNeedsText/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /流出来|sessionAssistant|成文/);
});
