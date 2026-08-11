import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '../../../stores/useSessionStore';

import { createChatMessageNormalizer } from './useChatMessages';

const message = (id: string, content: string): NormalizedMessage => ({
  id,
  sessionId: 'session-1',
  timestamp: '2026-07-16T00:00:00.000Z',
  provider: 'claude',
  kind: 'text',
  role: 'assistant',
  content,
});

test('cached normalizer preserves unchanged chat message identity', () => {
  const normalize = createChatMessageNormalizer();
  const first = message('a', 'first');
  const streaming = { ...message('stream', 'one'), kind: 'stream_delta' as const };
  const initial = normalize([first, streaming]);
  const updated = normalize([first, { ...streaming, content: 'two' }]);
  assert.equal(updated[0], initial[0]);
  assert.notEqual(updated[1], initial[1]);
  assert.equal(updated[1]?.content, 'two');
});

test('tool rows invalidate when their attached result arrives', () => {
  const normalize = createChatMessageNormalizer();
  const tool: NormalizedMessage = {
    id: 'tool', sessionId: 'session-1', timestamp: '2026-07-16T00:00:00.000Z', provider: 'claude',
    kind: 'tool_use', toolId: 'call-1', toolName: 'Read', toolInput: {},
  };
  const before = normalize([tool]);
  const result: NormalizedMessage = {
    id: 'result', sessionId: 'session-1', timestamp: '2026-07-16T00:00:01.000Z', provider: 'claude',
    kind: 'tool_result', toolId: 'call-1', content: 'ok',
  };
  const after = normalize([tool, result]);
  assert.notEqual(after[0], before[0]);
  assert.equal(after[0]?.toolResult?.content, 'ok');
});
