import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  getClaudeConfigDir,
  getCodexHome,
  getGeminiHome,
  getHermesHome,
  getOpenCodeConfigDir,
  getOpenCodeDataDir,
} from '../provider-runtime-paths.js';
import { findFilesRecursivelyCreatedAfter } from '../utils.js';

test('provider runtime paths use defaults below the current home', () => {
  const home = '/Users/tester';
  assert.equal(getClaudeConfigDir({}, home), '/Users/tester/.claude');
  assert.equal(getCodexHome({}, home), '/Users/tester/.codex');
  assert.equal(getOpenCodeDataDir({}, home), '/Users/tester/.local/share/opencode');
  assert.equal(getOpenCodeConfigDir({}, home), '/Users/tester/.config/opencode');
});

test('provider runtime paths honor custom CLI and XDG directories', () => {
  const home = '/Users/tester';
  assert.equal(getClaudeConfigDir({ CLAUDE_CONFIG_DIR: '~/agent-state/claude' }, home), '/Users/tester/agent-state/claude');
  assert.equal(getCodexHome({ CODEX_HOME: '/Volumes/agents/codex' }, home), '/Volumes/agents/codex');
  assert.equal(getOpenCodeDataDir({ XDG_DATA_HOME: '/Volumes/agents/data' }, home), '/Volumes/agents/data/opencode');
  assert.equal(getOpenCodeDataDir({ OPENCODE_DATA_DIR: 'agent-state/opencode' }, home), '/Users/tester/agent-state/opencode');
  assert.equal(getOpenCodeConfigDir({ XDG_CONFIG_HOME: '~/xdg-config' }, home), '/Users/tester/xdg-config/opencode');
  assert.equal(getOpenCodeConfigDir({ OPENCODE_CONFIG_DIR: 'agent-state/opencode-config' }, home), '/Users/tester/agent-state/opencode-config');
  assert.equal(getGeminiHome({ GEMINI_CLI_HOME: '~/gemini-profile' }, home), '/Users/tester/gemini-profile');
  assert.equal(getHermesHome({ HERMES_HOME: '/Volumes/agents/hermes' }, home), '/Volumes/agents/hermes');
});

test('incremental transcript discovery uses modification time, not only creation time', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'leocodebox-session-scan-'));
  try {
    const transcript = path.join(root, 'session.jsonl');
    await writeFile(transcript, '{}\n');
    const oldTime = new Date('2026-01-01T00:00:00.000Z');
    const updatedTime = new Date('2026-01-02T00:00:00.000Z');
    await utimes(transcript, oldTime, updatedTime);

    const files = await findFilesRecursivelyCreatedAfter(
      root,
      '.jsonl',
      new Date('2026-01-01T12:00:00.000Z'),
    );
    assert.deepEqual(files, [transcript]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
