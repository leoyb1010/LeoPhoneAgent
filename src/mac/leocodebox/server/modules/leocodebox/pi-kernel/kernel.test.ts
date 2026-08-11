import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAnthropicCallModel, parseModelResponse } from './kernel-client.js';
import { createKernelTools, createReadOnlyTools } from './kernel-tools.js';
import { runKernelTask, type CallModel, type ModelTurn } from './kernel.js';

test('kernel runs a tool then finishes on end_turn, feeding the result back', async () => {
  const seen: unknown[][] = [];
  const callModel: CallModel = async (messages) => {
    seen.push(messages.map((m) => m.role) as unknown[]);
    if (messages.length === 1) {
      return { blocks: [{ type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'a.txt' } }], stopReason: 'tool_use' };
    }
    return { blocks: [{ type: 'text', text: 'the file says hello' }], stopReason: 'end_turn' };
  };
  const run = await runKernelTask({
    prompt: 'what is in a.txt?',
    tools: [],
    callModel,
    executeTool: async (name, input) => ({ content: `contents of ${input.path}` }),
  });
  assert.equal(run.aborted, false);
  assert.equal(run.steps, 2);
  assert.equal(run.finalText, 'the file says hello');
  const kinds = run.events.map((e) => e.type);
  assert.deepEqual(kinds, ['tool_call', 'tool_result', 'assistant_text', 'done']);
  // On the 2nd model call the history is [user, assistant(tool_use), user(tool_result)].
  assert.deepEqual(seen[1], ['user', 'assistant', 'user']);
});

test('a throwing tool becomes an isError result, and the loop keeps going', async () => {
  let calls = 0;
  const callModel: CallModel = async () => {
    calls += 1;
    if (calls === 1) return { blocks: [{ type: 'tool_use', id: 'x', name: 'boom', input: {} }], stopReason: 'tool_use' };
    return { blocks: [{ type: 'text', text: 'recovered' }], stopReason: 'end_turn' };
  };
  const run = await runKernelTask({
    prompt: 'go',
    tools: [],
    callModel,
    executeTool: async () => { throw new Error('kaboom'); },
  });
  const toolResult = run.events.find((e) => e.type === 'tool_result');
  assert.ok(toolResult && toolResult.type === 'tool_result' && toolResult.isError);
  assert.equal(run.finalText, 'recovered');
  assert.equal(run.aborted, false);
});

test('kernel aborts at the step cap when the model never stops', async () => {
  const callModel: CallModel = async () => ({ blocks: [{ type: 'tool_use', id: 'l', name: 'noop', input: {} }], stopReason: 'tool_use' });
  const run = await runKernelTask({ prompt: 'loop', tools: [], callModel, executeTool: async () => ({ content: 'ok' }), maxSteps: 3 });
  assert.equal(run.aborted, true);
  assert.equal(run.steps, 3);
  assert.equal(run.events.at(-1)?.type, 'aborted');
});

test('read-only tools read inside the root and refuse to escape it', async () => {
  const root = process.cwd(); // repo root during tests
  const { execute } = createReadOnlyTools(root);

  const pkg = await execute('read_file', { path: 'package.json' });
  assert.equal(pkg.isError, undefined);
  assert.match(pkg.content, /"name"/);

  const escape = await execute('read_file', { path: `..${path.sep}..${path.sep}..${path.sep}etc${path.sep}passwd` });
  assert.equal(escape.isError, true);
  assert.match(escape.content, /escapes the task root/);

  const listing = await execute('list_dir', { path: '.' });
  assert.match(listing.content, /package\.json/);

  const unknown = await execute('mystery', {});
  assert.equal(unknown.isError, true);
});

