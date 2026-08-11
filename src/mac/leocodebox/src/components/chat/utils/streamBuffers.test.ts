import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getOrCreateStreamBuffer,
  resolveStreamProvider,
  type StreamBufferEntry,
} from './streamBuffers';

test('stream buffers remain isolated by session id', () => {
  const buffers = new Map<string, StreamBufferEntry>();
  const claude = getOrCreateStreamBuffer(buffers, 'session-claude', 'claude');
  const codex = getOrCreateStreamBuffer(buffers, 'session-codex', 'codex');

  claude.buffer += 'Claude output';
  codex.buffer += 'Codex output';

  assert.equal(buffers.get('session-claude')?.buffer, 'Claude output');
  assert.equal(buffers.get('session-codex')?.buffer, 'Codex output');
  assert.notEqual(claude, codex);
});

test('stream provider comes from the event and falls back only when invalid', () => {
  assert.equal(resolveStreamProvider('codex', 'claude'), 'codex');
  assert.equal(resolveStreamProvider('opencode', 'claude'), 'opencode');
  assert.equal(resolveStreamProvider('unknown-provider', 'claude'), 'claude');
});
