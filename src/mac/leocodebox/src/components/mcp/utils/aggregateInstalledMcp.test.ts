import assert from 'node:assert/strict';
import test from 'node:test';

import type { McpProvider, ProviderMcpServer } from '../types';

import { aggregateInstalledMcp } from './mcpFormatting';

const server = (provider: McpProvider, name: string, transport: ProviderMcpServer['transport'] = 'stdio'): ProviderMcpServer => ({
  provider,
  name,
  scope: 'user',
  transport,
});

test('same server name across CLIs collapses to one row listing every provider', () => {
  const rows = aggregateInstalledMcp({
    claude: [server('claude', 'context7')],
    codex: [server('codex', 'context7')],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'context7');
  assert.deepEqual([...rows[0].providers].sort(), ['claude', 'codex']);
  // Carries each CLI's full config so a chip can replicate/remove it.
  assert.equal(rows[0].configs.claude?.provider, 'claude');
  assert.equal(rows[0].configs.codex?.provider, 'codex');
});

test('different server names stay as separate rows, sorted by name', () => {
  const rows = aggregateInstalledMcp({
    claude: [server('claude', 'zeta'), server('claude', 'alpha')],
  });
  assert.deepEqual(rows.map((row) => row.name), ['alpha', 'zeta']);
});

test('differing transports across CLIs are collected, not overwritten', () => {
  const rows = aggregateInstalledMcp({
    claude: [server('claude', 'shared', 'stdio')],
    codex: [server('codex', 'shared', 'http')],
  });
  assert.equal(rows.length, 1);
  assert.deepEqual([...rows[0].transports].sort(), ['http', 'stdio']);
});

test('cloudcli- prefixed servers are flagged as managed', () => {
  const rows = aggregateInstalledMcp({ claude: [server('claude', 'cloudcli-browser')] });
  assert.equal(rows[0].managed, true);
  const plain = aggregateInstalledMcp({ claude: [server('claude', 'browser')] });
  assert.equal(plain[0].managed, false);
});

test('a missing/failed provider (undefined) contributes nothing but others still aggregate', () => {
  const rows = aggregateInstalledMcp({
    claude: [server('claude', 'context7')],
    codex: undefined,
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].providers, ['claude']);
});

test('blank server names are ignored', () => {
  const rows = aggregateInstalledMcp({ claude: [server('claude', '  ')] });
  assert.equal(rows.length, 0);
});