test('write/exec tools are gated: absent from specs and refused unless opted in', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kernel-'));
  try {
    const readonly = createKernelTools(root, {});
    assert.deepEqual(readonly.specs.map((s) => s.name), ['read_file', 'list_dir']);
    // Even if the model somehow calls them, the executor refuses when not granted.
    assert.equal((await readonly.execute('write_file', { path: 'x.txt', content: 'hi' })).isError, true);
    assert.equal((await readonly.execute('run_shell', { command: 'echo hi' })).isError, true);

    const full = createKernelTools(root, { allowWrite: true, allowExec: true });
    assert.deepEqual(full.specs.map((s) => s.name), ['read_file', 'list_dir', 'write_file', 'run_shell']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('write_file writes inside the root, refuses to escape it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kernel-'));
  try {
    const { execute } = createKernelTools(root, { allowWrite: true });
    const ok = await execute('write_file', { path: 'sub/note.txt', content: 'hello kernel' });
    assert.equal(ok.isError, undefined);
    assert.equal(readFileSync(path.join(root, 'sub/note.txt'), 'utf8'), 'hello kernel');

    const escape = await execute('write_file', { path: '../escape.txt', content: 'nope' });
    assert.equal(escape.isError, true);
    assert.match(escape.content, /escapes the task root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('write_file cannot escape through a symlink to a not-yet-existing path', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kernel-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'outside-'));
  try {
    // The classic shape: a symlinked directory inside the root (node_modules
    // links, workspace links, or the user's own). The target does not exist
    // yet, which is exactly when realpath used to fail open.
    symlinkSync(outside, path.join(root, 'link'));
    const { execute } = createKernelTools(root, { allowWrite: true });

    const escaped = await execute('write_file', { path: 'link/pwned.txt', content: 'nope' });
    assert.equal(escaped.isError, true);
    assert.equal(existsSync(path.join(outside, 'pwned.txt')), false);

    // Creating a whole new tree behind the link must fail too.
    const deep = await execute('write_file', { path: 'link/newdir/deep.txt', content: 'nope' });
    assert.equal(deep.isError, true);
    assert.equal(existsSync(path.join(outside, 'newdir')), false);

    // Reading through the link stays blocked as well.
    const read = await execute('read_file', { path: 'link/anything.txt' });
    assert.equal(read.isError, true);

    // A normal nested write inside the root still works.
    const ok = await execute('write_file', { path: 'sub/dir/ok.txt', content: 'yes' });
    assert.equal(ok.isError, undefined);
    assert.equal(readFileSync(path.join(root, 'sub/dir/ok.txt'), 'utf8'), 'yes');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('run_shell executes in the root and blocks destructive patterns', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kernel-'));
  try {
    const { execute } = createKernelTools(root, { allowExec: true });
    const echo = await execute('run_shell', { command: 'echo hi-from-kernel' });
    assert.equal(echo.isError, false);
    assert.match(echo.content, /hi-from-kernel/);

    const danger = await execute('run_shell', { command: 'rm -rf /tmp/whatever' });
    assert.equal(danger.isError, true);
    assert.match(danger.content, /blocked destructive pattern/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('run_shell returns promptly even when the command backgrounds a child', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kernel-'));
  try {
    const { execute } = createKernelTools(root, { allowExec: true });
    const started = Date.now();
    // The backgrounded `sleep` keeps the stdio pipes open, so 'close' never
    // fires and this used to hang the request for the orphan's full lifetime.
    const result = await execute('run_shell', { command: 'sleep 20 & echo started' });
    const elapsed = Date.now() - started;
    assert.match(result.content, /started/);
    assert.ok(elapsed < 5000, `run_shell should not wait for the orphan (took ${elapsed}ms)`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseModelResponse maps text + tool_use blocks and stop_reason', () => {
  const turn: ModelTurn = parseModelResponse({
    stop_reason: 'tool_use',
    content: [
      { type: 'text', text: 'let me look' },
      { type: 'tool_use', id: 'tu9', name: 'list_dir', input: { path: '.' } },
      { type: 'thinking', thinking: 'ignored' },
    ],
  });
  assert.equal(turn.stopReason, 'tool_use');
  assert.equal(turn.blocks.length, 2);
  assert.deepEqual(turn.blocks[0], { type: 'text', text: 'let me look' });
  assert.deepEqual(turn.blocks[1], { type: 'tool_use', id: 'tu9', name: 'list_dir', input: { path: '.' } });
});

test('createAnthropicCallModel posts to /v1/messages and parses the reply', async () => {
  const original = globalThis.fetch;
  let capturedUrl = '';
  let capturedBody: Record<string, unknown> = {};
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    capturedUrl = url;
    capturedBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] }) };
  }) as unknown as typeof fetch;
  try {
    const call = createAnthropicCallModel({ baseUrl: 'https://x.example/v1', apiKey: 'k', model: 'claude-sonnet-4-5', system: 'sys', tools: [] });
    const turn = await call([{ role: 'user', content: 'hello' }]);
    assert.equal(capturedUrl, 'https://x.example/v1/messages'); // baseUrl already ends in /v1
    assert.equal(capturedBody.model, 'claude-sonnet-4-5');
    assert.equal(capturedBody.system, 'sys');
    assert.deepEqual(turn.blocks, [{ type: 'text', text: 'hi' }]);
  } finally {
    globalThis.fetch = original;
  }
});
