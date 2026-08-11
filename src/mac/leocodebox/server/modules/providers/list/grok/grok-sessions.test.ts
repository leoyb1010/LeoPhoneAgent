import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveGrokPermissionMode } from './grok-runtime.js';
import { GrokSessionsProvider, grokSessionDir } from './grok-sessions.provider.js';

const sessions = new GrokSessionsProvider();

test('grokSessionDir encodes the realpath so symlinked project paths still resolve', () => {
  // grok stores transcripts under the realpath of cwd. If a project path has a
  // symlinked component, encoding the RAW path would look in a dir that never
  // exists. Verified live against grok 0.2.x on macOS (/var → /private/var).
  const base = mkdtempSync(path.join(os.tmpdir(), 'grok-dir-'));
  const realTarget = path.join(base, 'real-project');
  mkdirSync(realTarget);
  const linkPath = path.join(base, 'link-project');
  symlinkSync(realTarget, linkPath);

  try {
    const viaLink = grokSessionDir(linkPath, 'sid-1');
    const viaReal = grokSessionDir(realTarget, 'sid-1');
    // Both the symlinked and the real path must resolve to the SAME encoded dir.
    assert.equal(viaLink, viaReal);
    // And that dir must be keyed on the realpath, not the symlink.
    const expected = path.join(
      os.homedir(), '.grok', 'sessions', encodeURIComponent(realpathSync(realTarget)), 'sid-1',
    );
    assert.equal(viaLink, expected);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('grokSessionDir falls back to the raw path when it cannot be resolved', () => {
  // A removed/never-created path can't be realpath'd — encode it verbatim rather
  // than throwing, so a stale history lookup simply returns nothing.
  const missing = path.join(os.tmpdir(), 'grok-does-not-exist-xyz', 'proj');
  const dir = grokSessionDir(missing, 'sid-2');
  assert.equal(
    dir,
    path.join(os.homedir(), '.grok', 'sessions', encodeURIComponent(missing), 'sid-2'),
  );
});

test('live normalizeMessage maps grok stream events to normalized kinds', () => {
  assert.deepEqual(
    sessions.normalizeMessage({ type: 'thought', data: 'thinking…' }, 'sid').map((m) => ({ kind: m.kind, content: m.content })),
    [{ kind: 'thinking', content: 'thinking…' }],
  );
  assert.deepEqual(
    sessions.normalizeMessage({ type: 'text', data: 'hello' }, 'sid').map((m) => ({ kind: m.kind, content: m.content })),
    [{ kind: 'stream_delta', content: 'hello' }],
  );
  // The terminal `end` event is consumed by the runtime, not the adapter.
  assert.deepEqual(sessions.normalizeMessage({ type: 'end', sessionId: 'x' }, 'sid'), []);
  // Empty deltas and unknown types produce nothing.
  assert.deepEqual(sessions.normalizeMessage({ type: 'text', data: '' }, 'sid'), []);
  assert.deepEqual(sessions.normalizeMessage({ type: 'other' }, 'sid'), []);
});

test('normalizeTranscript parses on-disk chat_history and pairs tools to calls', () => {
  const rows = [
    JSON.stringify({ type: 'system', content: 'system prompt' }),
    JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_info>\nOS: macos' }] }),
    JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'read f.txt' }], prompt_index: 0 }),
    JSON.stringify({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'I should read the file' }] }),
    JSON.stringify({
      type: 'assistant',
      content: '',
      tool_calls: [{ id: 'call-1', name: 'read_file', arguments: '{"target_file":"f.txt"}' }],
      model_id: 'grok-4.5',
    }),
    JSON.stringify({ type: 'tool_result', tool_call_id: 'call-1', content: 'alpha\nbeta\n' }),
    JSON.stringify({ type: 'assistant', content: '2 lines.', model_id: 'grok-4.5' }),
  ];
  const messages = sessions.normalizeTranscript(rows, 'sid');
  const kinds = messages.map((m) => m.kind);

  // system dropped; the <user_info> internal user turn dropped; real user kept.
  assert.deepEqual(kinds, ['text', 'thinking', 'tool_use', 'tool_result', 'text']);

  const userMsg = messages[0];
  assert.equal(userMsg.role, 'user');
  assert.equal(userMsg.content, 'read f.txt');

  const toolUse = messages.find((m) => m.kind === 'tool_use');
  assert.equal(toolUse?.toolName, 'read_file');
  assert.deepEqual(toolUse?.toolInput, { target_file: 'f.txt' });
  assert.equal(toolUse?.toolId, 'call-1');
  // The result is stapled onto its call for combined rendering.
  assert.equal(toolUse?.toolResult?.content, 'alpha\nbeta\n');

  const assistant = messages[messages.length - 1];
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.content, '2 lines.');
});

test('normalizeTranscript skips synthetic (injected-context) user turns', () => {
  const rows = [
    JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'injected reminder' }], synthetic_reason: 'context' }),
    JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'real question' }], prompt_index: 0 }),
  ];
  const messages = sessions.normalizeTranscript(rows, 'sid');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, 'real question');
});

test('resolveGrokPermissionMode maps app modes to grok --permission-mode values', () => {
  assert.equal(resolveGrokPermissionMode('plan'), 'plan');
  assert.equal(resolveGrokPermissionMode('acceptEdits'), 'acceptEdits');
  assert.equal(resolveGrokPermissionMode('bypassPermissions'), 'bypassPermissions');
  assert.equal(resolveGrokPermissionMode(undefined), 'default');
  assert.equal(resolveGrokPermissionMode('somethingElse'), 'default');
  // skipPermissions is promoted to bypass regardless of the requested mode.
  assert.equal(resolveGrokPermissionMode('default', true), 'bypassPermissions');
});
